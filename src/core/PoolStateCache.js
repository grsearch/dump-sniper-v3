'use strict';

/**
 * PoolStateCache (v3.5)
 * =====================
 * 后台预取所有监控代币的 Pump pool state，砸盘瞬间 BUY 直接读内存。
 *
 * 设计目标：把 BUY 路径里的 swapSolanaState (80-150ms RPC) 从关键路径剔除。
 *
 * 工作方式：
 *   1. 启动时拿到 TokenRegistry 的所有 mint+pool 列表
 *   2. 后台 setInterval（默认 1 秒）刷新所有 pool 的 state
 *   3. 提供同步 get(poolAddress) 立即返回最近一次 state
 *   4. TokenRegistry 增删代币时调用 invalidate / addMint 立即同步
 *
 * Stale 处理：
 *   - pool state 最坏 1 秒前的（reserves 变化 << 1s）
 *   - 砸盘瞬间 reserves 已经变了，但我们的 slippage=15% 足够大，链上会重新算
 *   - 如果 cache 没有该 pool，fallback 到同步 RPC（首次抓取或刚加的代币）
 *
 * RPC 配额：
 *   - 50 个代币 × 1 次/秒 = 50 RPS（Helius Business 上限内）
 *   - 用 staked endpoint，不和交易主路径抢 quota
 *   - 每次刷新 batch 用 getMultipleAccounts 实际是 1 RPC 调用
 *
 * 暴露 API：
 *   - start(getMintList: () => [{mint, poolAddress}])
 *   - stop()
 *   - get(poolAddress) → state | null
 *   - getAge(poolAddress) → ms 或 null
 */

const { PublicKey } = require('@solana/web3.js');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('PoolStateCache', { staleMs: 30_000, label: 'Pool State Cache' });

class PoolStateCache {
  /**
   * @param {object} opts
   * @param {object} opts.onlineSdk - 已初始化的 OnlinePumpAmmSdk
   * @param {PublicKey} opts.user - 钱包公钥（swapSolanaState 需要）
   * @param {function} opts.getMintList - 返回 [{mint, poolAddress}] 的函数
   * @param {number} [opts.refreshIntervalMs=1000]
   */
  constructor({ onlineSdk, user, getMintList, refreshIntervalMs }) {
    this.onlineSdk = onlineSdk;
    this.user = user;
    this.getMintList = getMintList;
    // refreshIntervalMs = 每个 token 被刷新一次的周期（默认 5s）
    this.refreshIntervalMs = parseInt(
      process.env.POOL_STATE_REFRESH_MS || refreshIntervalMs || '5000',
      10,
    );
    // tick 间隔（默认 200ms），实际 RPC 调用频率 = batchSize / tickInterval
    this._tickIntervalMs = parseInt(process.env.POOL_STATE_TICK_MS || '200', 10);

    this.cache = new Map();   // poolAddress(string) → { state, fetchedAt }
    this.timer = null;
    this._refreshing = false;
    this._refreshCursor = 0;  // v3.14: 滚动刷新游标
  }

  start() {
    if (this.timer) return;
    if (!this.onlineSdk || !this.user) {
      console.warn('[PoolStateCache] not started: missing onlineSdk or user');
      return;
    }
    // v3.14: 滚动刷新 — 每 _tickIntervalMs 跑一次小批量
    // 不再"5 秒一次大爆发"，改"每 200ms 刷几个 token"，RPS 平稳
    this.timer = setInterval(() => {
      this._refreshAll().catch((err) => {
        monitor.recordError('PoolStateCache', err, { phase: 'periodic_refresh' });
      });
    }, this._tickIntervalMs);
    console.log(
      `[PoolStateCache] started (rolling refresh: each token every ${this.refreshIntervalMs}ms, tick=${this._tickIntervalMs}ms)`,
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cache.clear();
  }

  /**
   * 同步取缓存。返回最近一次 state 或 null。
   * @param {string} poolAddress
   * @returns {object | null}
   */
  get(poolAddress) {
    if (!poolAddress) return null;
    const entry = this.cache.get(poolAddress);
    if (!entry) return null;
    const age = Date.now() - entry.fetchedAt;
    monitor.set('PoolStateCache.lastReadAgeMs', age, 'PoolStateCache');
    return entry.state;
  }

  getAge(poolAddress) {
    const entry = this.cache.get(poolAddress);
    return entry ? Date.now() - entry.fetchedAt : null;
  }

  /**
   * v3.8: 单点刷新（dumpSignal 触发时使用）
   * 不阻塞调用方；后台异步刷新。如果该 pool 1秒内已经刷过则跳过。
   */
  async refreshOne(poolAddress) {
    if (!this.onlineSdk || !this.user || !poolAddress) return;
    const cached = this.cache.get(poolAddress);
    if (cached && Date.now() - cached.fetchedAt < 1000) return; // 太新就跳
    try {
      const { PublicKey } = require('@solana/web3.js');
      const poolKey = new PublicKey(poolAddress);
      const state = await this.onlineSdk.swapSolanaState(poolKey, this.user);
      if (state) {
        this.cache.set(poolAddress, { state, fetchedAt: Date.now() });
        monitor.inc('PoolStateCache.refreshOneOk', 1, 'PoolStateCache');
      }
    } catch (err) {
      monitor.inc('PoolStateCache.refreshOneFail', 1, 'PoolStateCache');
    }
  }

  /**
   * v3.14 重写：滚动式刷新（rolling refresh），不再"每 N 秒一次大批量"
   *
   * 原版（v3.5-v3.13）：每 5s 醒来 → 8 并发刷 70 个 token → 瞬时 RPS 暴涨被限流
   * 现在：维护一个游标，每 tickIntervalMs 刷一小批（refreshBatchSize）
   *     -> 平均 RPS = batchSize × (1000/tickInterval) / token 数 × token 数 = 平稳值
   *
   * 计算示例（70 个 token，目标每个 token 每 5s 刷一次 = 14 RPS PoolStateCache 占用）：
   *   - tickIntervalMs = 200ms  -> 每秒 5 tick
   *   - 每 tick 刷 (70 × 200) / 5000 = 2.8 ≈ 3 个 token
   *   - 实际 = 3 × 5 = 15 RPS 平稳，无爆发
   *
   * 注意：swapSolanaState 内部可能拉 4 个账户（pool, globalConfig, base vault, quote vault）
   * 但 SDK 通常用 getMultipleAccounts 合并成 1 个 RPC call。如果不是 → RPS × 4
   */
  async _refreshAll() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const list = this.getMintList ? this.getMintList() : [];
      const targets = list.filter((t) => t.poolAddress);
      if (targets.length === 0) return;

      // 计算每个 tick 应该刷新的数量
      // 目标：每个 token 在 refreshIntervalMs 周期内被刷一次
      const tokensPerCycle = targets.length;
      const ticksPerCycle = this.refreshIntervalMs / this._tickIntervalMs;
      const batchSize = Math.max(1, Math.ceil(tokensPerCycle / ticksPerCycle));

      // 从 _refreshCursor 开始，刷 batchSize 个
      const slice = [];
      for (let i = 0; i < batchSize; i++) {
        slice.push(targets[this._refreshCursor % targets.length]);
        this._refreshCursor++;
      }

      monitor.beat('PoolStateCache', `refresh:${slice.length}`);
      const t0 = Date.now();

      let okCount = 0;
      let failCount = 0;
      // 顺序刷新（不要并发，避免瞬时峰值）
      for (const t of slice) {
        try {
          const poolKey = new PublicKey(t.poolAddress);
          const state = await this.onlineSdk.swapSolanaState(poolKey, this.user);
          if (state) {
            this.cache.set(t.poolAddress, { state, fetchedAt: Date.now() });
            okCount++;
          } else {
            failCount++;
          }
        } catch (err) {
          failCount++;
          // 429 时短暂退避
          if (err.message && err.message.includes('429')) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      const elapsed = Date.now() - t0;
      monitor.set('PoolStateCache.lastRefreshMs', elapsed, 'PoolStateCache');
      monitor.set('PoolStateCache.cacheSize', this.cache.size, 'PoolStateCache');
      monitor.inc('PoolStateCache.refreshOk', okCount, 'PoolStateCache');
      if (failCount > 0) monitor.inc('PoolStateCache.refreshFail', failCount, 'PoolStateCache');
    } finally {
      this._refreshing = false;
    }
  }
}

module.exports = PoolStateCache;
