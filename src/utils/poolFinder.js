'use strict';

/**
 * PoolFinder
 * ==========
 * 自动找出某个代币在 Pump.fun AMM 上对应的 pool / base_vault / quote_vault。
 *
 * 方法：
 *   1. 用 Helius Enhanced Transaction API 拿这个代币最近的 SWAP 交易（5-10 笔）
 *   2. 在每笔交易的 tokenTransfers 或 events 里找 Pump.fun AMM 程序参与的部分
 *   3. 提取 pool 地址（指令 accountKeys[0]）和两个 vault 地址
 *   4. 多笔交叉验证：取出现频率最高的（防止偶发的多池子代币选错）
 *
 * 这是个一次性工具，写库后不再调用。如果失败（比如代币太冷门没历史交易），
 * 调用方应该把代币标记为 pool_pending，跳过其 dumpSignal 直到补上。
 */

const axios = require('axios');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();

const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

class PoolFinder {
  constructor({ rpcUrl, apiKey }) {
    this.rpcUrl = rpcUrl || config.helius.rpcUrl;
    this.apiKey = apiKey || config.helius.apiKey;
  }

  /**
   * 找一个代币的 pool 信息。
   * @param {string} mint
   * @returns {Promise<{poolAddress, poolBaseVault, poolQuoteVault, sourceTx} | null>}
   */
  async findPoolForMint(mint) {
    if (!this.apiKey) {
      throw new Error('HELIUS_API_KEY required for PoolFinder');
    }

    // 1. 拿最近的几笔交易签名
    const sigs = await this._getRecentSignatures(mint, 15);
    if (sigs.length === 0) {
      monitor.inc('PoolFinder.noSignatures', 1, 'PoolFinder');
      return null;
    }

    // 2. 用 Enhanced Tx API 解析
    const parsedTxs = await this._parseTransactions(sigs);
    if (parsedTxs.length === 0) {
      monitor.inc('PoolFinder.noEnhancedData', 1, 'PoolFinder');
      return null;
    }

    // 3. 在每笔交易里找 Pump AMM 指令 + 提取 pool/vault
    const candidates = new Map(); // poolAddress → { count, baseVault, quoteVault, sigs[] }
    for (const tx of parsedTxs) {
      const found = this._extractPoolFromTx(tx, mint);
      if (!found) continue;
      const key = found.poolAddress;
      let entry = candidates.get(key);
      if (!entry) {
        entry = { count: 0, baseVault: found.poolBaseVault, quoteVault: found.poolQuoteVault, sigs: [] };
        candidates.set(key, entry);
      }
      entry.count += 1;
      entry.sigs.push(tx.signature);
    }

    if (candidates.size === 0) {
      monitor.inc('PoolFinder.noPoolFound', 1, 'PoolFinder');
      return null;
    }

    // 4. 取出现次数最多的池子
    let best = null;
    for (const [pool, entry] of candidates.entries()) {
      if (!best || entry.count > best.count) {
        best = { poolAddress: pool, ...entry };
      }
    }

    monitor.inc('PoolFinder.poolFound', 1, 'PoolFinder');
    return {
      poolAddress: best.poolAddress,
      poolBaseVault: best.baseVault,
      poolQuoteVault: best.quoteVault,
      sourceTx: best.sigs[0],
      occurrences: best.count,
    };
  }

  async _getRecentSignatures(mint, limit) {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [mint, { limit }],
    };
    const { data } = await axios.post(this.rpcUrl, body, { timeout: 8000 });
    if (data.error) throw new Error(`getSignaturesForAddress: ${JSON.stringify(data.error)}`);
    return (data.result || []).map((r) => r.signature);
  }

  async _parseTransactions(signatures) {
    // Helius Enhanced Tx API：POST /v0/transactions?api-key=...
    const url = `https://api.helius.xyz/v0/transactions?api-key=${this.apiKey}`;
    const out = [];
    // 单次最多 100 个
    const batches = [];
    for (let i = 0; i < signatures.length; i += 100) {
      batches.push(signatures.slice(i, i + 100));
    }
    for (const batch of batches) {
      try {
        const { data } = await axios.post(url, { transactions: batch }, { timeout: 15000 });
        for (const t of data) out.push(t);
      } catch (err) {
        monitor.recordError('PoolFinder', err, { phase: 'parseTransactions' });
        // 不阻塞，继续尝试下一批
      }
    }
    return out;
  }

  /**
   * 从一笔 enhanced transaction 里找 pump.fun AMM swap 涉及的 pool / base vault / quote vault。
   *
   * Enhanced API 返回结构含：
   *   - instructions: [{ programId, accounts: [...], data, innerInstructions: [...] }]
   *   - tokenTransfers: [{ fromUserAccount, toUserAccount, fromTokenAccount, toTokenAccount, mint, tokenAmount }]
   *
   * 找 pump_amm 程序的指令，accounts[0] = pool；从 tokenTransfers 找
   * mint == 我们的 mint 的 toTokenAccount（base vault）和 mint == WSOL 的 fromTokenAccount（quote vault）
   */
  _extractPoolFromTx(tx, mint) {
    const allInstructions = [];
    if (Array.isArray(tx.instructions)) {
      for (const ix of tx.instructions) {
        allInstructions.push(ix);
        if (Array.isArray(ix.innerInstructions)) {
          for (const inner of ix.innerInstructions) allInstructions.push(inner);
        }
      }
    }

    // 找 pump.fun AMM 调用
    let pumpIx = null;
    for (const ix of allInstructions) {
      if (ix.programId === PUMP_AMM_PROGRAM && Array.isArray(ix.accounts) && ix.accounts.length > 0) {
        pumpIx = ix;
        break;
      }
    }
    if (!pumpIx) return null;
    const poolAddress = pumpIx.accounts[0];

    // 从 tokenTransfers 里找两个 vault
    let baseVault = null;
    let quoteVault = null;

    const transfers = tx.tokenTransfers || [];
    for (const t of transfers) {
      // pumpAmm 在 swap 时会有两笔 transfer：
      //   user → pool base vault (mint)
      //   pool quote vault → user (WSOL)
      // 或反向。
      if (t.mint === mint) {
        // 这笔 transfer 涉及到我们的代币，目标 token account 是 vault 的候选
        // 优先取 toTokenAccount 不是 user wallet 的（pool 不是 user 自己）
        if (t.toTokenAccount && !this._isUserAccount(t.toUserAccount, tx)) {
          baseVault = t.toTokenAccount;
        } else if (t.fromTokenAccount && !this._isUserAccount(t.fromUserAccount, tx)) {
          baseVault = t.fromTokenAccount;
        }
      } else if (t.mint === WSOL) {
        if (t.fromTokenAccount && !this._isUserAccount(t.fromUserAccount, tx)) {
          quoteVault = t.fromTokenAccount;
        } else if (t.toTokenAccount && !this._isUserAccount(t.toUserAccount, tx)) {
          quoteVault = t.toTokenAccount;
        }
      }
    }

    // fallback: 通过 accountKeys 在 pumpIx.accounts 里找
    // pump amm 的账户布局通常是 [pool, user, ..., poolBaseVault, poolQuoteVault, ...]
    // 但布局会变，用 transfers 优先，accounts 兜底
    if (!baseVault || !quoteVault) {
      // 尝试在 accountData 里通过 mint 匹配
      const accountData = tx.accountData || [];
      for (const ad of accountData) {
        const tbcs = ad.tokenBalanceChanges || [];
        for (const tbc of tbcs) {
          if (tbc.mint === mint && !baseVault) baseVault = ad.account;
          else if (tbc.mint === WSOL && !quoteVault) quoteVault = ad.account;
        }
      }
    }

    if (!baseVault || !quoteVault) return null;

    return { poolAddress, poolBaseVault: baseVault, poolQuoteVault: quoteVault };
  }

  _isUserAccount(account, tx) {
    // 简单：feePayer 通常是用户。tx.feePayer 在 enhanced API 里有
    return account && account === tx.feePayer;
  }
}

module.exports = PoolFinder;
