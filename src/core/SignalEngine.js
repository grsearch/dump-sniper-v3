'use strict';

const EventEmitter = require('events');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
// SignalEngine 只在收到 dump 信号时 beat，没信号时不会心跳。砸盘信号本来就稀疏，
// 阈值 600s（10min）会经常误报。改 1h；如果 1h 没有任何砸盘信号才算异常。
monitor.registerModule('SignalEngine', { staleMs: 3600_000, label: 'Signal Engine' });

/**
 * SignalEngine
 * ============
 * 接收 DumpDetector 的 dumpSignal，应用：
 *   - 同代币冷却（cooldownMsPerToken）
 *   - 全局并发限制（maxConcurrentPositions）
 *   - 不能买自己刚刚卖出的同笔交易（避免自己触发自己）
 *
 * 通过后发出 buyOrder 事件给 Executor。
 */
class SignalEngine extends EventEmitter {
  constructor({ tradeLogger, positionManager }) {
    super();
    this.tradeLogger = tradeLogger;
    this.positionManager = positionManager;
    this.lastTriggerTs = new Map(); // mint → ts
    this.ourSignatures = new Set(); // 我们自己发出的 tx 签名（避免自触发）
    this.inflightBuys = new Set();  // 正在 buy 但还没 registerOpen 的 mint（防并发超额）
  }

  /**
   * 由 main 在调用 executor.buy 前后通知 SignalEngine。
   * 这样 openPositionCount + inflightBuys 一起算"占用槽位"。
   */
  markBuyInflight(mint) {
    this.inflightBuys.add(mint);
  }
  markBuyDone(mint) {
    this.inflightBuys.delete(mint);
  }

  registerOurSignature(sig) {
    if (!sig) return;
    this.ourSignatures.add(sig);
    // 5 分钟后自动剔除
    setTimeout(() => this.ourSignatures.delete(sig), 5 * 60_000);
  }

  handleDumpSignal(signal) {
    monitor.beat('SignalEngine', 'signal');
    const { mint, symbol, sellSol, priceImpactPct, seller, signature, ts } = signal;

    // 1. 自触发过滤
    if (signature && this.ourSignatures.has(signature)) {
      monitor.inc('SignalEngine.rejectedSelfTrigger', 1, 'SignalEngine');
      this._logReject(signal, 'self-triggered');
      return;
    }

    // 2. 冷却
    const last = this.lastTriggerTs.get(mint);
    if (last && Date.now() - last < config.strategy.cooldownMsPerToken) {
      monitor.inc('SignalEngine.rejectedCooldown', 1, 'SignalEngine');
      this._logReject(signal, `cooldown (${Math.round((Date.now() - last) / 1000)}s ago)`);
      return;
    }

    // 3. 并发限制（同时计算已开仓 + 正在 buy 的）
    const openCount = this.positionManager.openPositionCount();
    const inflightCount = this.inflightBuys.size;
    const totalSlotsUsed = openCount + inflightCount;
    if (totalSlotsUsed >= config.strategy.maxConcurrentPositions) {
      monitor.inc('SignalEngine.rejectedMaxConcurrent', 1, 'SignalEngine');
      this._logReject(
        signal,
        `max concurrent (${openCount} open + ${inflightCount} inflight / ${config.strategy.maxConcurrentPositions})`,
      );
      return;
    }

    // 4. 同代币当前已有持仓 OR 正在 buy 中
    if (this.positionManager.hasOpenPosition(mint) || this.inflightBuys.has(mint)) {
      monitor.inc('SignalEngine.rejectedAlreadyHolding', 1, 'SignalEngine');
      this._logReject(signal, this.inflightBuys.has(mint) ? 'buy in-flight' : 'already holding');
      return;
    }

    // 通过 → 触发买入
    monitor.inc('SignalEngine.signalsAccepted', 1, 'SignalEngine');
    this.lastTriggerTs.set(mint, Date.now());
    this.tradeLogger.logSignal({
      ts,
      mint,
      symbol,
      kind: 'BUY_SIGNAL',
      sellSol,
      priceImpactPct,
      seller,
      sellerTx: signature,
      notes: `dump signal accepted; sellSol=${sellSol.toFixed(2)}, impact=${priceImpactPct.toFixed(2)}%`,
      accepted: true,
    });

    console.log(
      `[SignalEngine] ✅ BUY_SIGNAL ${symbol || mint.slice(0, 6)}: sell=${sellSol.toFixed(
        2,
      )} SOL, impact=-${priceImpactPct.toFixed(2)}%`,
    );

    this.emit('buyOrder', {
      ...signal,
      reason: `dump: sell ${sellSol.toFixed(2)} SOL, impact -${priceImpactPct.toFixed(2)}%`,
      sizeSol: config.strategy.positionSizeSol,
    });
  }

  _logReject(signal, reason) {
    this.tradeLogger.logSignal({
      ts: signal.ts,
      mint: signal.mint,
      symbol: signal.symbol,
      kind: 'DUMP_DETECTED',
      sellSol: signal.sellSol,
      priceImpactPct: signal.priceImpactPct,
      seller: signal.seller,
      sellerTx: signal.signature,
      notes: 'detected but rejected',
      accepted: false,
      rejectReason: reason,
    });
    console.log(
      `[SignalEngine] ⏭  rejected ${signal.symbol || signal.mint.slice(0, 6)}: ${reason}`,
    );
  }
}

module.exports = SignalEngine;
