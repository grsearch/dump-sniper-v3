'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { config } = require('../config');

class TradeLogger {
  constructor(sharedDb = null) {
    if (sharedDb) {
      this.db = sharedDb;
    } else {
      const dbPath = path.resolve(config.storage.dbPath);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        kind TEXT NOT NULL,
        sell_sol REAL,
        price_impact_pct REAL,
        seller TEXT,
        seller_tx TEXT,
        notes TEXT,
        accepted INTEGER DEFAULT 0,
        reject_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
      CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        side TEXT NOT NULL,
        sol_amount REAL,
        token_amount REAL,
        price REAL,
        signature TEXT,
        success INTEGER DEFAULT 0,
        dry_run INTEGER DEFAULT 0,
        reason TEXT,
        latency_ms INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
      CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_id);

      CREATE TABLE IF NOT EXISTS positions (
        position_id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        symbol TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        entry_sol REAL,
        entry_price REAL,
        token_amount REAL,
        exit_price REAL,
        exit_sol REAL,
        pnl_sol REAL,
        pnl_pct REAL,
        exit_reason TEXT,
        dry_run INTEGER DEFAULT 0,
        buy_signature TEXT,
        sell_signature TEXT,
        sell_attempts INTEGER DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_positions_opened ON positions(opened_at);
    `);

    // Migration: 老数据库可能缺少新加的字段
    const cols = this.db.prepare(`PRAGMA table_info(positions)`).all().map((c) => c.name);
    if (!cols.includes('buy_signature')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN buy_signature TEXT`);
    }
    if (!cols.includes('sell_signature')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN sell_signature TEXT`);
    }
    if (!cols.includes('sell_attempts')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN sell_attempts INTEGER DEFAULT 0`);
    }
    if (!cols.includes('last_error')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN last_error TEXT`);
    }
    // v3.3: 重试持久化 + 状态机字段
    if (!cols.includes('next_retry_at')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN next_retry_at INTEGER`);
    }
    if (!cols.includes('exit_intent')) {
      // 触发了哪种 exit (TAKE_PROFIT / EMERGENCY_STOP / TIMEOUT)，即使 SELL 还在重试也保留
      this.db.exec(`ALTER TABLE positions ADD COLUMN exit_intent TEXT`);
    }
    if (!cols.includes('status')) {
      // 状态：'open' / 'sell_pending' / 'sell_confirming' / 'closed' / 'stuck'
      // 'stuck' 表示重试上限耗尽，需要人工干预
      this.db.exec(`ALTER TABLE positions ADD COLUMN status TEXT DEFAULT 'open'`);
    }
    if (!cols.includes('pending_sell_signature')) {
      // 已提交但未确认落链的 sell tx
      this.db.exec(`ALTER TABLE positions ADD COLUMN pending_sell_signature TEXT`);
    }
    if (!cols.includes('last_retry_at')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN last_retry_at INTEGER`);
    }
    // v3.4: 真实 fee 成本（用于 PnL 计算）
    if (!cols.includes('buy_fee_lamports')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN buy_fee_lamports INTEGER DEFAULT 0`);
    }
    if (!cols.includes('sell_fee_lamports')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN sell_fee_lamports INTEGER DEFAULT 0`);
    }
  }

  _prepareStatements() {
    this.stmts = {
      insertSignal: this.db.prepare(
        `INSERT INTO signals (ts, mint, symbol, kind, sell_sol, price_impact_pct,
                              seller, seller_tx, notes, accepted, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertTrade: this.db.prepare(
        `INSERT INTO trades (position_id, ts, mint, symbol, side, sol_amount,
                             token_amount, price, signature, success, dry_run,
                             reason, latency_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertPosition: this.db.prepare(
        `INSERT INTO positions (position_id, mint, symbol, opened_at,
                                entry_sol, entry_price, token_amount, dry_run,
                                buy_signature, buy_fee_lamports)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      closePosition: this.db.prepare(
        `UPDATE positions
         SET closed_at = ?, exit_price = ?, exit_sol = ?, pnl_sol = ?,
             pnl_pct = ?, exit_reason = ?, sell_signature = ?
         WHERE position_id = ?`,
      ),
      updatePositionAttempt: this.db.prepare(
        `UPDATE positions SET sell_attempts = sell_attempts + 1, last_error = ?,
                              last_retry_at = ?
         WHERE position_id = ?`,
      ),
      // v3.6: BUY 落链后用真实链上数据修正 entry
      updatePositionEntry: this.db.prepare(
        `UPDATE positions
         SET entry_sol = ?, entry_price = ?, token_amount = ?, buy_fee_lamports = ?
         WHERE position_id = ?`,
      ),
      // v3.3: 标记 sell 已提交，等待链上确认
      markSellPending: this.db.prepare(
        `UPDATE positions SET status = 'sell_confirming', pending_sell_signature = ?,
                              exit_intent = COALESCE(exit_intent, ?)
         WHERE position_id = ?`,
      ),
      // v3.3: sell 链上确认失败，回到 sell_pending 状态等下次重试
      markSellFailedPendingRetry: this.db.prepare(
        `UPDATE positions SET status = 'sell_pending', pending_sell_signature = NULL,
                              next_retry_at = ?, last_error = ?,
                              exit_intent = COALESCE(exit_intent, ?)
         WHERE position_id = ?`,
      ),
      // v3.3: 标记 stuck（重试上限耗尽）
      markStuck: this.db.prepare(
        `UPDATE positions SET status = 'stuck', last_error = ?
         WHERE position_id = ?`,
      ),
      // v3.3: 拉所有需要重试的 position（next_retry_at <= now）
      getDuePendingRetries: this.db.prepare(
        `SELECT * FROM positions
         WHERE closed_at IS NULL
           AND status IN ('sell_pending', 'sell_confirming')
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY opened_at ASC`,
      ),
      // v3.3: 拉所有 stuck 的 position（dashboard 展示用）
      getStuckPositions: this.db.prepare(
        `SELECT * FROM positions WHERE status = 'stuck' AND closed_at IS NULL
         ORDER BY opened_at DESC`,
      ),
      getOpenPositions: this.db.prepare(
        `SELECT * FROM positions WHERE closed_at IS NULL ORDER BY opened_at ASC`,
      ),
      getRecentSignals: this.db.prepare(`SELECT * FROM signals ORDER BY ts DESC LIMIT ?`),
      getRecentTrades: this.db.prepare(`SELECT * FROM trades ORDER BY ts DESC LIMIT ?`),
      getRecentPositions: this.db.prepare(`SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?`),
      getSignalsInRange: this.db.prepare(
        `SELECT * FROM signals WHERE ts >= ? AND ts < ? ORDER BY ts ASC`,
      ),
      getTradesInRange: this.db.prepare(
        `SELECT * FROM trades WHERE ts >= ? AND ts < ? ORDER BY ts ASC`,
      ),
      getPositionsInRange: this.db.prepare(
        `SELECT * FROM positions WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at ASC`,
      ),
    };
  }

  logSignal(sig) {
    return this.stmts.insertSignal.run(
      sig.ts || Date.now(),
      sig.mint,
      sig.symbol || null,
      sig.kind,
      sig.sellSol ?? null,
      sig.priceImpactPct ?? null,
      sig.seller || null,
      sig.sellerTx || null,
      sig.notes || null,
      sig.accepted ? 1 : 0,
      sig.rejectReason || null,
    ).lastInsertRowid;
  }

  logTrade(t) {
    return this.stmts.insertTrade.run(
      t.positionId,
      t.ts || Date.now(),
      t.mint,
      t.symbol || null,
      t.side,
      t.solAmount ?? null,
      t.tokenAmount ?? null,
      t.price ?? null,
      t.signature || null,
      t.success ? 1 : 0,
      t.dryRun ? 1 : 0,
      t.reason || null,
      t.latencyMs ?? null,
      t.error || null,
    ).lastInsertRowid;
  }

  openPosition(p) {
    this.stmts.insertPosition.run(
      p.positionId,
      p.mint,
      p.symbol || null,
      p.openedAt || Date.now(),
      p.entrySol ?? null,
      p.entryPrice ?? null,
      p.tokenAmount ?? null,
      p.dryRun ? 1 : 0,
      p.buySignature || null,
      p.buyFeeLamports || 0,
    );
  }

  closePosition(positionId, exit) {
    this.stmts.closePosition.run(
      exit.closedAt || Date.now(),
      exit.exitPrice ?? null,
      exit.exitSol ?? null,
      exit.pnlSol ?? null,
      exit.pnlPct ?? null,
      exit.exitReason || null,
      exit.sellSignature || null,
      positionId,
    );
  }

  recordSellAttempt(positionId, errorMsg) {
    this.stmts.updatePositionAttempt.run(errorMsg || null, Date.now(), positionId);
  }

  // v3.6: BUY 落链后用真实链上 SOL/token 修正 entry（解决 sizeSol vs 实际花费的偏差）
  updatePositionEntry(positionId, entry) {
    this.stmts.updatePositionEntry.run(
      entry.entrySol ?? null,
      entry.entryPrice ?? null,
      entry.tokenAmount ?? null,
      entry.buyFeeLamports ?? 0,
      positionId,
    );
  }

  // v3.3: 标记 sell 已提交、等待链上确认
  markSellPending(positionId, signature, exitIntent) {
    this.stmts.markSellPending.run(signature || null, exitIntent || null, positionId);
  }

  // v3.3: sell 失败，安排下次重试
  markSellFailedPendingRetry(positionId, nextRetryAt, errorMsg, exitIntent) {
    this.stmts.markSellFailedPendingRetry.run(
      nextRetryAt,
      errorMsg || null,
      exitIntent || null,
      positionId,
    );
  }

  // v3.3: 标记 stuck（重试耗尽，等人工处理）
  markStuck(positionId, errorMsg) {
    this.stmts.markStuck.run(errorMsg || null, positionId);
  }

  // v3.3: 拉所有需要重试的 position
  getDuePendingRetries(now = Date.now()) {
    return this.stmts.getDuePendingRetries.all(now);
  }

  getStuckPositions() {
    return this.stmts.getStuckPositions.all();
  }

  // 启动恢复用：拉取所有未平仓的持仓
  getOpenPositions() {
    return this.stmts.getOpenPositions.all();
  }

  getRecentSignals(limit = 100) { return this.stmts.getRecentSignals.all(limit); }
  getRecentTrades(limit = 100) { return this.stmts.getRecentTrades.all(limit); }
  getRecentPositions(limit = 100) { return this.stmts.getRecentPositions.all(limit); }
  getSignalsInRange(s, e) { return this.stmts.getSignalsInRange.all(s, e); }
  getTradesInRange(s, e) { return this.stmts.getTradesInRange.all(s, e); }
  getPositionsInRange(s, e) { return this.stmts.getPositionsInRange.all(s, e); }
}

module.exports = TradeLogger;
