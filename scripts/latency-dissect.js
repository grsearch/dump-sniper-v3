#!/usr/bin/env node
'use strict';

/**
 * 延迟分解器 (Latency Dissector)
 * ================================
 * 对单笔 BUY tx 做完整的延迟分解，找出"慢在哪一步"。
 *
 * 链路时间戳：
 *   T_dump_block:  砸盘 tx 落链 slot 的 blockTime
 *   T_signal_recv: 我们 LaserStream 收到砸盘 tx 的本地时间（写入 signals.ts）
 *   T_buy_submit:  我们提交 BUY tx 的本地时间（写入 trades.ts）
 *   T_buy_block:   我们 BUY tx 落链 slot 的 blockTime
 *
 * 推导出的延迟：
 *   T_signal_recv - T_dump_block       = LaserStream 推送延迟
 *   T_buy_submit - T_signal_recv       = 我们处理+提交耗时（trades.latency_ms 也记了，对比验证）
 *   T_buy_block - T_buy_submit         = leader 接收+排队+打包耗时
 *
 * 还会查询同 slot / 后 1 slot 的所有 Pump AMM swap，识别竞争者。
 *
 * 用法:
 *   node scripts/latency-dissect.js                # 分析最近 5 笔 BUY
 *   node scripts/latency-dissect.js 10             # 最近 10 笔
 *   node scripts/latency-dissect.js <buy_signature> # 单独分析一笔
 */

const path = require('path');
const Database = require('better-sqlite3');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) { console.error('HELIUS_RPC_URL required'); process.exit(1); }

const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const args = process.argv.slice(2);

const dbPath = path.resolve(__dirname, '..', 'data', 'sniper.db');
const db = new Database(dbPath, { readonly: true });

async function rpc(method, params) {
  try {
    const { data } = await axios.post(RPC, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 8000 });
    if (data.error) return { error: data.error.message };
    return { result: data.result };
  } catch (err) {
    return { error: err.message };
  }
}

async function getTx(sig) {
  if (!sig || sig.startsWith('DRYRUN')) return null;
  const r = await rpc('getTransaction', [sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
    encoding: 'json',
  }]);
  if (r.error || !r.result) return null;
  return r.result;
}

async function getBlock(slot) {
  const r = await rpc('getBlock', [slot, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
    transactionDetails: 'full',
    rewards: false,
  }]);
  if (r.error || !r.result) return null;
  return r.result;
}

function findPumpSwapsInBlock(block, mintFilter = null) {
  if (!block || !block.transactions) return [];
  const swaps = [];
  for (let i = 0; i < block.transactions.length; i++) {
    const tx = block.transactions[i];
    if (tx.meta?.err) continue;
    // 检查 accountKeys 中是否有 Pump AMM
    const keys = tx.transaction?.message?.accountKeys || [];
    const hasPump = keys.some((k) => (typeof k === 'string' ? k : k.pubkey) === PUMP_AMM);
    if (!hasPump) continue;
    // 如果指定了 mint，过滤只保留涉及该 mint 的 tx
    if (mintFilter) {
      const hasMint = keys.some((k) => (typeof k === 'string' ? k : k.pubkey) === mintFilter);
      if (!hasMint) continue;
    }
    const sig = tx.transaction?.signatures?.[0];
    const fee = tx.meta?.fee || 0;
    const cu = tx.meta?.computeUnitsConsumed || 0;
    // microLamports/CU = (fee - 5000 base) * 1M / CU
    const priorityFeeLamports = Math.max(0, fee - 5000);
    const microLamportsPerCu = cu > 0 ? Math.round((priorityFeeLamports * 1_000_000) / cu) : 0;
    const feePayer = typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey;
    swaps.push({ index: i, signature: sig, fee, cu, microLamportsPerCu, feePayer });
  }
  return swaps;
}

async function dissectBuy(buyRow) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`BUY: ${buyRow.symbol || (buyRow.mint || '').slice(0, 6)}`);
  console.log(`  position_id: ${buyRow.position_id}`);
  console.log(`  buy_signature: ${buyRow.signature}`);
  console.log(`  T_buy_submit (本地): ${new Date(buyRow.ts).toISOString().replace('T', ' ').slice(0, 23)}`);
  console.log(`  executor_latency_ms: ${buyRow.latency_ms}`);

  // 拿对应的 trigger signal
  const trigger = db.prepare(
    `SELECT * FROM signals WHERE mint = ? AND accepted = 1 AND ts < ? AND ts > ?
     ORDER BY ts DESC LIMIT 1`,
  ).get(buyRow.mint, buyRow.ts, buyRow.ts - 30_000);

  if (!trigger) {
    console.log('  ⚠️  no trigger signal found in last 30s');
    return;
  }
  console.log(`\n  trigger_signature: ${trigger.seller_tx}`);
  console.log(`  T_signal_recv (本地): ${new Date(trigger.ts).toISOString().replace('T', ' ').slice(0, 23)}`);

  // 拉两个 tx
  const [buyTx, triggerTx] = await Promise.all([
    getTx(buyRow.signature),
    getTx(trigger.seller_tx),
  ]);

  if (!triggerTx) {
    console.log('  ⚠️  trigger tx not found on chain');
    return;
  }
  if (!buyTx) {
    console.log('  ⚠️  buy tx not found on chain (mempool 丢弃？)');
    return;
  }

  const dumpSlot = triggerTx.slot;
  const dumpBlockTime = triggerTx.blockTime * 1000;
  const buySlot = buyTx.slot;
  const buyBlockTime = buyTx.blockTime * 1000;

  console.log(`\n  砸盘 tx slot=${dumpSlot}, blockTime=${new Date(dumpBlockTime).toISOString().replace('T', ' ').slice(0, 23)}`);
  console.log(`  我们 BUY slot=${buySlot}, blockTime=${new Date(buyBlockTime).toISOString().replace('T', ' ').slice(0, 23)}`);
  console.log(`  slot gap: ${buySlot - dumpSlot} slot`);

  // 延迟分解
  console.log(`\n  ⏱️  延迟分解：`);
  const t1 = trigger.ts - dumpBlockTime;
  const t2 = buyRow.ts - trigger.ts;
  const t3 = buyBlockTime - buyRow.ts;
  const total = buyBlockTime - dumpBlockTime;

  console.log(`    [1] LaserStream 推送 (砸盘落链 → 我们收到):  ${formatMs(t1)} ${barChart(t1, total)}`);
  console.log(`        ${t1 < 0 ? '⚠️  负值：本地时间和链上 blockTime 不同步（blockTime 精度 1s）' : ''}`);
  console.log(`    [2] 我们处理+提交 (信号 → BUY tx 提交):       ${formatMs(t2)} ${barChart(t2, total)}`);
  console.log(`        其中 executor_latency_ms = ${buyRow.latency_ms} (Executor 内部耗时)`);
  console.log(`        差值 ${t2 - (buyRow.latency_ms || 0)} ms = DumpDetector 解析 + SignalEngine + 主循环`);
  console.log(`    [3] Leader 接收+打包 (BUY 提交 → BUY 落链):    ${formatMs(t3)} ${barChart(t3, total)}`);
  console.log(`    ─────────────────────────────────────────────`);
  console.log(`    总计 (砸盘落链 → 我们 BUY 落链):                ${formatMs(total)}`);

  // 同 slot / 下一 slot 的所有 Pump 交易（识别竞争者）
  // v3.10: 过滤同 mint，按 microLamports/CU 排序，看排名
  console.log(`\n  🔍 dump slot ${dumpSlot} 内涉及 ${(buyRow.mint || '').slice(0, 8)}.. 的所有 Pump swap:`);
  console.log(`     (按链上打包顺序，同 slot 内 leader 按 microLamports/CU 排序)`);
  const dumpBlock = await getBlock(dumpSlot);
  const dumpSwaps = findPumpSwapsInBlock(dumpBlock, buyRow.mint);
  for (const s of dumpSwaps) {
    const isOurs = s.signature === buyRow.signature;
    const isTrigger = s.signature === trigger.seller_tx;
    const tag = isOurs ? '🎯 你' : isTrigger ? '🔥 砸单' : '';
    console.log(
      `    [${s.index.toString().padStart(3)}] ${s.feePayer.slice(0, 8)}.. ` +
        `fee=${s.fee.toString().padStart(8)} CU=${s.cu.toString().padStart(6)} ` +
        `μL/CU=${s.microLamportsPerCu.toString().padStart(7)} ${tag}`,
    );
  }

  if (buySlot !== dumpSlot) {
    console.log(`\n  🔍 buy slot ${buySlot} 内涉及 ${(buyRow.mint || '').slice(0, 8)}.. 的所有 Pump swap:`);
    const buyBlock = await getBlock(buySlot);
    const buySwaps = findPumpSwapsInBlock(buyBlock, buyRow.mint);
    for (const s of buySwaps) {
      const isOurs = s.signature === buyRow.signature;
      const tag = isOurs ? '🎯 你' : '';
      console.log(
        `    [${s.index.toString().padStart(3)}] ${s.feePayer.slice(0, 8)}.. ` +
          `fee=${s.fee.toString().padStart(8)} CU=${s.cu.toString().padStart(6)} ` +
          `μL/CU=${s.microLamportsPerCu.toString().padStart(7)} ${tag}`,
      );
    }
  }

  // 给出诊断
  console.log(`\n  💡 诊断：`);
  if (buySlot - dumpSlot === 0) {
    console.log(`    ✅ 同 slot 落链，物理最快（这极少见，可能你也是 leader 或用了 Jito bundle）`);
  } else if (buySlot - dumpSlot === 1) {
    console.log(`    ✅ 下一个 slot 落链，已是顶级速度。`);
    console.log(`    若 dump slot 内还有其他抢入者，他们要么走 mempool 监听抢先了砸单，`);
    console.log(`    要么用了 Jito（与砸单一起被打包进同一 slot）。`);
  } else if (t3 > 600) {
    console.log(`    ⚠️  Leader 接收+打包慢 (${t3}ms)。可能原因：`);
    console.log(`       - Priority fee/CU 单价不够高 (微 Lamports/CU)`);
    console.log(`       - 提交时机不对（已经接近 leader 切换边界）`);
  } else if (t2 > 300) {
    console.log(`    ⚠️  我们处理慢 (${t2}ms)。重点看 Executor.buy 里 swapSolanaState 是否常 >150ms`);
  } else if (t1 > 500) {
    console.log(`    ⚠️  LaserStream 延迟大 (${t1}ms)。检查 LaserStream endpoint 是否同区域`);
  }
}

function formatMs(ms) {
  return `${ms.toString().padStart(5)} ms`;
}

function barChart(part, total) {
  if (!total || total <= 0) return '';
  const pct = Math.max(0, Math.min(100, Math.round((part / total) * 100)));
  const blocks = Math.round(pct / 5);
  return `${'█'.repeat(blocks)}${'░'.repeat(20 - blocks)} ${pct}%`;
}

(async () => {
  let buys;
  if (args.length === 1 && args[0].length > 50) {
    // 单笔签名
    buys = db.prepare(`SELECT * FROM trades WHERE signature = ? AND side = 'BUY'`).all(args[0]);
    if (buys.length === 0) {
      console.error('未找到此签名对应的 BUY trade');
      process.exit(1);
    }
  } else {
    const limit = args[0] ? parseInt(args[0], 10) : 5;
    buys = db.prepare(
      `SELECT * FROM trades WHERE side='BUY' AND success=1 AND dry_run=0
       ORDER BY ts DESC LIMIT ?`,
    ).all(limit);
  }

  if (buys.length === 0) {
    console.log('没有 LIVE BUY 记录可分析');
    process.exit(0);
  }

  console.log(`分析 ${buys.length} 笔 BUY (每笔需 ~3s 拉 RPC 数据)...`);

  for (const b of buys) {
    try {
      await dissectBuy(b);
    } catch (err) {
      console.error(`Error dissecting ${b.signature}:`, err.message);
    }
  }
})();
