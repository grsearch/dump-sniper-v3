'use strict';

const crypto = require('crypto');
const { config, validateConfig } = require('./config');
const TokenRegistry = require('./data/TokenRegistry');
const TradeLogger = require('./data/TradeLogger');
const TickStream = require('./core/TickStream');
const DumpDetector = require('./core/DumpDetector');
const PriceTracker = require('./core/PriceTracker');
const SignalEngine = require('./core/SignalEngine');
const Executor = require('./core/Executor');
const PositionManager = require('./core/PositionManager');
const DailyReport = require('./reports/DailyReport');
const Server = require('./server/server');
const PoolFinder = require('./utils/poolFinder');
const { getMonitor } = require('./monitor/HealthMonitor');
const AlertChecker = require('./monitor/AlertChecker');

const monitor = getMonitor();

async function main() {
  console.log('================================================');
  console.log('🎯 Dump Sniper V2 starting...');
  console.log(`Mode: ${config.DRY_RUN ? 'DRY_RUN' : '⚠️  LIVE TRADING ⚠️'}`);
  console.log(`Position: ${config.strategy.positionSizeSol} SOL`);
  console.log(`TP: +${config.strategy.takeProfitPct}% (need ${config.strategy.tpConfirmCount}x confirm)`);
  console.log(`Emergency stop: ${config.strategy.emergencyStopLossPct}%`);
  console.log(`Max hold: ${config.strategy.maxHoldMs}ms`);
  console.log(`Executor: Pump AMM SDK direct (no Jupiter)`);
  console.log(`Compute units: ${process.env.COMPUTE_UNIT_LIMIT || 150000}, max priority fee: ${config.maxPriorityFeeLamports} lamports`);
  console.log('================================================');

  const errors = validateConfig();
  if (errors.length) {
    console.error('Config errors:');
    errors.forEach((e) => console.error('  - ' + e));
    if (errors.some((e) => e.includes('LaserStream') || e.includes('HELIUS_API_KEY'))) {
      console.error('Critical config missing. Exiting.');
      process.exit(1);
    }
  }

  // ============ 数据层 ============
  const tokenRegistry = new TokenRegistry();
  const tradeLogger = new TradeLogger(tokenRegistry.db);

  // ============ 核心引擎 ============
  const priceTracker = new PriceTracker();
  const dumpDetector = new DumpDetector(tokenRegistry);
  const executor = new Executor();

  // v3.5: PoolStateCache - 后台预热所有监控代币的 Pump pool state
  // BUY 路径不再阻塞 swapSolanaState（80-150ms RPC），从内存读 0ms
  if (!config.DRY_RUN && executor.onlineSdk && executor.keypair) {
    const PoolStateCache = require('./core/PoolStateCache');
    const poolStateCache = new PoolStateCache({
      onlineSdk: executor.onlineSdk,
      user: executor.keypair.publicKey,
      getMintList: () => {
        return tokenRegistry.listActive()
          .filter((t) => t.pool_address)
          .map((t) => ({ mint: t.mint, poolAddress: t.pool_address }));
      },
    });
    executor.setPoolStateCache(poolStateCache);
    poolStateCache.start();
  }

  const positionManager = new PositionManager({
    tradeLogger,
    executor,
    priceTracker,
    tokenRegistry,
  });
  const signalEngine = new SignalEngine({ tradeLogger, positionManager });
  const tickStream = new TickStream();

  // ============ 报告 ============
  const dailyReport = new DailyReport({ tradeLogger, tokenRegistry });
  dailyReport.start();

  // ============ 服务器 ============
  const server = new Server({
    tokenRegistry,
    tradeLogger,
    positionManager,
    signalEngine,
    dailyReport,
    onTokenListChanged: () => {
      const mints = tokenRegistry.listActive().map((t) => t.mint);
      tickStream.updateSubscription(mints);
    },
    onTokenAdded: async (token) => {
      // 新增代币 → 后台异步补 pool 信息
      if (config.autoFillPoolsOnStart) {
        fillPoolForToken(tokenRegistry, token.mint).catch(() => {});
      }
    },
  });

  // ============ 启动恢复未平仓持仓 ============
  const restored = positionManager.restoreFromDb();
  if (restored.length > 0) {
    console.log(`[main] restored ${restored.length} open position(s) from db`);
    monitor.inc('main.restoredPositions', restored.length, 'main');
  }

  // ============ 健康监控 / 告警 ============
  const alertChecker = new AlertChecker({
    monitor,
    tickStream,
    executor,
    positionManager,
    tokenRegistry,
    config,
  });
  alertChecker.start();

  monitor.on('alert', (alert) => {
    console.error(`[ALERT] [${alert.severity.toUpperCase()}] ${alert.name}: ${alert.message}`);
    server.broadcast({ type: 'alert', alert });
  });
  monitor.on('alertCleared', (alert) => {
    console.log(`[ALERT] cleared: ${alert.name}`);
    server.broadcast({ type: 'alertCleared', alert });
  });

  // ============ 事件连线 ============

  tickStream.on('transaction', (tx) => dumpDetector.handleTransaction(tx));

  dumpDetector.on('priceTick', ({ mint, price, ts, poolAddress }) => {
    priceTracker.update(mint, price, ts, poolAddress);
  });

  // sellAnalyzed: 只记录"接近触发"的（半阈值），避免写入风暴
  dumpDetector.on('sellAnalyzed', (info) => {
    if (info.passSize && info.passImpact) return; // 已 dumpSignal
    const halfSize = config.strategy.minSellSol * 0.5;
    const halfImpact = config.strategy.minPriceImpactPct * 0.5;
    if (info.sellSol < halfSize || info.priceImpactPct < halfImpact) return;
    tradeLogger.logSignal({
      ts: info.ts,
      mint: info.mint,
      symbol: info.symbol,
      kind: 'DUMP_DETECTED',
      sellSol: info.sellSol,
      priceImpactPct: info.priceImpactPct,
      seller: info.seller,
      sellerTx: info.signature,
      notes: `near-miss: passSize=${info.passSize}, passImpact=${info.passImpact}`,
      accepted: false,
      rejectReason: 'thresholds not met',
    });
  });

  dumpDetector.on('dumpSignal', (signal) => signalEngine.handleDumpSignal(signal));

  // ============ buyOrder → BUY → register position ============
  signalEngine.on('buyOrder', async (order) => {
    const tokenInfo = tokenRegistry.getToken(order.mint);

    // 用同一个 positionId 贯穿 BUY trade / position 表
    const positionId = crypto.randomUUID();

    // 标记此 mint 正在 buy 中，让后续并发 dumpSignal 看到这个槽位被占
    signalEngine.markBuyInflight(order.mint);

    let buyResult;
    try {
      buyResult = await executor.buy({
        mint: order.mint,
        symbol: order.symbol,
        sizeSol: order.sizeSol,
        priceAfter: order.priceAfter, // 用于 DRY_RUN 模拟
        baseDecimals: order.baseDecimals ?? tokenInfo?.decimals ?? 6,
        poolAddress: tokenInfo?.pool_address, // Pump SDK 需要 pool address
      });
    } finally {
      signalEngine.markBuyDone(order.mint);
    }

    // 记录 BUY trade（用同一 positionId）
    tradeLogger.logTrade({
      positionId,
      ts: Date.now(),
      mint: order.mint,
      symbol: order.symbol,
      side: 'BUY',
      solAmount: buyResult.solIn ?? order.sizeSol,
      tokenAmount: buyResult.tokenAmount,
      price: buyResult.price,
      signature: buyResult.signature,
      success: buyResult.success,
      dryRun: config.DRY_RUN,
      reason: order.reason,
      latencyMs: buyResult.latencyMs,
      error: buyResult.error,
    });

    if (!buyResult.success) {
      console.error(
        `[main] BUY failed for ${order.symbol || order.mint.slice(0, 6)}: ${buyResult.error}`,
      );
      return;
    }

    // 用真实成交价初始化 entry_price（关键修复 v1 bug：之前用 trigger 价）
    positionManager.registerOpen({
      positionId,
      mint: order.mint,
      symbol: order.symbol,
      entrySol: buyResult.solIn ?? order.sizeSol,
      entryPrice: buyResult.price,         // 真实成交价
      tokenAmount: buyResult.tokenAmount,  // 真实买到的数量
      dryRun: config.DRY_RUN,
      signature: buyResult.signature,
      buyFeeLamports: buyResult.priorityFeeLamports || 0,  // v3.4: 用于真实 PnL
    });

    // 立即同步 PriceTracker，用真实成交价做 entry baseline
    // （避免下一笔 LaserStream tx 推一个旧价格触发假 TP）
    priceTracker.forceSet(order.mint, buyResult.price);

    if (buyResult.signature) signalEngine.registerOurSignature(buyResult.signature);
  });

  positionManager.on('opened', (pos) =>
    server.broadcast({ type: 'positionOpened', position: pos }),
  );
  positionManager.on('closed', (pos) =>
    server.broadcast({ type: 'positionClosed', position: pos }),
  );

  // ============ 启动服务器 ============
  server.start();

  // ============ 启动前补充 pool 信息（异步后台） ============
  if (config.autoFillPoolsOnStart) {
    backgroundFillPools(tokenRegistry).catch((err) =>
      console.error(`[main] backgroundFillPools error: ${err.message}`),
    );
  }

  // ============ 启动数据流 ============
  const initialMints = tokenRegistry.listActive().map((t) => t.mint);
  console.log(`[main] starting LaserStream with ${initialMints.length} initial tokens`);
  await tickStream.start(initialMints);

  // ============ 优雅退出 ============
  const shutdown = async (signal) => {
    console.log(`\n[main] ${signal} received, shutting down gracefully...`);
    try {
      await tickStream.stop();
      positionManager.stop();
      alertChecker.stop();
      monitor.stop();
      executor.stop && executor.stop();
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[main] shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    monitor.recordError('main', err, { phase: 'uncaughtException' });
    monitor.inc('main.uncaughtExceptions', 1, 'main');
    console.error('[main] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    monitor.recordError('main', reason instanceof Error ? reason : new Error(String(reason)), {
      phase: 'unhandledRejection',
    });
    monitor.inc('main.unhandledRejections', 1, 'main');
    console.error('[main] unhandledRejection:', reason);
  });

  console.log('[main] startup complete');
}

/**
 * 后台扫描所有缺失 pool 信息的代币，逐个补上。
 * 节流：每个 250ms。
 */
async function backgroundFillPools(tokenRegistry) {
  const targets = tokenRegistry
    .listAll()
    .filter((t) => t.is_active && (!t.pool_address || !t.pool_base_vault || !t.pool_quote_vault));

  if (targets.length === 0) return;
  console.log(`[main] auto-fill pool for ${targets.length} tokens (background)`);

  const finder = new PoolFinder({});
  let ok = 0;
  let fail = 0;

  for (const t of targets) {
    try {
      const result = await finder.findPoolForMint(t.mint);
      if (result) {
        tokenRegistry.setPoolInfo(t.mint, result);
        ok += 1;
      } else {
        fail += 1;
      }
    } catch (err) {
      fail += 1;
      console.warn(`[fill-pools] ${t.symbol || t.mint.slice(0, 6)}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`[main] auto-fill pool done: ${ok} OK, ${fail} failed`);
}

async function fillPoolForToken(tokenRegistry, mint) {
  try {
    const finder = new PoolFinder({});
    const result = await finder.findPoolForMint(mint);
    if (result) {
      tokenRegistry.setPoolInfo(mint, result);
      console.log(
        `[fill-pools] ${mint.slice(0, 6)}: pool=${result.poolAddress.slice(0, 6)}..`,
      );
    }
  } catch (err) {
    console.warn(`[fill-pools] ${mint.slice(0, 6)}: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('[main] fatal error:', err);
  process.exit(1);
});
