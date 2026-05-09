'use strict';

/**
 * PriceTracker (v2)
 * =================
 * 接收 DumpDetector 推送的 priceTick，维护每个代币的最新价格。
 *
 * 关键修复（解决 v1 的"假 TAKE_PROFIT 触发 → 实际亏损卖出"bug）：
 *
 * 1. 拒绝异常跳变：单 tick 价格变化超过 ±maxJumpRatio（默认 ±50%）视为可疑
 * 2. 双确认机制：可疑值需要在 confirmWindowMs（默认 3 秒）内连续出现
 *    confirmMinSamples 次（默认 2 次）且方向一致才接受
 * 3. 否则丢弃，不更新内部价格
 *
 * 这样能挡住：
 *   - DumpDetector 启发式选错池子账户造成的假价格
 *   - LaserStream 推送多跳路由片段计算出的"局部"价格
 *   - 链上数据短暂异常
 *
 * 真实砸盘和反弹（即使 -30% 一笔）会通过两条同方向 tick 的双确认。
 */

const EventEmitter = require('events');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('PriceTracker', { staleMs: 600_000, label: 'Price Tracker' });

class PriceTracker extends EventEmitter {
  constructor() {
    super();
    this.prices = new Map();   // mint → { price, ts, poolAddress }
    this.suspicious = new Map(); // mint → [{price, ts, direction}, ...]
  }

  /**
   * 接收一笔价格 tick。可能被过滤丢弃。
   * @param {string} mint
   * @param {number} price - quote/base 比率（每个 token 多少 SOL）
   * @param {number} ts
   * @param {string} poolAddress
   */
  update(mint, price, ts = Date.now(), poolAddress = null) {
    if (!Number.isFinite(price) || price <= 0) {
      monitor.inc('PriceTracker.invalidPrice', 1, 'PriceTracker');
      return;
    }
    monitor.beat('PriceTracker', 'update');

    const last = this.prices.get(mint);

    // 第一笔：直接接受
    if (!last) {
      this._commit(mint, price, ts, poolAddress);
      return;
    }

    // 计算跳变比率
    const ratio = price / last.price;
    const maxRatio = config.priceFilter.maxJumpRatio;
    const isSuspicious = ratio > maxRatio || ratio < 1 / maxRatio;

    if (!isSuspicious) {
      // 正常范围，直接接受
      this.suspicious.delete(mint); // 清空可疑缓存
      this._commit(mint, price, ts, poolAddress);
      return;
    }

    // 可疑：进入缓存等待确认
    monitor.inc('PriceTracker.suspiciousReceived', 1, 'PriceTracker');
    const direction = price > last.price ? 'up' : 'down';

    let buf = this.suspicious.get(mint);
    if (!buf) {
      buf = [];
      this.suspicious.set(mint, buf);
    }
    // 去掉过期的
    const window = config.priceFilter.confirmWindowMs;
    const cutoff = ts - window;
    while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();

    buf.push({ price, ts, direction, poolAddress });

    // 检查是否满足"连续 N 次同方向"
    const minSamples = config.priceFilter.confirmMinSamples;
    if (buf.length < minSamples) {
      monitor.inc('PriceTracker.suspiciousPending', 1, 'PriceTracker');
      return; // 还不够，等下一笔
    }

    // 取最近 minSamples 笔，检查方向一致
    const recent = buf.slice(-minSamples);
    const allSameDir = recent.every((s) => s.direction === direction);
    if (!allSameDir) {
      // 方向不一致：清空缓存，丢弃这笔（可能是市场波动导致的双向噪音）
      monitor.inc('PriceTracker.suspiciousMixedDirection', 1, 'PriceTracker');
      this.suspicious.set(mint, []);
      return;
    }

    // 检查时间间隔（避免 1ms 内连续推同一笔污染数据通过双确认）
    const minGap = 50; // 50ms 是合理的最小连续 tick 间隔
    let allGapOk = true;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].ts - recent[i - 1].ts < minGap) {
        allGapOk = false;
        break;
      }
    }
    if (!allGapOk) {
      monitor.inc('PriceTracker.suspiciousTooFast', 1, 'PriceTracker');
      return;
    }

    // 通过：用最新一笔提交
    const latest = recent[recent.length - 1];
    monitor.inc('PriceTracker.suspiciousAccepted', 1, 'PriceTracker');
    this.suspicious.set(mint, []); // 清空
    this._commit(mint, latest.price, latest.ts, latest.poolAddress);
    console.log(
      `[PriceTracker] ${mint.slice(0, 6)} suspicious jump confirmed (${recent.length} samples, ` +
        `${direction}, last ratio=${(latest.price / last.price).toFixed(3)})`,
    );
  }

  _commit(mint, price, ts, poolAddress) {
    const prev = this.prices.get(mint);
    this.prices.set(mint, { price, ts, poolAddress });
    monitor.inc('PriceTracker.committed', 1, 'PriceTracker');
    this.emit('update', { mint, price, ts, prev: prev?.price ?? null });
  }

  get(mint) {
    return this.prices.get(mint) || null;
  }

  getPrice(mint) {
    return this.prices.get(mint)?.price ?? null;
  }

  /**
   * 强制设置（用于 BUY 后立即用真实成交价初始化 entryPrice）
   */
  forceSet(mint, price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    this.suspicious.delete(mint);
    this._commit(mint, price, ts, null);
  }
}

module.exports = PriceTracker;
