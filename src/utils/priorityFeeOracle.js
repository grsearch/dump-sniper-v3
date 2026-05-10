'use strict';

/**
 * PriorityFeeOracle (v3.8: 永不阻塞 BUY 路径)
 * =====================
 *
 * v3.8 关键改动：从「按需查询 + 缓存」改成「后台轮询 + 同步读」
 *   - 启动时立即 fetch 一次
 *   - 每 N 秒后台 fetch 刷新内存
 *   - estimate(side) 同步返回内存值，不 await，不可能阻塞 BUY 路径
 *   - 失败时仍然有上一次的值（或静态 fallback）
 *
 * 这样 Executor.buy 不会因为 fee oracle 缓存过期触发 1.5s RPC fetch
 *
 * Helius getPriorityFeeEstimate 返回示例：
 *   priorityFeeLevels: { min, low, medium, high, veryHigh, unsafeMax } (microLamports/CU)
 */

const axios = require('axios');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('PriorityFeeOracle', { staleMs: 60_000, label: 'Priority Fee Oracle' });

const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const REFRESH_MS = parseInt(process.env.PRIORITY_FEE_REFRESH_MS || '1500', 10);

class PriorityFeeOracle {
  constructor() {
    this.rpcUrl = config.helius.rpcUrl;
    this.cuLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '200000', 10);

    this._cachedLevels = null;     // 最新 levels（内存）
    this._cachedAt = 0;
    this._timer = null;

    // 启动时拉一次（异步，不阻塞构造）
    if (config.priorityFee.dynamic) {
      this._start();
    }
  }

  _start() {
    if (this._timer) return;
    // 立即拉一次
    this._fetchLevels();
    // 后台定时
    this._timer = setInterval(() => this._fetchLevels(), REFRESH_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _fetchLevels() {
    try {
      const t0 = Date.now();
      const { data } = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getPriorityFeeEstimate',
          params: [
            {
              accountKeys: [PUMP_AMM_PROGRAM_ID],
              options: {
                includeAllPriorityFeeLevels: true,
                evaluateEmptySlotAsZero: true,
              },
            },
          ],
        },
        { timeout: 1500 },
      );
      const elapsed = Date.now() - t0;
      if (data.error) throw new Error(JSON.stringify(data.error));
      const levels = data?.result?.priorityFeeLevels;
      if (!levels) throw new Error('no priorityFeeLevels');

      this._cachedLevels = levels;
      this._cachedAt = Date.now();
      monitor.set('PriorityFeeOracle.lastFetchMs', elapsed, 'PriorityFeeOracle');
      monitor.inc('PriorityFeeOracle.fetchOk', 1, 'PriorityFeeOracle');
      monitor.beat('PriorityFeeOracle', 'fetch');
    } catch (err) {
      monitor.inc('PriorityFeeOracle.fetchFail', 1, 'PriorityFeeOracle');
      monitor.recordError('PriorityFeeOracle', err, { phase: 'fetch_estimate' });
      // 失败时保留上一次的值
    }
  }

  /**
   * v3.8: 同步返回内存值。**永不阻塞，永不 await RPC**。
   * @param {'BUY' | 'SELL'} side
   * @returns {{ totalLamports, microLamportsPerCu, source }}
   */
  estimate(side) {
    const cfg = config.priorityFee;
    const isBuy = side === 'BUY';

    // 静态模式
    if (!cfg.dynamic) {
      const totalLamports = isBuy ? cfg.buyMaxLamports : cfg.sellMaxLamports;
      const microLamportsPerCu = Math.floor((totalLamports * 1_000_000) / this.cuLimit);
      return { totalLamports, microLamportsPerCu, source: 'static' };
    }

    // 动态模式 — 从内存读
    const levels = this._cachedLevels;
    if (!levels) {
      // 启动初期还没拿到，用静态 fallback
      const totalLamports = isBuy ? cfg.buyMaxLamports : cfg.sellMaxLamports;
      const microLamportsPerCu = Math.floor((totalLamports * 1_000_000) / this.cuLimit);
      return { totalLamports, microLamportsPerCu, source: 'fallback' };
    }

    const levelKey = isBuy ? cfg.buyLevel : cfg.sellLevel;
    let recommendedMicroLamportsPerCu = levels[levelKey];
    if (typeof recommendedMicroLamportsPerCu !== 'number' || !isFinite(recommendedMicroLamportsPerCu)) {
      recommendedMicroLamportsPerCu = levels.medium || 10000;
    }

    let totalLamports = Math.ceil((recommendedMicroLamportsPerCu * this.cuLimit) / 1_000_000);

    const minLamports = isBuy ? cfg.buyMinLamports : cfg.sellMinLamports;
    const capLamports = isBuy ? cfg.buyCapLamports : cfg.sellCapLamports;
    if (totalLamports < minLamports) totalLamports = minLamports;
    if (totalLamports > capLamports) totalLamports = capLamports;

    const microLamportsPerCu = Math.floor((totalLamports * 1_000_000) / this.cuLimit);
    return { totalLamports, microLamportsPerCu, source: 'dynamic' };
  }
}

module.exports = PriorityFeeOracle;
