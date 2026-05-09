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
                                buy_signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      closePosition: this.db.prepare(
        `UPDATE positions
         SET closed_at = ?, exit_price = ?, exit_sol = ?, pnl_sol = ?,
             pnl_pct = ?, exit_reason = ?, sell_signature = ?
         WHERE position_id = ?`,
      ),
      updatePositionAttempt: this.db.prepare(
        `UPDATE positions SET sell_attempts = sell_attempts + 1, last_error = ?
         WHERE position_id = ?`,
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
    this.stmts.updatePositionAttempt.run(errorMsg || null, positionId);
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
