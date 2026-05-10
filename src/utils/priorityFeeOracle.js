'use strict';

/**
 * PriorityFeeOracle
 * =================
 * 动态 priority fee 估算：
 *
 * 调用 Helius getPriorityFeeEstimate API，返回 microLamports/CU 级别的建议值。
 * 支持按 percentile 级别 (low/medium/high/veryHigh) 选择。
 *
 * 缓存 1.5s（避免每笔下单都查；Solana 1 slot ≈ 400ms，1.5s 内拥堵基本不变）。
 *
 * 关键设计：
 *   - estimate(side) 总是返回一个有效值（微 lamports/CU）
 *   - 失败时返回 fallback（来自 config 的静态值换算）
 *   - 应用 min/cap 边界（防止 RPC 返回 0 或返回异常高的值）
 *
 * Helius getPriorityFeeEstimate 返回示例（用 includeAllPriorityFeeLevels=true）：
 *   {
 *     priorityFeeLevels: {
 *       min: 10000.0,
 *       low: 10000.0,
 *       medium: 10000.0,
 *       high: 100000.0,
 *       veryHigh: 5483924.8,
 *       unsafeMax: 8698904817.0
 *     }
 *   }
 *   单位：microLamports per compute unit
 */

const axios = require('axios');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('PriorityFeeOracle', { staleMs: 60_000, label: 'Priority Fee Oracle' });

// Pump AMM program ID — 用作 accountKeys 让 Helius 估算 Pump 相关交易的 fee
const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const CACHE_TTL_MS = 1500;

class PriorityFeeOracle {
  constructor() {
    this.rpcUrl = config.helius.rpcUrl;
    this.cuLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '150000', 10);
    this._cache = null;        // { levels: {...}, fetchedAt: ts }
    this._inflight = null;     // 防止并发查询
  }

  /**
   * 拉取实时 priority fee 各级别（microLamports/CU）。
   * 缓存 CACHE_TTL_MS。
   */
  async _fetchLevels() {
    if (this._cache && Date.now() - this._cache.fetchedAt < CACHE_TTL_MS) {
      return this._cache.levels;
    }
    if (this._inflight) return this._inflight;

    this._inflight = (async () => {
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
        if (!levels) throw new Error('no priorityFeeLevels in response');

        this._cache = { levels, fetchedAt: Date.now() };
        monitor.set('PriorityFeeOracle.lastFetchMs', elapsed, 'PriorityFeeOracle');
        monitor.inc('PriorityFeeOracle.fetchOk', 1, 'PriorityFeeOracle');
        monitor.beat('PriorityFeeOracle', 'fetch');
        return levels;
      } catch (err) {
        monitor.inc('PriorityFeeOracle.fetchFail', 1, 'PriorityFeeOracle');
        monitor.recordError('PriorityFeeOracle', err, { phase: 'fetch_estimate' });
        return null;
      } finally {
        this._inflight = null;
      }
    })();

    return this._inflight;
  }

  /**
   * 估算 BUY 或 SELL 的 priority fee 总量（lamports）。
   * @param {'BUY' | 'SELL'} side
   * @returns {Promise<{ totalLamports: number, microLamportsPerCu: number, source: 'dynamic' | 'static' | 'fallback' }>}
   */
  async estimate(side) {
    const cfg = config.priorityFee;
    const isBuy = side === 'BUY';

    // 静态模式：直接返回配置值
    if (!cfg.dynamic) {
      const totalLamports = isBuy ? cfg.buyMaxLamports : cfg.sellMaxLamports;
      const microLamportsPerCu = Math.floor((totalLamports * 1_000_000) / this.cuLimit);
      return { totalLamports, microLamportsPerCu, source: 'static' };
    }

    // 动态模式：查 Helius
    const levels = await this._fetchLevels();
    if (!levels) {
      // RPC 失败，fallback 到静态
      const totalLamports = isBuy ? cfg.buyMaxLamports : cfg.sellMaxLamports;
      const microLamportsPerCu = Math.floor((totalLamports * 1_000_000) / this.cuLimit);
      return { totalLamports, microLamportsPerCu, source: 'fallback' };
    }

    const levelKey = isBuy ? cfg.buyLevel : cfg.sellLevel; // 'medium' | 'high' | 'veryHigh' 等
    let recommendedMicroLamportsPerCu = levels[levelKey];
    if (typeof recommendedMicroLamportsPerCu !== 'number' || !isFinite(recommendedMicroLamportsPerCu)) {
      // level 不存在或值异常，退到 medium
      recommendedMicroLamportsPerCu = levels.medium || 10000;
    }

    // 总 lamports = (microLamports/CU) × CU / 1_000_000
    let totalLamports = Math.ceil((recommendedMicroLamportsPerCu * this.cuLimit) / 1_000_000);

    // 应用 min/cap 边界
    const minLamports = isBuy ? cfg.buyMinLamports : cfg.sellMinLamports;
    const capLamports = isBuy ? cfg.buyCapLamports : cfg.sellCapLamports;
    if (totalLamports < minLamports) totalLamports = minLamports;
    if (totalLamports > capLamports) totalLamports = capLamports;

    const microLamportsPerCu = Math.floor((totalLamports * 1_000_000) / this.cuLimit);

    return { totalLamports, microLamportsPerCu, source: 'dynamic' };
  }
}

module.exports = PriorityFeeOracle;
