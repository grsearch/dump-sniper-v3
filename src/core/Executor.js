'use strict';

/**
 * Executor (v3.1)
 * ===============
 * 直接调用 Pump.fun AMM (PumpSwap) 程序，不走 Jupiter aggregator。
 *
 * v3.1 vs v3.0 修复：
 *   - 修正 SDK API：旧的 swapAutocompleteBaseFromQuote/swapInstructions/Direction 已移除
 *     新 API: OnlinePumpAmmSdk.swapSolanaState(poolKey, user) + buyQuoteInput / sellBaseInput
 *   - 新增 blockhash 预缓存（每 5s 后台刷新），下单时直接用，省 ~30ms RPC
 *   - 新增 Sell 路径并发：链上余额查询 + swapSolanaState 并行
 *
 * SDK 调用流程：
 *   Buy:  OnlinePumpAmmSdk.swapSolanaState(poolKey, user) → state
 *         PumpAmmSdk.buyQuoteInput(state, quoteIn, slippagePct) → ix[]
 *   Sell: OnlinePumpAmmSdk.swapSolanaState(poolKey, user) → state
 *         PumpAmmSdk.sellBaseInput(state, baseIn, slippagePct) → ix[]
 */

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} = require('@solana/web3.js');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const BN = require('bn.js');

const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('Executor', { staleMs: 24 * 60 * 60_000, label: 'Trade Executor' });

class Executor {
  constructor() {
    this.dryRun = config.DRY_RUN;
    this.rpc = new Connection(config.helius.rpcUrl, 'confirmed');
    this.stakedRpc = config.helius.stakedRpcUrl
      ? new Connection(config.helius.stakedRpcUrl, 'confirmed')
      : this.rpc;
    this.senderEndpoint = config.helius.senderEndpoint || null;

    if (!this.dryRun && config.wallet.privateKeyBs58) {
      const secret = bs58.decode(config.wallet.privateKeyBs58);
      this.keypair = Keypair.fromSecretKey(secret);
      console.log(`[Executor] wallet loaded: ${this.keypair.publicKey.toBase58()}`);
    } else {
      this.keypair = null;
    }

    // SDK 在 LIVE 模式才需要
    this.pumpSdk = null;       // PumpAmmSdk（指令构造）
    this.onlineSdk = null;     // OnlinePumpAmmSdk（state 拉取）
    if (!this.dryRun) {
      try {
        const pumpModule = require('@pump-fun/pump-swap-sdk');
        const { PumpAmmSdk, OnlinePumpAmmSdk } = pumpModule;
        if (!PumpAmmSdk || !OnlinePumpAmmSdk) {
          throw new Error('SDK exports missing PumpAmmSdk / OnlinePumpAmmSdk');
        }
        this.pumpSdk = new PumpAmmSdk();
        this.onlineSdk = new OnlinePumpAmmSdk(this.stakedRpc);
        console.log('[Executor] Pump AMM SDK loaded (PumpAmmSdk + OnlinePumpAmmSdk)');
      } catch (err) {
        console.error(`[Executor] failed to load @pump-fun/pump-swap-sdk: ${err.message}`);
      }
    }

    this.maxPriorityFeeLamports = config.maxPriorityFeeLamports;
    this.computeUnitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '200000', 10);

    // v3.5: 通过 setPoolStateCache 由外部注入（避免循环依赖 TokenRegistry）
    this.poolStateCache = null;

    // ============ Priority fee oracle ============
    const PriorityFeeOracle = require('../utils/priorityFeeOracle');
    this.feeOracle = new PriorityFeeOracle();
    if (config.priorityFee.dynamic) {
      console.log(
        `[Executor] priority fee: dynamic (BUY=${config.priorityFee.buyLevel}, SELL=${config.priorityFee.sellLevel})`
      );
      console.log(
        `[Executor] BUY range: [${config.priorityFee.buyMinLamports} - ${config.priorityFee.buyCapLamports}] lamports`
      );
      console.log(
        `[Executor] SELL range: [${config.priorityFee.sellMinLamports} - ${config.priorityFee.sellCapLamports}] lamports`
      );
    } else {
      console.log(
        `[Executor] priority fee: static (BUY=${config.priorityFee.buyMaxLamports}, SELL=${config.priorityFee.sellMaxLamports})`
      );
    }

    // ============ Blockhash 预缓存 ============
    // 每 5s 后台拉一次 latestBlockhash，下单时直接用，省 ~30ms RPC
    // Solana blockhash 有效期 ~150 个 slot ≈ 60s，5s 缓存非常安全
    this._cachedBlockhash = null;
    this._cachedBlockhashAt = 0;
    this._blockhashTimer = null;
    if (!this.dryRun) {
      this._startBlockhashCache();
    }
  }

  _startBlockhashCache() {
    const refresh = async () => {
      try {
        const t0 = Date.now();
        const bh = await this.rpc.getLatestBlockhash('confirmed');
        this._cachedBlockhash = bh;
        this._cachedBlockhashAt = Date.now();
        monitor.set('Executor.blockhashAgeMs', 0, 'Executor');
        monitor.inc('Executor.blockhashRefreshOk', 1, 'Executor');
      } catch (err) {
        monitor.recordError('Executor', err, { phase: 'blockhash_refresh' });
      }
    };
    // 立即拉一次
    refresh();
    // 每 5s 刷新
    this._blockhashTimer = setInterval(refresh, 5000);
  }

  stop() {
    if (this._blockhashTimer) {
      clearInterval(this._blockhashTimer);
      this._blockhashTimer = null;
    }
    if (this.poolStateCache) {
      this.poolStateCache.stop();
    }
    if (this.feeOracle && this.feeOracle.stop) {
      this.feeOracle.stop();
    }
  }

  /**
   * v3.5: 注入 PoolStateCache，BUY/SELL 路径将优先读缓存
   */
  setPoolStateCache(cache) {
    this.poolStateCache = cache;
  }

  /**
   * 取缓存 blockhash；如果太旧（>30s）或没有，同步拉一次。
   */
  async _getBlockhash() {
    const age = Date.now() - this._cachedBlockhashAt;
    if (this._cachedBlockhash && age < 30_000) {
      monitor.set('Executor.blockhashAgeMs', age, 'Executor');
      return this._cachedBlockhash;
    }
    // 缓存过期或没有，同步拉
    monitor.inc('Executor.blockhashCacheMiss', 1, 'Executor');
    const bh = await this.rpc.getLatestBlockhash('confirmed');
    this._cachedBlockhash = bh;
    this._cachedBlockhashAt = Date.now();
    return bh;
  }

  /**
   * 用 Helius Sender (推荐 fra-sender.helius-rpc.com/fast 同区域) 或 staked RPC 提交交易。
   */
  async _submitTx(serialized) {
    if (this.senderEndpoint) {
      try {
        const axios = require('axios');
        const body = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [
            Buffer.from(serialized).toString('base64'),
            { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
          ],
        };
        const { data } = await axios.post(this.senderEndpoint, body, { timeout: 5000 });
        if (data.error) throw new Error(`Sender error: ${JSON.stringify(data.error)}`);
        return data.result;
      } catch (err) {
        monitor.inc('Executor.senderFallback', 1, 'Executor');
        console.warn(`[Executor] Helius Sender failed, fallback to staked: ${err.message}`);
      }
    }
    return await this.stakedRpc.sendRawTransaction(serialized, {
      skipPreflight: true,
      maxRetries: 0,
    });
  }

  /**
   * 等待 tx 落链确认。返回 { confirmed: bool, error?: string, slot?: number }
   * - confirmed=true 表示链上落链且无 err（等同 SUCCESS）
   * - confirmed=false 且 error='not_landed' 表示超时未找到 tx（被丢弃）
   * - confirmed=false 且 error 是错误原因 表示 tx 落链但执行报错
   *
   * 用 polling getSignatureStatuses，比 confirmTransaction 更快、更可控。
   */
  async confirmTx(signature, { timeoutMs = 12_000, pollIntervalMs = 800 } = {}) {
    if (!signature || signature.startsWith('DRYRUN')) {
      return { confirmed: true, slot: null }; // DRY_RUN 自动算成功
    }
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const { value } = await this.rpc.getSignatureStatuses([signature], {
          searchTransactionHistory: false,
        });
        const status = value?.[0];
        if (status) {
          if (status.err) {
            return {
              confirmed: false,
              error: typeof status.err === 'string' ? status.err : JSON.stringify(status.err),
              slot: status.slot,
            };
          }
          // confirmationStatus: 'processed' | 'confirmed' | 'finalized'
          if (status.confirmationStatus === 'confirmed' ||
              status.confirmationStatus === 'finalized' ||
              status.confirmations !== null) {
            return { confirmed: true, slot: status.slot };
          }
          // status='processed' 还需要再等等
        }
      } catch (err) {
        // 单次查询失败不要紧，继续 poll
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return { confirmed: false, error: 'not_landed' };
  }

  /**
   * 查询钱包对某 mint 的实际持币（uiAmount）。给 reconciliation 用。
   */
  async getWalletTokenBalance(mint) {
    if (!this.keypair) return 0;
    try {
      return await this._getRealOnchainTokenAmount(mint, 6);
    } catch (_) {
      return 0;
    }
  }

  /**
   * v3.6: 解析已落链 tx 的真实成交结果。
   * 用于 BUY 后回写 position 的真实 entrySol（避免 sizeSol vs 实际花费的差异）。
   *
   * 返回 { realSolDelta, realTokenDelta, fee, success } 或 null（tx 未找到）
   *   realSolDelta:  钱包 SOL 净变化（负数 = 花了多少 SOL，含 priority fee）
   *   realTokenDelta: 钱包对应 mint 净变化（正数 = 收到多少 token UI amount）
   *   fee:            tx 的 base fee（lamports）
   */
  async fetchTxSwapResult(signature, mint) {
    if (!signature || signature.startsWith('DRYRUN')) return null;
    if (!this.keypair) return null;
    try {
      const tx = await this.rpc.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.meta) return null;

      const owner = this.keypair.publicKey.toBase58();

      // SOL 净变化
      // accountKeys 顺序与 preBalances/postBalances 一致
      const keys = tx.transaction.message.accountKeys || tx.transaction.message.staticAccountKeys || [];
      const ownerIdx = keys.findIndex((k) => {
        const s = typeof k === 'string' ? k : k.pubkey || k.toString?.();
        return s === owner;
      });
      let realSolDelta = 0;
      if (ownerIdx >= 0) {
        const pre = tx.meta.preBalances[ownerIdx] || 0;
        const post = tx.meta.postBalances[ownerIdx] || 0;
        realSolDelta = (post - pre) / 1e9; // SOL
      }

      // Token 净变化（对应 mint）
      let realTokenDelta = 0;
      const preTok = tx.meta.preTokenBalances || [];
      const postTok = tx.meta.postTokenBalances || [];
      for (const post of postTok) {
        if (post.owner !== owner || post.mint !== mint) continue;
        const pre = preTok.find((p) => p.accountIndex === post.accountIndex);
        const preUi = pre?.uiTokenAmount?.uiAmount || 0;
        const postUi = post.uiTokenAmount?.uiAmount || 0;
        realTokenDelta += postUi - preUi;
      }
      // 也要检查 pre 里有但 post 里没有的（账户被关闭的场景）
      for (const pre of preTok) {
        if (pre.owner !== owner || pre.mint !== mint) continue;
        const inPost = postTok.find((p) => p.accountIndex === pre.accountIndex);
        if (!inPost) {
          const preUi = pre.uiTokenAmount?.uiAmount || 0;
          realTokenDelta -= preUi;
        }
      }

      return {
        realSolDelta,
        realTokenDelta,
        fee: tx.meta.fee || 0,
        computeUnitsConsumed: tx.meta.computeUnitsConsumed || 0,
        success: !tx.meta.err,
      };
    } catch (err) {
      monitor.recordError('Executor', err, { phase: 'fetchTxSwapResult', signature });
      return null;
    }
  }

  /**
   * 构造、签名 tx。Side ('BUY' or 'SELL') 决定使用哪个 priority fee 等级。
   */
  async _buildAndSignTx(swapInstructions, side) {
    const blockhash = await this._getBlockhash();

    // v3.8: oracle.estimate 现在是同步调用（内存读，永不阻塞）
    const fee = this.feeOracle.estimate(side);
    monitor.set(`Executor.last${side}FeeLamports`, fee.totalLamports, 'Executor');

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
    ];
    if (fee.microLamportsPerCu > 0) {
      ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee.microLamportsPerCu }));
    }

    for (const ix of swapInstructions) ixs.push(ix);

    const message = new TransactionMessage({
      payerKey: this.keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.keypair]);
    return { serialized: tx.serialize(), feeInfo: fee };
  }

  /**
   * 买入：SOL → token，固定 SOL 输入。
   */
  async buy(order) {
    const t0 = Date.now();
    monitor.inc('Executor.buyAttempts', 1, 'Executor');
    monitor.beat('Executor', `buy:${(order.mint || '').slice(0, 6)}`);

    const sizeSol = order.sizeSol || config.strategy.positionSizeSol;
    const baseDecimals = order.baseDecimals ?? 6;

    // ============ DRY_RUN ============
    if (this.dryRun) {
      const fillPrice = (order.priceAfter || 0) * 1.005;
      if (fillPrice <= 0) {
        monitor.inc('Executor.buyFail', 1, 'Executor');
        return {
          success: false,
          error: 'invalid priceAfter for DRY_RUN',
          latencyMs: Date.now() - t0,
        };
      }
      const tokenAmount = sizeSol / fillPrice;
      console.log(
        `[Executor:DRY_RUN] BUY ${order.symbol || order.mint.slice(0, 6)}: ` +
          `${sizeSol} SOL → ${tokenAmount.toFixed(2)} tokens @ ${fillPrice.toExponential(4)}`,
      );
      monitor.inc('Executor.buySuccess', 1, 'Executor');
      return {
        success: true,
        signature: `DRYRUN_BUY_${Date.now()}`,
        tokenAmount,
        solIn: sizeSol,
        price: fillPrice,
        latencyMs: Date.now() - t0,
        dryRun: true,
      };
    }

    // ============ LIVE ============
    if (!this.keypair) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('wallet not loaded'), {
        side: 'BUY',
        mint: order.mint,
      });
      return { success: false, error: 'wallet not loaded', latencyMs: Date.now() - t0 };
    }
    if (!this.pumpSdk || !this.onlineSdk) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      return {
        success: false,
        error: '@pump-fun/pump-swap-sdk not loaded',
        latencyMs: Date.now() - t0,
      };
    }
    if (!order.poolAddress) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      return {
        success: false,
        error: 'poolAddress missing — run fill-pools',
        latencyMs: Date.now() - t0,
      };
    }

    try {
      const poolKey = new PublicKey(order.poolAddress);
      const sizeLamportsBN = new BN(Math.floor(sizeSol * 1e9));
      // SDK 接受 slippage 作为 percent 数（1% 写 1，不是 0.01）
      const slippagePct = config.strategy.buySlippageBps / 100;

      // 1. 拉 pool state — v3.5 优先读缓存（PoolStateCache 后台预热）
      const tS0 = Date.now();
      let swapState = null;
      let stateSource = 'rpc';
      if (this.poolStateCache) {
        swapState = this.poolStateCache.get(order.poolAddress);
        if (swapState) {
          stateSource = 'cache';
          const age = this.poolStateCache.getAge(order.poolAddress);
          monitor.set('Executor.lastCacheAgeMs', age || 0, 'Executor');
        }
      }
      if (!swapState) {
        // cache miss：第一次抓取或 cache 失效；走同步 RPC
        swapState = await this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey);
        monitor.inc('Executor.cacheMiss', 1, 'Executor');
      } else {
        monitor.inc('Executor.cacheHit', 1, 'Executor');
      }
      const stateLatencyMs = Date.now() - tS0;
      monitor.inc('Executor.stateOk', 1, 'Executor');
      monitor.set('Executor.lastStateLatencyMs', stateLatencyMs, 'Executor');

      // 2. 构造 buy 指令（quote→base 方向）
      const tB0 = Date.now();
      const buyResult = await this.pumpSdk.buyQuoteInput(swapState, sizeLamportsBN, slippagePct);
      const buildLatencyMs = Date.now() - tB0;

      const swapIxs = this._extractInstructions(buyResult);
      if (!swapIxs || swapIxs.length === 0) {
        throw new Error('SDK buyQuoteInput returned no instructions');
      }

      // 估算 token 数量（用 SDK 的内部算法）
      const baseRaw = this._extractBaseAmount(buyResult, swapState, sizeLamportsBN, 'buy');
      const tokenAmount = Number(baseRaw) / Math.pow(10, baseDecimals);
      const realPrice = tokenAmount > 0 ? sizeSol / tokenAmount : 0;

      // 3. 构造、签名、提交
      const { serialized, feeInfo } = await this._buildAndSignTx(swapIxs, 'BUY');

      const tSend0 = Date.now();
      const sig = await this._submitTx(serialized);
      const sendLatencyMs = Date.now() - tSend0;
      monitor.inc('Executor.buySuccess', 1, 'Executor');

      console.log(
        `[Executor:LIVE] BUY submitted: ${(sig || '').slice(0, 8)}.. ` +
          `(state=${stateLatencyMs}ms[${stateSource}] build=${buildLatencyMs}ms send=${sendLatencyMs}ms total=${
            Date.now() - t0
          }ms, fee=${feeInfo.totalLamports}L ${feeInfo.source})`,
      );

      return {
        success: true,
        signature: sig,
        tokenAmount,
        solIn: sizeSol,
        price: realPrice,
        latencyMs: Date.now() - t0,
        stateLatencyMs,
        buildLatencyMs,
        priorityFeeLamports: feeInfo.totalLamports,
        priorityFeeSource: feeInfo.source,
        sendLatencyMs,
      };
    } catch (err) {
      monitor.inc('Executor.buyFail', 1, 'Executor');
      monitor.recordError('Executor', err, {
        side: 'BUY',
        mint: order.mint,
        symbol: order.symbol,
        sizeSol,
      });
      console.error(`[Executor:LIVE] BUY failed: ${err.message}`);
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  /**
   * 卖出：token → SOL，固定 token 输入。
   */
  async sell(order) {
    const t0 = Date.now();
    monitor.inc('Executor.sellAttempts', 1, 'Executor');
    monitor.beat('Executor', `sell:${(order.mint || '').slice(0, 6)}`);

    const baseDecimals = order.baseDecimals ?? 6;
    const tokenAmount = order.tokenAmount;
    const currentPrice = order.currentPrice;

    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', new Error('invalid tokenAmount'), {
        side: 'SELL',
        mint: order.mint,
        tokenAmount,
      });
      return { success: false, error: 'invalid tokenAmount', latencyMs: Date.now() - t0 };
    }

    // ============ DRY_RUN ============
    if (this.dryRun) {
      const fillPrice = currentPrice * 0.995;
      const solOut = tokenAmount * fillPrice;
      console.log(
        `[Executor:DRY_RUN] SELL ${order.symbol || order.mint.slice(0, 6)}: ` +
          `${tokenAmount.toFixed(2)} tokens → ${solOut.toFixed(4)} SOL @ ${fillPrice.toExponential(4)}`,
      );
      monitor.inc('Executor.sellSuccess', 1, 'Executor');
      return {
        success: true,
        signature: `DRYRUN_SELL_${Date.now()}`,
        solOut,
        price: fillPrice,
        latencyMs: Date.now() - t0,
        dryRun: true,
      };
    }

    // ============ LIVE ============
    if (!this.keypair) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      return { success: false, error: 'wallet not loaded', latencyMs: Date.now() - t0 };
    }
    if (!this.pumpSdk || !this.onlineSdk) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      return {
        success: false,
        error: '@pump-fun/pump-swap-sdk not loaded',
        latencyMs: Date.now() - t0,
      };
    }
    if (!order.poolAddress) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      return {
        success: false,
        error: 'poolAddress missing',
        latencyMs: Date.now() - t0,
      };
    }

    try {
      const poolKey = new PublicKey(order.poolAddress);

      // 1. 并发拉链上余额 + pool state
      const tS0 = Date.now();
      const [onchainAmount, swapState] = await Promise.all([
        this._getRealOnchainTokenAmount(order.mint, baseDecimals),
        this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey),
      ]);
      const stateLatencyMs = Date.now() - tS0;
      monitor.inc('Executor.stateOk', 1, 'Executor');
      monitor.set('Executor.lastStateLatencyMs', stateLatencyMs, 'Executor');

      const sellAmount = Math.min(tokenAmount, onchainAmount > 0 ? onchainAmount : tokenAmount);
      const sellAmountRaw = Math.floor(sellAmount * Math.pow(10, baseDecimals));
      if (sellAmountRaw <= 0) {
        monitor.inc('Executor.sellFail', 1, 'Executor');
        return {
          success: false,
          error: 'no on-chain balance to sell',
          latencyMs: Date.now() - t0,
        };
      }

      const sellAmountBN = new BN(sellAmountRaw);
      const slippagePct = config.strategy.sellSlippageBps / 100;

      // 2. 构造 sell 指令（base→quote 方向）
      const tB0 = Date.now();
      const sellResult = await this.pumpSdk.sellBaseInput(swapState, sellAmountBN, slippagePct);
      const buildLatencyMs = Date.now() - tB0;

      const swapIxs = this._extractInstructions(sellResult);
      if (!swapIxs || swapIxs.length === 0) {
        throw new Error('SDK sellBaseInput returned no instructions');
      }

      // 估算预期 SOL out
      const quoteRaw = this._extractQuoteAmount(sellResult, swapState, sellAmountBN, 'sell');
      const expectedSolOut = Number(quoteRaw) / 1e9;
      const realPrice = sellAmount > 0 ? expectedSolOut / sellAmount : 0;

      // 3. 构造、签名、提交
      const { serialized, feeInfo } = await this._buildAndSignTx(swapIxs, 'SELL');

      const tSend0 = Date.now();
      const sig = await this._submitTx(serialized);
      const sendLatencyMs = Date.now() - tSend0;
      monitor.inc('Executor.sellSuccess', 1, 'Executor');

      console.log(
        `[Executor:LIVE] SELL submitted: ${(sig || '').slice(0, 8)}.. ` +
          `(state=${stateLatencyMs}ms build=${buildLatencyMs}ms send=${sendLatencyMs}ms total=${
            Date.now() - t0
          }ms, fee=${feeInfo.totalLamports}L ${feeInfo.source})`,
      );

      return {
        success: true,
        signature: sig,
        solOut: expectedSolOut,
        price: realPrice,
        latencyMs: Date.now() - t0,
        stateLatencyMs,
        buildLatencyMs,
        sendLatencyMs,
        priorityFeeLamports: feeInfo.totalLamports,
        priorityFeeSource: feeInfo.source,
      };
    } catch (err) {
      monitor.inc('Executor.sellFail', 1, 'Executor');
      monitor.recordError('Executor', err, {
        side: 'SELL',
        mint: order.mint,
        symbol: order.symbol,
        tokenAmount,
      });
      console.error(`[Executor:LIVE] SELL failed: ${err.message}`);
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  async _getRealOnchainTokenAmount(mint, decimals) {
    try {
      const owner = this.keypair.publicKey;
      const resp = await this.rpc.getParsedTokenAccountsByOwner(
        owner,
        { mint: new PublicKey(mint) },
        'confirmed',
      );
      let total = 0;
      for (const acc of resp.value) {
        const ui = acc.account.data.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof ui === 'number') total += ui;
      }
      return total;
    } catch (err) {
      monitor.recordError('Executor', err, { phase: 'onchain_balance', mint });
      return 0;
    }
  }

  /**
   * SDK 不同版本返回结构不同。统一处理：
   *   - 数组 → 直接是 instructions
   *   - 对象有 .instructions → 取出
   *   - 对象有 .ixs → 取出
   *   - 单个 instruction 对象 → 包成数组
   */
  _extractInstructions(sdkResult) {
    if (!sdkResult) return null;
    if (Array.isArray(sdkResult)) return sdkResult;
    if (Array.isArray(sdkResult.instructions)) return sdkResult.instructions;
    if (Array.isArray(sdkResult.ixs)) return sdkResult.ixs;
    if (sdkResult.programId && sdkResult.keys) return [sdkResult];
    return null;
  }

  _extractBaseAmount(sdkResult, state, fallbackQuoteIn, side) {
    if (sdkResult && sdkResult.base) return BigInt(sdkResult.base.toString());
    if (sdkResult && sdkResult.baseAmount) return BigInt(sdkResult.baseAmount.toString());
    if (sdkResult && sdkResult.uiBase != null) {
      return BigInt(Math.floor(Number(sdkResult.uiBase) * 1e6));
    }
    // fallback：用 constant product 公式估算（不精确，仅用于显示）
    try {
      const baseReserve = BigInt(state.poolBaseAmount.toString());
      const quoteReserve = BigInt(state.poolQuoteAmount.toString());
      const quoteIn = BigInt(fallbackQuoteIn.toString());
      const k = baseReserve * quoteReserve;
      const newQuote = quoteReserve + quoteIn;
      const newBase = k / newQuote;
      const baseOut = baseReserve - newBase;
      return baseOut > 0n ? baseOut : 0n;
    } catch (_) {
      return 0n;
    }
  }

  _extractQuoteAmount(sdkResult, state, fallbackBaseIn, side) {
    if (sdkResult && sdkResult.quote) return BigInt(sdkResult.quote.toString());
    if (sdkResult && sdkResult.quoteAmount) return BigInt(sdkResult.quoteAmount.toString());
    if (sdkResult && sdkResult.uiQuote != null) {
      return BigInt(Math.floor(Number(sdkResult.uiQuote) * 1e9));
    }
    // fallback
    try {
      const baseReserve = BigInt(state.poolBaseAmount.toString());
      const quoteReserve = BigInt(state.poolQuoteAmount.toString());
      const baseIn = BigInt(fallbackBaseIn.toString());
      const k = baseReserve * quoteReserve;
      const newBase = baseReserve + baseIn;
      const newQuote = k / newBase;
      const quoteOut = quoteReserve - newQuote;
      return quoteOut > 0n ? quoteOut : 0n;
    } catch (_) {
      return 0n;
    }
  }
}

module.exports = Executor;
