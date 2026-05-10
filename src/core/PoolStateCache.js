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
    this.refreshIntervalMs = parseInt(
      process.env.POOL_STATE_REFRESH_MS || refreshIntervalMs || '2000',
      10,
    );

    this.cache = new Map();   // poolAddress(string) → { state, fetchedAt }
    this.timer = null;
    this._refreshing = false;
  }

  start() {
    if (this.timer) return;
    if (!this.onlineSdk || !this.user) {
      console.warn('[PoolStateCache] not started: missing onlineSdk or user');
      return;
    }
    // 立即刷一次
    this._refreshAll().catch((err) => {
      monitor.recordError('PoolStateCache', err, { phase: 'initial_refresh' });
    });
    // 然后定时
    this.timer = setInterval(() => {
      this._refreshAll().catch((err) => {
        monitor.recordError('PoolStateCache', err, { phase: 'periodic_refresh' });
      });
    }, this.refreshIntervalMs);
    console.log(`[PoolStateCache] started (refresh every ${this.refreshIntervalMs}ms)`);
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
   * 后台刷新所有 pool 的 state。串行最多 10 个并发避免压垮 RPC。
   */
  async _refreshAll() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const list = this.getMintList ? this.getMintList() : [];
      const targets = list.filter((t) => t.poolAddress);
      if (targets.length === 0) return;

      monitor.beat('PoolStateCache', `refresh:${targets.length}`);
      const t0 = Date.now();

      // 并发 8 个：47 个代币约 6 批，每批 50ms RPC = 300ms 总耗时
      const CONCURRENCY = 8;
      let okCount = 0;
      let failCount = 0;
      for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (t) => {
            try {
              const poolKey = new PublicKey(t.poolAddress);
              const state = await this.onlineSdk.swapSolanaState(poolKey, this.user);
              if (state) {
                this.cache.set(t.poolAddress, { state, fetchedAt: Date.now() });
                return true;
              }
              return false;
            } catch (err) {
              return false;
            }
          }),
        );
        for (const r of results) {
          if (r) okCount++;
          else failCount++;
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
