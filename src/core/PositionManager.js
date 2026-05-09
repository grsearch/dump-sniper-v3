'use strict';

/**
 * PositionManager (v2)
 * ====================
 * 维护当前持仓。每次 PriceTracker 更新价格时检查是否止盈/紧急止损/超时。
 * 100ms tick 兜底，防止价格不更新时无法触发超时退出。
 *
 * 关键修复（v2）：
 *
 * 1. 双确认止盈：连续 N 次（默认 2）满足 TP 条件，且首次和最近一次间隔
 *    >= tpConfirmMinGapMs（默认 300ms），才真正触发卖出。挡住单次价格污染。
 *
 * 2. 紧急止损：跌幅 <= emergencyStopLossPct（默认 -15%）立即出场。
 *    防止 PRATT/Goblin/COMPUTA 那种 -97% 灾难。
 *
 * 3. PnL 用真实成交价计算：sellResult.solOut 来自钱包真实余额变化（LIVE）
 *    或 Jupiter quote 的 outAmount。entry_price 来自 BUY 真实成交比率。
 *    不再用"trigger 时的 price tracker 价格"做 PnL 分母。
 *
 * 4. SELL 失败按指数退避重试，且重试时使用最新价格做 sanity 检查
 *
 * 5. registerOpen 接受外部 positionId（与 BUY trade 配对）
 *
 * 6. restoreFromDb 启动时恢复未平仓持仓
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('PositionManager', { staleMs: 10_000, label: 'Position Manager' });

const SELL_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 10_000, 20_000]; // 之后保持 30s

class PositionManager extends EventEmitter {
  constructor({ tradeLogger, executor, priceTracker, tokenRegistry }) {
    super();
    this.tradeLogger = tradeLogger;
    this.executor = executor;
    this.priceTracker = priceTracker;
    this.tokenRegistry = tokenRegistry;

    this.positions = new Map(); // positionId → position obj
    this.byMint = new Map();    // mint → positionId

    this.tickTimer = setInterval(() => {
      monitor.beat('PositionManager', 'tick');
      monitor.inc('PositionManager.ticks', 1, 'PositionManager');
      this._tick();
    }, 100);

    this.priceTracker.on('update', ({ mint, price }) => {
      const pid = this.byMint.get(mint);
      if (!pid) return;
      this._checkExit(pid, price);
    });
  }

  stop() {
    clearInterval(this.tickTimer);
  }

  hasOpenPosition(mint) {
    return this.byMint.has(mint);
  }

  openPositionCount() {
    return this.positions.size;
  }

  listOpen() {
    return Array.from(this.positions.values());
  }

  /**
   * 启动时从 DB 恢复未平仓的持仓。
   * 对每个恢复的持仓：
   *   - 如果 openedAt + maxHoldMs 已过：立即触发 SELL（exitReason=TIMEOUT_RESTORED）
   *   - 否则：正常进入 _tick 循环
   */
  restoreFromDb() {
    const open = this.tradeLogger.getOpenPositions();
    if (open.length === 0) return [];

    const restored = [];
    for (const row of open) {
      const pos = {
        positionId: row.position_id,
        mint: row.mint,
        symbol: row.symbol,
        entrySol: row.entry_sol,
        entryPrice: row.entry_price,
        tokenAmount: row.token_amount,
        openedAt: row.opened_at,
        dryRun: !!row.dry_run,
        buySignature: row.buy_signature,
        exiting: false,
        sellAttempts: row.sell_attempts || 0,
        // 双确认状态
        _tpConfirmCount: 0,
        _tpFirstTriggerTs: null,
      };
      this.positions.set(pos.positionId, pos);
      this.byMint.set(pos.mint, pos.positionId);
      restored.push(pos);
      console.log(
        `[PositionManager] 🔄 RESTORED ${pos.symbol || pos.mint.slice(0, 6)} ` +
          `opened ${Math.round((Date.now() - pos.openedAt) / 1000)}s ago, ` +
          `${(pos.tokenAmount ?? 0).toFixed(2)} tokens`,
      );
    }
    monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
    return restored;
  }

  /**
   * BUY 成功后由 main 流程调用。
   * @param {object} p
   * @param {string} [p.positionId] - 必须传，与 BUY trade 同 ID
   * @param {string} p.mint
   * @param {string} p.symbol
   * @param {number} p.entrySol - 真实付出的 SOL（含滑点和 fee 损耗）
   * @param {number} p.entryPrice - 真实成交价 = entrySol / tokenAmount
   * @param {number} p.tokenAmount - 真实买到的 token UI amount
   * @param {boolean} p.dryRun
   * @param {string} p.signature
   */
  registerOpen({ positionId, mint, symbol, entrySol, entryPrice, tokenAmount, dryRun, signature }) {
    const pid = positionId || crypto.randomUUID();
    const pos = {
      positionId: pid,
      mint,
      symbol,
      entrySol,
      entryPrice,
      tokenAmount,
      openedAt: Date.now(),
      dryRun: !!dryRun,
      buySignature: signature,
      exiting: false,
      sellAttempts: 0,
      _tpConfirmCount: 0,
      _tpFirstTriggerTs: null,
    };
    this.positions.set(pid, pos);
    this.byMint.set(mint, pid);

    this.tradeLogger.openPosition({
      positionId: pid,
      mint,
      symbol,
      openedAt: pos.openedAt,
      entrySol,
      entryPrice,
      tokenAmount,
      dryRun: !!dryRun,
      buySignature: signature,
    });

    console.log(
      `[PositionManager] 📈 OPEN ${symbol || mint.slice(0, 6)} @ ${entryPrice.toExponential(4)}, ` +
        `${tokenAmount.toFixed(2)} tokens, ${entrySol.toFixed(4)} SOL`,
    );

    monitor.inc('PositionManager.opened', 1, 'PositionManager');
    monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
    this.emit('opened', pos);
    return pos;
  }

  _tick() {
    const now = Date.now();
    for (const pos of this.positions.values()) {
      if (pos.exiting) continue;
      const age = now - pos.openedAt;
      if (age >= config.strategy.maxHoldMs) {
        const lastPrice = this.priceTracker.getPrice(pos.mint) || pos.entryPrice;
        this._exit(pos, lastPrice, 'TIMEOUT');
      }
    }
  }

  _checkExit(positionId, price) {
    const pos = this.positions.get(positionId);
    if (!pos || pos.exiting) return;

    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

    // 紧急止损：触发立即出（不双确认，因为我们要救命）
    const emergencyPct = config.strategy.emergencyStopLossPct;
    if (emergencyPct < 0 && pnlPct <= emergencyPct) {
      console.warn(
        `[PositionManager] 🚨 EMERGENCY_STOP ${pos.symbol || pos.mint.slice(0, 6)} ` +
          `pnl=${pnlPct.toFixed(2)}%`,
      );
      this._exit(pos, price, 'EMERGENCY_STOP');
      return;
    }

    // 止盈：双确认机制
    if (pnlPct >= config.strategy.takeProfitPct) {
      const now = Date.now();
      pos._tpConfirmCount += 1;
      if (!pos._tpFirstTriggerTs) pos._tpFirstTriggerTs = now;

      const need = config.strategy.tpConfirmCount;
      const minGap = config.strategy.tpConfirmMinGapMs;
      const elapsed = now - pos._tpFirstTriggerTs;

      if (pos._tpConfirmCount >= need && elapsed >= minGap) {
        console.log(
          `[PositionManager] ✅ TP confirmed ${pos.symbol || pos.mint.slice(0, 6)} ` +
            `pnl=${pnlPct.toFixed(2)}% after ${pos._tpConfirmCount} ticks ${elapsed}ms`,
        );
        this._exit(pos, price, 'TAKE_PROFIT');
      } else {
        // 等下一次确认
        monitor.inc('PositionManager.tpPending', 1, 'PositionManager');
      }
    } else {
      // 价格回落到 TP 阈值以下：清掉双确认状态（重新计数）
      if (pos._tpConfirmCount > 0) {
        pos._tpConfirmCount = 0;
        pos._tpFirstTriggerTs = null;
      }
    }
  }

  async _exit(pos, exitPrice, reason) {
    if (pos.exiting) return;
    pos.exiting = true;
    pos.exitReason = reason;

    monitor.inc(`PositionManager.exitsBy_${reason}`, 1, 'PositionManager');

    console.log(
      `[PositionManager] 📉 EXIT ${pos.symbol || pos.mint.slice(0, 6)} reason=${reason} ` +
        `triggerPnl=${(((exitPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%`,
    );

    await this._attemptSell(pos, exitPrice);
  }

  async _attemptSell(pos, triggerPrice) {
    const tokenInfo = this.tokenRegistry.getToken(pos.mint);

    let sellResult;
    try {
      sellResult = await this.executor.sell({
        mint: pos.mint,
        symbol: pos.symbol,
        poolAddress: tokenInfo?.pool_address,
        poolBaseVault: tokenInfo?.pool_base_vault,
        poolQuoteVault: tokenInfo?.pool_quote_vault,
        tokenAmount: pos.tokenAmount,
        baseDecimals: tokenInfo?.decimals ?? 6,
        currentPrice: triggerPrice,
      });
    } catch (err) {
      monitor.recordError('PositionManager', err, {
        phase: 'sell_throw',
        mint: pos.mint,
        symbol: pos.symbol,
      });
      sellResult = { success: false, error: err.message, latencyMs: 0 };
    }

    pos.sellAttempts = (pos.sellAttempts || 0) + 1;

    // 计算 PnL 用真实成交结果（不是 trigger 价）
    const realSolOut = sellResult.solOut ?? null;
    const realExitPrice = sellResult.price ?? triggerPrice;

    this.tradeLogger.logTrade({
      positionId: pos.positionId,
      ts: Date.now(),
      mint: pos.mint,
      symbol: pos.symbol,
      side: 'SELL',
      solAmount: realSolOut,
      tokenAmount: pos.tokenAmount,
      price: realExitPrice,
      signature: sellResult.signature,
      success: sellResult.success,
      dryRun: pos.dryRun,
      reason: pos.exitReason + (pos.sellAttempts > 1 ? `_retry_${pos.sellAttempts}` : ''),
      latencyMs: sellResult.latencyMs,
      error: sellResult.error,
    });

    if (sellResult.success) {
      const exitSol = realSolOut ?? pos.tokenAmount * realExitPrice;
      const pnlSol = exitSol - pos.entrySol;
      const pnlPct = ((exitSol - pos.entrySol) / pos.entrySol) * 100;

      this.tradeLogger.closePosition(pos.positionId, {
        closedAt: Date.now(),
        exitPrice: realExitPrice,
        exitSol,
        pnlSol,
        pnlPct,
        exitReason: pos.exitReason,
        sellSignature: sellResult.signature,
      });

      this.positions.delete(pos.positionId);
      this.byMint.delete(pos.mint);
      monitor.inc('PositionManager.closed', 1, 'PositionManager');
      monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
      if (pnlSol > 0) monitor.inc('PositionManager.winners', 1, 'PositionManager');
      else monitor.inc('PositionManager.losers', 1, 'PositionManager');

      console.log(
        `[PositionManager] 🏁 CLOSED ${pos.symbol || pos.mint.slice(0, 6)} ` +
          `realPnl=${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(2)}%)`,
      );

      this.emit('closed', {
        ...pos,
        exitPrice: realExitPrice,
        exitSol,
        pnlSol,
        pnlPct,
        exitReason: pos.exitReason,
      });
      return;
    }

    // SELL 失败 → 重试
    monitor.inc('PositionManager.sellRetries', 1, 'PositionManager');
    this.tradeLogger.recordSellAttempt(pos.positionId, sellResult.error);

    // DRY_RUN 不应该失败
    if (pos.dryRun) {
      monitor.recordError('PositionManager', new Error('DRY_RUN sell unexpectedly failed'), {
        mint: pos.mint,
        symbol: pos.symbol,
        error: sellResult.error,
      });
      console.error(
        `[PositionManager] DRY_RUN sell unexpectedly failed for ${pos.mint}; abandoning`,
      );
      // 关键：必须 close 该 position，否则 closed_at IS NULL，重启时会被 restoreFromDb 加回来
      this.tradeLogger.closePosition(pos.positionId, {
        closedAt: Date.now(),
        exitPrice: triggerPrice,
        exitSol: 0,
        pnlSol: -pos.entrySol,
        pnlPct: -100,
        exitReason: pos.exitReason + '_FAILED',
        sellSignature: null,
      });
      this.positions.delete(pos.positionId);
      this.byMint.delete(pos.mint);
      monitor.set('PositionManager.openCount', this.positions.size, 'PositionManager');
      return;
    }

    const delayIdx = Math.min(pos.sellAttempts - 1, SELL_RETRY_DELAYS_MS.length - 1);
    const delay = SELL_RETRY_DELAYS_MS[delayIdx] || 30_000;

    console.warn(
      `[PositionManager] SELL failed (attempt ${pos.sellAttempts}): ${sellResult.error}; ` +
        `retrying in ${delay}ms`,
    );

    setTimeout(() => {
      if (!this.positions.has(pos.positionId)) return; // 已被外部关掉
      const latestPrice = this.priceTracker.getPrice(pos.mint) || triggerPrice;
      this._attemptSell(pos, latestPrice).catch((err) => {
        monitor.recordError('PositionManager', err, {
          phase: 'sell_retry_crash',
          mint: pos.mint,
        });
        console.error(`[PositionManager] sell retry crashed: ${err.message}`);
      });
    }, delay);
  }
}

module.exports = PositionManager;
