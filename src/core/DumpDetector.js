'use strict';

/**
 * DumpDetector (v2)
 * =================
 * 接收 LaserStream 推送的交易，解析其是否为：
 *   - 涉及监控代币的 swap
 *   - 方向为 SELL（base → SOL）
 *   - 卖出 SOL >= 阈值
 *   - 单笔自身造成 priceImpact <= -10%
 *
 * 关键修复 vs v1：
 * 已知 pool 时直接用 pool_base_vault / pool_quote_vault 的余额变化算价格，
 * 不再用启发式（"账户余额最大的就是池子"）。这是 v1 价格污染 bug 的根因——
 * 当一笔交易涉及多个账户、多跳路由时，启发式会选错账户对，算出虚假价格，
 * 然后被推到 PriceTracker，进而触发假的 TAKE_PROFIT。
 *
 * 解析路径：
 *   1. 优先：tokenRegistry.getToken(mint).pool_base_vault / pool_quote_vault 已知
 *      → 在 preBalances/postBalances 里直接定位这两个账户的变化
 *   2. fallback：如果 pool 信息缺失，跳过此交易（或发 priceTick 时标记为 untrusted）
 *
 * priceTick：仅当 pool 已知时才 emit（保证 PriceTracker 拿到的价格质量）
 */

const EventEmitter = require('events');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('DumpDetector', { staleMs: 120_000, label: 'Dump Detector' });

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_AMM_PROGRAM_ID = config.programs.pumpAmm;

function encodeBase58(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return bs58.encode(value);
  if (value instanceof Uint8Array) return bs58.encode(Buffer.from(value));
  return null;
}

class DumpDetector extends EventEmitter {
  constructor(tokenRegistry) {
    super();
    this.tokenRegistry = tokenRegistry;
  }

  handleTransaction(txMessage) {
    monitor.inc('DumpDetector.txParsed', 1, 'DumpDetector');
    monitor.beat('DumpDetector', 'parse');
    try {
      const parsed = this._parseTx(txMessage);
      if (!parsed) {
        monitor.inc('DumpDetector.parsedNull', 1, 'DumpDetector');
        return;
      }

      // emit priceTick (DumpDetector 只 emit "可信"价格——pool 已知的)
      monitor.inc('DumpDetector.priceTicks', 1, 'DumpDetector');
      this.emit('priceTick', {
        mint: parsed.baseMint,
        price: parsed.priceAfter,
        ts: parsed.ts,
        poolAddress: parsed.poolAddress,
      });

      // 仅卖单进入下游判定
      if (parsed.side !== 'SELL') return;

      const sellSol = parsed.quoteAmount; // 用户得到的 quote (SOL)
      const priceImpactPct = -parsed.priceChangePct; // 转为正数表示跌幅

      const passSize = sellSol >= config.strategy.minSellSol;
      const passImpact = priceImpactPct >= config.strategy.minPriceImpactPct;

      this.emit('sellAnalyzed', {
        mint: parsed.baseMint,
        symbol: parsed.symbol,
        sellSol,
        priceImpactPct,
        passSize,
        passImpact,
        seller: parsed.signer,
        signature: parsed.signature,
        ts: parsed.ts,
        poolAddress: parsed.poolAddress,
        priceAfter: parsed.priceAfter,
        priceBefore: parsed.priceBefore,
      });

      if (passSize && passImpact) {
        monitor.inc('DumpDetector.dumpSignals', 1, 'DumpDetector');
        this.emit('dumpSignal', {
          mint: parsed.baseMint,
          symbol: parsed.symbol,
          sellSol,
          priceImpactPct,
          seller: parsed.signer,
          signature: parsed.signature,
          ts: parsed.ts,
          poolAddress: parsed.poolAddress,
          poolBaseVault: parsed.poolBaseVault,
          poolQuoteVault: parsed.poolQuoteVault,
          priceAfter: parsed.priceAfter,
          priceBefore: parsed.priceBefore,
          baseDecimals: parsed.baseDecimals,
          quoteDecimals: parsed.quoteDecimals,
        });
      }
    } catch (err) {
      monitor.inc('DumpDetector.parseErrors', 1, 'DumpDetector');
      monitor.recordError('DumpDetector', err, {
        signature: this._extractSignature(txMessage?.transaction),
      });
      console.error(`[DumpDetector] parse error: ${err.message}`);
    }
  }

  /**
   * 解析交易，返回 { side, baseMint, quoteAmount, priceChangePct, ... } 或 null。
   *
   * 算法：
   *   1. 在 pre/postTokenBalances 里找属于监控代币的 mint
   *   2. 查 tokenRegistry.getToken(mint).pool_base_vault / pool_quote_vault
   *   3. 在 pre/postTokenBalances 的 accountIndex/owner 里精确定位这两个 vault 的变化
   *   4. 计算 baseBefore/baseAfter/quoteBefore/quoteAfter，得到价格和方向
   */
  _parseTx(txMessage) {
    const tx = txMessage.transaction;
    if (!tx) return null;
    const meta = tx.meta;
    if (!meta || meta.err) return null;

    const signature = this._extractSignature(tx);
    const signer = this._extractSigner(tx);

    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];
    if (preBalances.length === 0 || postBalances.length === 0) return null;

    // 找出涉及的监控代币
    let baseMint = null;
    let baseDecimals = 6;
    for (const b of preBalances) {
      if (this.tokenRegistry.isActive(b.mint)) {
        baseMint = b.mint;
        baseDecimals = b.uiTokenAmount?.decimals ?? 6;
        break;
      }
    }
    if (!baseMint) {
      // 也可能在 post 里出现（极少见的 case，比如 base ATA 是这次新建的）
      for (const b of postBalances) {
        if (this.tokenRegistry.isActive(b.mint)) {
          baseMint = b.mint;
          baseDecimals = b.uiTokenAmount?.decimals ?? 6;
          break;
        }
      }
    }
    if (!baseMint) return null;

    const tokenInfo = this.tokenRegistry.getToken(baseMint);
    if (!tokenInfo) {
      monitor.inc('DumpDetector.noTokenInfo', 1, 'DumpDetector');
      return null;
    }

    // 必须有 pool 信息才解析（否则启发式会带来价格污染，宁可少也不要错）
    const poolBaseVault = tokenInfo.pool_base_vault;
    const poolQuoteVault = tokenInfo.pool_quote_vault;
    if (!poolBaseVault || !poolQuoteVault) {
      monitor.inc('DumpDetector.skippedNoPoolInfo', 1, 'DumpDetector');
      return null;
    }

    // accountKeys (静态 + loaded address)
    const staticKeys = tx.transaction?.message?.accountKeys || [];
    const loadedWritable = meta.loadedWritableAddresses || [];
    const loadedReadonly = meta.loadedReadonlyAddresses || [];
    const allKeys = [
      ...staticKeys.map((k) => encodeBase58(k)),
      ...loadedWritable.map((k) => encodeBase58(k)),
      ...loadedReadonly.map((k) => encodeBase58(k)),
    ];

    // 在 accountKeys 中找 poolBaseVault 和 poolQuoteVault 对应的 accountIndex
    const baseVaultIdx = allKeys.findIndex((k) => k === poolBaseVault);
    const quoteVaultIdx = allKeys.findIndex((k) => k === poolQuoteVault);
    if (baseVaultIdx < 0 || quoteVaultIdx < 0) {
      // 这笔交易没涉及该 pool 的 vault → 可能是别的池子里的同一个代币交易
      // 或是 LP/transfer 类操作。跳过。
      monitor.inc('DumpDetector.poolNotInTx', 1, 'DumpDetector');
      return null;
    }

    // 直接读 base vault 和 quote vault 在 pre/post 的余额
    const baseBefore = this._findBalance(preBalances, baseVaultIdx, baseMint);
    const baseAfter = this._findBalance(postBalances, baseVaultIdx, baseMint);
    const quoteBefore = this._findBalance(preBalances, quoteVaultIdx, WSOL_MINT);
    const quoteAfter = this._findBalance(postBalances, quoteVaultIdx, WSOL_MINT);

    if (
      baseBefore === null ||
      baseAfter === null ||
      quoteBefore === null ||
      quoteAfter === null
    ) {
      // 余额读不到 → 跳过
      monitor.inc('DumpDetector.vaultBalanceMissing', 1, 'DumpDetector');
      return null;
    }

    const poolBaseDelta = baseAfter - baseBefore;
    const poolQuoteDelta = quoteAfter - quoteBefore;

    // 防 0/极小值
    if (
      !Number.isFinite(baseBefore) ||
      !Number.isFinite(baseAfter) ||
      !Number.isFinite(quoteBefore) ||
      !Number.isFinite(quoteAfter) ||
      baseBefore <= 0 ||
      baseAfter <= 0 ||
      quoteBefore <= 0 ||
      quoteAfter <= 0
    ) {
      return null;
    }

    // 价格 = quote / base（每 token 多少 SOL）
    const priceBefore = quoteBefore / baseBefore;
    const priceAfter = quoteAfter / baseAfter;
    if (priceBefore <= 0 || priceAfter <= 0) return null;
    const priceChangePct = ((priceAfter - priceBefore) / priceBefore) * 100;

    // 方向判定（按池子状态变化）
    let side;
    if (poolBaseDelta > 0 && poolQuoteDelta < 0) side = 'SELL';
    else if (poolBaseDelta < 0 && poolQuoteDelta > 0) side = 'BUY';
    else {
      // 不是单纯的 swap（可能是 LP add/remove），跳过
      return null;
    }

    const quoteAmount = Math.abs(poolQuoteDelta);

    return {
      signature,
      signer,
      ts: Date.now(),
      side,
      baseMint,
      baseDecimals,
      quoteDecimals: 9,
      symbol: tokenInfo.symbol || null,
      quoteAmount,
      priceBefore,
      priceAfter,
      priceChangePct,
      poolAddress: tokenInfo.pool_address,
      poolBaseVault,
      poolQuoteVault,
    };
  }

  /**
   * 在 balances 数组里找指定 accountIndex + mint 的余额。
   * 返回 ui 数额（float），找不到返回 null。
   */
  _findBalance(balances, accountIndex, expectedMint) {
    for (const b of balances) {
      if (b.accountIndex !== accountIndex) continue;
      if (expectedMint && b.mint !== expectedMint) continue;
      const ui = b.uiTokenAmount;
      if (!ui) return null;
      // uiAmountString 比 uiAmount 更精确（不丢精度）
      const v = parseFloat(ui.uiAmountString || ui.uiAmount || '0');
      if (!Number.isFinite(v)) return null;
      return v;
    }
    return null;
  }

  _extractSignature(tx) {
    try {
      const sig = tx?.transaction?.signatures?.[0];
      return encodeBase58(sig);
    } catch (_) {
      return null;
    }
  }

  _extractSigner(tx) {
    try {
      const accountKeys = tx?.transaction?.message?.accountKeys || [];
      return encodeBase58(accountKeys[0]);
    } catch (_) {
      return null;
    }
  }
}

module.exports = DumpDetector;
module.exports.PUMP_AMM_PROGRAM_ID = PUMP_AMM_PROGRAM_ID;
