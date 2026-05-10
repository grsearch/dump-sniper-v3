'use strict';

require('dotenv').config();

const config = {
  // ============ Mode ============
  DRY_RUN: (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true',

  // ============ Strategy ============
  strategy: {
    // 触发条件（DumpDetector）
    minSellSol: parseFloat(process.env.MIN_SELL_SOL || '15.0'),
    minPriceImpactPct: parseFloat(process.env.MIN_PRICE_IMPACT_PCT || '12.0'),
    // v3.10: 实盘观察 — 阈值过宽抓"伪砸盘"（大池子 10 SOL 卖单价格几乎不动），
    // 也抓"流动性已死"（小池子 30%+ impact 但反弹空间小且滑点巨大）
    // 加这两条过滤
    maxPriceImpactPct: parseFloat(process.env.MAX_PRICE_IMPACT_PCT || '30.0'),
    minPoolQuoteSol: parseFloat(process.env.MIN_POOL_QUOTE_SOL || '30.0'),

    // 仓位
    positionSizeSol: parseFloat(process.env.POSITION_SIZE_SOL || '0.1'),

    // 止盈（双确认 + 紧急止损）
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '8.0'),
    tpConfirmCount: parseInt(process.env.TP_CONFIRM_COUNT || '2', 10),
    tpConfirmMinGapMs: parseInt(process.env.TP_CONFIRM_MIN_GAP_MS || '300', 10),

    // 紧急止损（防止灾难性下跌，比如 -97% 那种）
    // 设置为 0 可禁用紧急止损（恢复"硬扛"行为）
    emergencyStopLossPct: parseFloat(process.env.EMERGENCY_STOP_LOSS_PCT || '-15.0'),

    // 持仓
    maxHoldMs: parseInt(process.env.MAX_HOLD_MS || '15000', 10),

    // 滑点
    buySlippageBps: parseInt(process.env.BUY_SLIPPAGE_BPS || '1500', 10),  // 15%
    sellSlippageBps: parseInt(process.env.SELL_SLIPPAGE_BPS || '2000', 10), // 20%

    // 风控
    cooldownMsPerToken: parseInt(process.env.COOLDOWN_MS_PER_TOKEN || '60000', 10),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '3', 10),
  },

  // ============ Price anomaly filter ============
  priceFilter: {
    // 单 tick 价格变化超过 maxJumpRatio 视为可疑
    // 1.5 表示 +50% 或 -33%（1/1.5）以上属于异常
    maxJumpRatio: parseFloat(process.env.PRICE_MAX_JUMP_RATIO || '1.5'),
    // 可疑样本必须在多少毫秒内连续出现并方向一致才接受
    confirmWindowMs: parseInt(process.env.PRICE_CONFIRM_WINDOW_MS || '3000', 10),
    confirmMinSamples: parseInt(process.env.PRICE_CONFIRM_MIN_SAMPLES || '2', 10),
  },

  // ============ Helius ============
  helius: {
    apiKey: process.env.HELIUS_API_KEY,
    rpcUrl: process.env.HELIUS_RPC_URL,
    stakedRpcUrl: process.env.HELIUS_STAKED_RPC_URL,
    senderEndpoint: process.env.HELIUS_SENDER_ENDPOINT || null, // 可选: Helius Sender 加速 tx 提交
    laserstreamEndpoint: process.env.HELIUS_LASERSTREAM_ENDPOINT,
    laserstreamToken: process.env.HELIUS_LASERSTREAM_TOKEN,
  },

  // ============ Birdeye ============
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY,
    baseUrl: 'https://public-api.birdeye.so',
  },

  // ============ Wallet ============
  wallet: {
    privateKeyBs58: process.env.WALLET_PRIVATE_KEY_BS58,
  },

  // ============ Programs ============
  programs: {
    pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    systemProgram: '11111111111111111111111111111111',
    wsol: 'So11111111111111111111111111111111111111112',
  },

  // ============ Server ============
  server: {
    port: parseInt(process.env.DASHBOARD_PORT || '3001', 10),
    bindHost: process.env.BIND_HOST || '0.0.0.0',
    webhookSecret: process.env.WEBHOOK_SECRET || null,
    dashboardToken: process.env.DASHBOARD_TOKEN || null,
  },

  // ============ Storage ============
  storage: {
    dbPath: './data/sniper.db',
    reportsDir: './reports',
    logsDir: './logs',
  },

  // ============ Priority fees ============
  // BUY 和 SELL 分开配置：
  //   - BUY 是抢 slot 的（砸盘后所有 sniper 同抢），需要高 fee
  //   - SELL 是平仓的（晚 1-3 个 slot 落链没差别），低 fee 即可
  // 实测竞争者：BUY 0.012-0.045 SOL，SELL <0.0001-0.003 SOL
  priorityFee: {
    // 静态模式（dynamic=false 时使用）
    buyMaxLamports: parseInt(process.env.BUY_MAX_PRIORITY_FEE_LAMPORTS || '20000000', 10),  // 0.02 SOL
    sellMaxLamports: parseInt(process.env.SELL_MAX_PRIORITY_FEE_LAMPORTS || '500000', 10),  // 0.0005 SOL

    // 动态模式：用 Helius getPriorityFeeEstimate 查 mempool 实时拥堵
    // 砸盘事件中整网 fee 飙升，动态调整能跟上竞争者节奏
    dynamic: (process.env.PRIORITY_FEE_DYNAMIC ?? 'true').toLowerCase() === 'true',

    // 动态模式参数
    // BUY 用 high (75th) 或 veryHigh (95th)，SELL 用 medium (50th)
    buyLevel: process.env.BUY_PRIORITY_LEVEL || 'veryHigh',  // 抢入用最高级别
    sellLevel: process.env.SELL_PRIORITY_LEVEL || 'medium',  // 卖出用中等

    // 动态查询的保底 (避免 RPC 返回 0/异常)
    buyMinLamports: parseInt(process.env.BUY_MIN_PRIORITY_FEE_LAMPORTS || '10000000', 10),  // 0.01 SOL
    sellMinLamports: parseInt(process.env.SELL_MIN_PRIORITY_FEE_LAMPORTS || '100000', 10),  // 0.0001 SOL

    // 动态查询的上限 (即使 mempool 极拥堵也不超过)
    buyCapLamports: parseInt(process.env.BUY_CAP_PRIORITY_FEE_LAMPORTS || '200000000', 10),  // 0.2 SOL — v3.11: 之前 0.05 SOL cap 把 μL/CU 卡死在 250K，竞争者实测 40M+ μL/CU
    sellCapLamports: parseInt(process.env.SELL_CAP_PRIORITY_FEE_LAMPORTS || '2000000', 10), // 0.002 SOL
  },

  // 旧字段保留，向后兼容（仅用于 fallback）
  maxPriorityFeeLamports: parseInt(process.env.MAX_PRIORITY_FEE_LAMPORTS || '5000000', 10), // 0.005 SOL

  // 启动时是否自动尝试补充缺失的 pool 信息（PoolFinder）
  autoFillPoolsOnStart: (process.env.AUTO_FILL_POOLS_ON_START ?? 'true').toLowerCase() === 'true',
};

function validateConfig() {
  const errors = [];
  if (!config.helius.apiKey) errors.push('HELIUS_API_KEY missing');
  if (!config.helius.rpcUrl) errors.push('HELIUS_RPC_URL missing');
  if (!config.helius.laserstreamEndpoint) errors.push('HELIUS_LASERSTREAM_ENDPOINT missing');
  if (!config.helius.laserstreamToken) errors.push('HELIUS_LASERSTREAM_TOKEN missing');
  if (!config.birdeye.apiKey) errors.push('BIRDEYE_API_KEY missing');
  if (!config.DRY_RUN && !config.wallet.privateKeyBs58) {
    errors.push('WALLET_PRIVATE_KEY_BS58 required for LIVE mode');
  }
  return errors;
}

module.exports = { config, validateConfig };
