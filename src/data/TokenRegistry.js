'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { PublicKey } = require('@solana/web3.js');
const { config } = require('../config');
const { fetchTokenFullInfo } = require('../utils/tokenMeta');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();

class TokenRegistry {
  constructor() {
    const dbPath = path.resolve(config.storage.dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._initSchema();
    this._prepareStatements();

    // 内存中维护活跃 mint Set，DumpDetector 每 tx 都用，避免 SQLite 查询
    this.activeMintSet = new Set(this.listActive().map((t) => t.mint));
    monitor.set('TokenRegistry.activeCount', this.activeMintSet.size, 'TokenRegistry');
    // 内存中缓存 token 详情（mint → row），避免 getToken 每次走 DB
    this.cache = new Map();
    for (const t of this.listAll()) this.cache.set(t.mint, t);
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        decimals INTEGER,
        fdv REAL,
        market_cap REAL,
        liquidity REAL,
        price REAL,
        pool_address TEXT,
        pool_base_vault TEXT,
        pool_quote_vault TEXT,
        is_active INTEGER DEFAULT 1,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT DEFAULT 'manual',
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(is_active);
    `);
  }

  _prepareStatements() {
    this.stmts = {
      get: this.db.prepare(`SELECT * FROM tokens WHERE mint = ?`),
      listActive: this.db.prepare(
        `SELECT * FROM tokens WHERE is_active = 1 ORDER BY added_at DESC`,
      ),
      listAll: this.db.prepare(`SELECT * FROM tokens ORDER BY added_at DESC`),
      insert: this.db.prepare(
        `INSERT INTO tokens (mint, symbol, name, decimals, fdv, market_cap, liquidity,
                             price, is_active, added_at, updated_at, source, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ),
      update: this.db.prepare(
        `UPDATE tokens
         SET symbol = ?, name = ?, decimals = ?, fdv = ?, market_cap = ?, liquidity = ?,
             price = ?, is_active = 1, updated_at = ?, meta_json = ?
         WHERE mint = ?`,
      ),
      setPool: this.db.prepare(
        `UPDATE tokens
         SET pool_address = COALESCE(?, pool_address),
             pool_base_vault = COALESCE(?, pool_base_vault),
             pool_quote_vault = COALESCE(?, pool_quote_vault),
             updated_at = ?
         WHERE mint = ?`,
      ),
      remove: this.db.prepare(
        `UPDATE tokens SET is_active = 0, updated_at = ? WHERE mint = ?`,
      ),
    };
  }

  /**
   * 校验 mint 地址是否合法的 Solana base58 PublicKey。
   * 抛错则地址不合法。
   */
  static validateMint(mint) {
    if (!mint || typeof mint !== 'string') {
      throw new Error('mint must be non-empty string');
    }
    // PublicKey 构造会校验长度和 base58
    try {
      const pk = new PublicKey(mint);
      if (pk.toBase58() !== mint) {
        throw new Error('mint canonical form mismatch');
      }
    } catch (err) {
      throw new Error(`invalid Solana address: ${err.message}`);
    }
    return true;
  }

  async addToken(mint, { symbol, source = 'manual' } = {}) {
    TokenRegistry.validateMint(mint);

    const existing = this.stmts.get.get(mint);
    let info;
    try {
      info = await fetchTokenFullInfo(mint);
      monitor.inc('TokenRegistry.metaFetchOk', 1, 'TokenRegistry');
    } catch (err) {
      monitor.inc('TokenRegistry.metaFetchFail', 1, 'TokenRegistry');
      monitor.recordError('TokenRegistry', err, { mint, phase: 'fetchTokenFullInfo' });
      console.error(`[TokenRegistry] fetchTokenFullInfo failed for ${mint}: ${err.message}`);
      info = {
        mint,
        symbol: symbol || existing?.symbol || 'UNKNOWN',
        name: existing?.name || 'Unknown',
        decimals: existing?.decimals ?? 6,
        fdv: existing?.fdv ?? null,
        marketCap: existing?.market_cap ?? null,
        liquidity: existing?.liquidity ?? null,
        price: existing?.price ?? null,
      };
    }

    const finalSymbol =
      info.symbol && info.symbol !== 'UNKNOWN' ? info.symbol : symbol || 'UNKNOWN';
    const now = Date.now();

    if (existing) {
      this.stmts.update.run(
        finalSymbol,
        info.name,
        info.decimals,
        info.fdv,
        info.marketCap,
        info.liquidity,
        info.price,
        now,
        JSON.stringify(info),
        mint,
      );
    } else {
      this.stmts.insert.run(
        mint,
        finalSymbol,
        info.name,
        info.decimals,
        info.fdv,
        info.marketCap,
        info.liquidity,
        info.price,
        now,
        now,
        source,
        JSON.stringify(info),
      );
    }

    // 刷新内存缓存
    const fresh = this.stmts.get.get(mint);
    this.cache.set(mint, fresh);
    this.activeMintSet.add(mint);
    monitor.set('TokenRegistry.activeCount', this.activeMintSet.size, 'TokenRegistry');
    return fresh;
  }

  setPoolInfo(mint, { poolAddress, poolBaseVault, poolQuoteVault }) {
    this.stmts.setPool.run(
      poolAddress || null,
      poolBaseVault || null,
      poolQuoteVault || null,
      Date.now(),
      mint,
    );
    const fresh = this.stmts.get.get(mint);
    if (fresh) this.cache.set(mint, fresh);
  }

  removeToken(mint) {
    this.stmts.remove.run(Date.now(), mint);
    this.activeMintSet.delete(mint);
    monitor.set('TokenRegistry.activeCount', this.activeMintSet.size, 'TokenRegistry');
    const fresh = this.stmts.get.get(mint);
    if (fresh) this.cache.set(mint, fresh);
  }

  getToken(mint) {
    // 走内存缓存（pool_address 等会被 setPoolInfo 同步刷新）
    if (this.cache.has(mint)) return this.cache.get(mint);
    const t = this.stmts.get.get(mint);
    if (t) this.cache.set(mint, t);
    return t;
  }

  // 高频访问：DumpDetector 每 tx 都查
  isActive(mint) {
    return this.activeMintSet.has(mint);
  }

  getActiveMintSet() {
    return this.activeMintSet;
  }

  listActive() {
    return this.stmts.listActive.all();
  }

  listAll() {
    return this.stmts.listAll.all();
  }
}

module.exports = TokenRegistry;
