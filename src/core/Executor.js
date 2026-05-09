'use strict';

/**
 * Executor (v3)
 * =============
 * 直接调用 Pump.fun AMM (PumpSwap) 程序，不走 Jupiter aggregator。
 *
 * 关键差异 vs v2 (Jupiter)：
 *   - 省掉 Jupiter quote (~80-150ms HTTP) 和 swap tx 构造 (~80-150ms HTTP)
 *   - 用 RPC getMultipleAccounts 拉 pool 状态（30-80ms，可走 staked endpoint）
 *   - 构造 tx 在本地（<10ms）
 *   - 总省 100-200ms，足以多抢一个 slot（400ms = 1 slot）
 *
 * 用 @pump-fun/pump-swap-sdk 官方 SDK（高级层 PumpAmmSdk）：
 *   - 自动跟随程序升级（fee_config, fee_program, coin_creator_vault, volume_accumulator）
 *   - 自动 PDA 推导和 protocol_fee_recipient 选择
 *   - 自动 ATA 创建（如果用户没有目标 token 的 ATA）
 *
 * SDK 调用流程（Buy = SOL→token = QuoteToBase 方向）：
 *   1. fetchPool(poolKey) 拿到 Pool 对象
 *   2. swapAutocompleteBaseFromQuote(pool, quoteAmount, slippage, QuoteToBase) → baseOut
 *   3. swapInstructions(pool, baseOut, slippage, QuoteToBase, user) → ix[]
 *
 * Sell = token→SOL = BaseToQuote 方向：
 *   1. fetchPool(poolKey)
 *   2. swapAutocompleteQuoteFromBase(pool, baseAmount, slippage, BaseToQuote) → quoteOut
 *   3. swapInstructions(pool, baseAmount, slippage, BaseToQuote, user) → ix[]
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

    // SDK 在 LIVE 模式才需要（避免 DRY_RUN 时强依赖）
    this.pumpSdk = null;
    this.Direction = null;
    if (!this.dryRun) {
      try {
        const pumpModule = require('@pump-fun/pump-swap-sdk');
        const { PumpAmmSdk, Direction } = pumpModule;
        this.pumpSdk = new PumpAmmSdk(this.rpc);
        this.Direction = Direction;
        console.log('[Executor] Pump AMM SDK loaded');
      } catch (err) {
        console.error(`[Executor] failed to load @pump-fun/pump-swap-sdk: ${err.message}`);
        console.error('[Executor] LIVE 模式必须安装 @pump-fun/pump-swap-sdk');
      }
    }

    this.maxPriorityFeeLamports = config.maxPriorityFeeLamports;
    this.computeUnitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '300000', 10);
  }

  stop() {}

  /**
   * 用 Helius Sender 或 staked RPC 提交交易。
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
        console.warn(`[Executor] Helius Sender failed, fallback to staked: ${err.message}`);
      }
    }
    return await this.stakedRpc.sendRawTransaction(serialized, {
      skipPreflight: true,
      maxRetries: 0,
    });
  }

  async _buildAndSignTx(swapInstructions) {
    const blockhash = await this.rpc.getLatestBlockhash('confirmed');

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
    ];

    // Priority fee：把 maxPriorityFeeLamports 平摊到 computeUnitLimit
    // microLamportsPerCu = (maxPriorityFeeLamports * 1_000_000) / computeUnitLimit
    const microLamportsPerCu = Math.floor(
      (this.maxPriorityFeeLamports * 1_000_000) / this.computeUnitLimit,
    );
    if (microLamportsPerCu > 0) {
      ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }));
    }

    for (const ix of swapInstructions) ixs.push(ix);

    const message = new TransactionMessage({
      payerKey: this.keypair.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.keypair]);
    return tx.serialize();
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
    if (!this.pumpSdk) {
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

      // 1. Autocomplete: 给定 quoteIn (SOL)，算 baseOut (token)
      const tS0 = Date.now();
      const baseAmountBN = await this.pumpSdk.swapAutocompleteBaseFromQuote(
        poolKey,
        sizeLamportsBN,
        slippagePct,
        this.Direction.QuoteToBase,
      );
      const stateLatencyMs = Date.now() - tS0;
      monitor.inc('Executor.stateOk', 1, 'Executor');

      const baseRaw = BigInt(baseAmountBN.toString());
      const tokenAmount = Number(baseRaw) / Math.pow(10, baseDecimals);
      const realPrice = sizeSol / tokenAmount;

      // 2. 构造 swap 指令
      const tB0 = Date.now();
      const swapIxs = await this.pumpSdk.swapInstructions(
        poolKey,
        baseAmountBN,
        slippagePct,
        this.Direction.QuoteToBase,
        this.keypair.publicKey,
      );
      const buildLatencyMs = Date.now() - tB0;

      if (!Array.isArray(swapIxs) || swapIxs.length === 0) {
        throw new Error('SDK swapInstructions returned empty');
      }

      // 3. 构造、签名、提交
      const serialized = await this._buildAndSignTx(swapIxs);

      const tSend0 = Date.now();
      const sig = await this._submitTx(serialized);
      const sendLatencyMs = Date.now() - tSend0;
      monitor.inc('Executor.buySuccess', 1, 'Executor');

      console.log(
        `[Executor:LIVE] BUY submitted: ${(sig || '').slice(0, 8)}.. ` +
          `(state=${stateLatencyMs}ms build=${buildLatencyMs}ms send=${sendLatencyMs}ms total=${
            Date.now() - t0
          }ms)`,
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
    if (!this.pumpSdk) {
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

      // 1. 拉链上余额（避免本地 tokenAmount 与链上不符）
      const tS0 = Date.now();
      const onchainAmount = await this._getRealOnchainTokenAmount(order.mint, baseDecimals);
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

      // 2. Autocomplete: 给定 baseIn (token)，算 quoteOut (SOL)
      const expectedQuoteBN = await this.pumpSdk.swapAutocompleteQuoteFromBase(
        poolKey,
        sellAmountBN,
        slippagePct,
        this.Direction.BaseToQuote,
      );
      const stateLatencyMs = Date.now() - tS0;
      monitor.inc('Executor.stateOk', 1, 'Executor');

      const expectedSolOut = Number(BigInt(expectedQuoteBN.toString())) / 1e9;
      const realPrice = expectedSolOut / sellAmount;

      // 3. 构造 swap 指令
      const tB0 = Date.now();
      const swapIxs = await this.pumpSdk.swapInstructions(
        poolKey,
        sellAmountBN,
        slippagePct,
        this.Direction.BaseToQuote,
        this.keypair.publicKey,
      );
      const buildLatencyMs = Date.now() - tB0;

      if (!Array.isArray(swapIxs) || swapIxs.length === 0) {
        throw new Error('SDK swapInstructions returned empty');
      }

      // 4. 构造、签名、提交
      const serialized = await this._buildAndSignTx(swapIxs);

      const tSend0 = Date.now();
      const sig = await this._submitTx(serialized);
      const sendLatencyMs = Date.now() - tSend0;
      monitor.inc('Executor.sellSuccess', 1, 'Executor');

      console.log(
        `[Executor:LIVE] SELL submitted: ${(sig || '').slice(0, 8)}.. ` +
          `(state=${stateLatencyMs}ms build=${buildLatencyMs}ms send=${sendLatencyMs}ms total=${
            Date.now() - t0
          }ms)`,
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
}

module.exports = Executor;
