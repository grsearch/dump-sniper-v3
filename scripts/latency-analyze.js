#!/usr/bin/env node
'use strict';

/**
 * 延迟分析器
 * ==========
 * 分析最近 N 笔 BUY 的真实链上延迟：
 *   1. 从数据库读取 BUY 交易及对应的触发信号
 *   2. 用 Helius RPC 查询每笔 BUY tx 的实际落链 slot
 *   3. 查询触发 SELL（砸盘单）的 slot
 *   4. 计算 BUY slot - SELL slot = 落链延迟（slot 数）
 *
 * 用法：
 *   node scripts/latency-analyze.js              # 最近 20 笔 BUY
 *   node scripts/latency-analyze.js 50           # 最近 50 笔 BUY
 *   node scripts/latency-analyze.js --json       # JSON 输出
 *
 * 解读：
 *   - slotGap = 0  ：你和砸盘在同一 slot，最快（极少见，需 jito bundle）
 *   - slotGap = 1  ：下一个 slot，顶级速度（约 400ms）
 *   - slotGap = 2-3：中等速度（约 800-1200ms）
 *   - slotGap > 5  ：明显慢于竞争者，需要排查
 */

const path = require('path');
const Database = require('better-sqlite3');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const RPC_URL = process.env.HELIUS_RPC_URL;
if (!RPC_URL) {
  console.error('HELIUS_RPC_URL required in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const limitArg = args.find((a) => /^\d+$/.test(a));
const limit = limitArg ? parseInt(limitArg, 10) : 20;

const dbPath = path.resolve(__dirname, '..', 'data', 'sniper.db');
const db = new Database(dbPath, { readonly: true });

async function rpcCall(method, params) {
  try {
    const { data } = await axios.post(
      RPC_URL,
      { jsonrpc: '2.0', id: 1, method, params },
      { timeout: 8000 },
    );
    if (data.error) return { error: data.error.message };
    return { result: data.result };
  } catch (err) {
    return { error: err.message };
  }
}

async function getTxSlot(signature) {
  if (!signature || signature.startsWith('DRYRUN')) return null;
  const r = await rpcCall('getTransaction', [
    signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
  if (r.error || !r.result) return null;
  return r.result.slot;
}

async function main() {
  // 拉最近 N 笔成功的 BUY
  const buys = db
    .prepare(
      `SELECT t.position_id, t.ts as buy_ts, t.signature as buy_sig, t.symbol, t.mint,
              t.sol_amount, t.price as buy_price, t.latency_ms, t.dry_run,
              p.opened_at
       FROM trades t
       LEFT JOIN positions p ON p.position_id = t.position_id
       WHERE t.side = 'BUY' AND t.success = 1 AND t.dry_run = 0
       ORDER BY t.ts DESC LIMIT ?`,
    )
    .all(limit);

  if (buys.length === 0) {
    console.error('没有 LIVE BUY 记录可分析（DRY_RUN 不计算）。');
    process.exit(0);
  }

  if (!jsonMode) {
    console.log(`分析最近 ${buys.length} 笔 LIVE BUY 的链上延迟…`);
    console.log('(每笔需调用 Helius RPC 查 slot，约 0.5s/笔)\n');
  }

  const rows = [];
  for (const b of buys) {
    // 找触发这笔 BUY 的砸盘信号（同 mint，BUY 之前 30s 内最近的 accepted=1）
    const trigger = db
      .prepare(
        `SELECT signature, ts FROM signals
         WHERE mint = ? AND accepted = 1 AND ts < ? AND ts > ?
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(b.mint, b.buy_ts, b.buy_ts - 30_000);

    const buySlot = await getTxSlot(b.buy_sig);
    const sellSlot = trigger ? await getTxSlot(trigger.signature) : null;
    const slotGap = buySlot && sellSlot ? buySlot - sellSlot : null;

    const row = {
      symbol: b.symbol || (b.mint || '').slice(0, 6),
      mint: b.mint,
      bjtTime: new Date(b.buy_ts + 8 * 3600_000).toISOString().replace('Z', '+0800'),
      sellSig: trigger?.signature || null,
      sellSlot,
      buySig: b.buy_sig,
      buySlot,
      slotGap,
      executorLatencyMs: b.latency_ms,
      sigToSigMs: trigger ? b.buy_ts - trigger.ts : null,
    };
    rows.push(row);

    if (!jsonMode) {
      const gapStr =
        slotGap == null
          ? '?'
          : slotGap === 0
            ? '🟢 0 (同 slot, 极快)'
            : slotGap === 1
              ? '🟢 1 (下一 slot, 顶级)'
              : slotGap <= 3
                ? `🟡 ${slotGap} (中等)`
                : `🔴 ${slotGap} (慢)`;
      console.log(
        `[${row.bjtTime}] ${row.symbol.padEnd(10)} ` +
          `executor=${String(row.executorLatencyMs).padStart(4)}ms ` +
          `sigGap=${String(row.sigToSigMs ?? '?').padStart(5)}ms ` +
          `slotGap=${gapStr}`,
      );
      if (slotGap == null) {
        console.log(
          `  ↳ ${b.buy_sig.slice(0, 12)}.. (slot 查询失败或无触发信号)`,
        );
      } else {
        console.log(
          `  ↳ trigger ${trigger.signature.slice(0, 12)}..@slot${sellSlot} → buy ${b.buy_sig.slice(0, 12)}..@slot${buySlot}`,
        );
      }
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // 汇总
  const valid = rows.filter((r) => r.slotGap != null);
  if (valid.length === 0) {
    console.log('\n无法计算 slotGap（可能所有触发信号未记录 signature 或 RPC 查询失败）');
    return;
  }
  const gaps = valid.map((r) => r.slotGap);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const fast = gaps.filter((g) => g <= 1).length;
  const slow = gaps.filter((g) => g > 5).length;

  console.log('\n========== 汇总 ==========');
  console.log(`样本数:        ${valid.length}`);
  console.log(`平均 slotGap:  ${avg.toFixed(2)}`);
  console.log(`中位 slotGap:  ${median}`);
  console.log(`P90 slotGap:   ${p90}`);
  console.log(`≤1 slot (顶级): ${fast}/${valid.length} (${((fast / valid.length) * 100).toFixed(1)}%)`);
  console.log(`>5 slot (慢):  ${slow}/${valid.length} (${((slow / valid.length) * 100).toFixed(1)}%)`);

  // executor latency 分布
  const execs = rows.map((r) => r.executorLatencyMs).filter((x) => x);
  if (execs.length > 0) {
    const execAvg = execs.reduce((a, b) => a + b, 0) / execs.length;
    const execSorted = [...execs].sort((a, b) => a - b);
    const execMed = execSorted[Math.floor(execSorted.length / 2)];
    const execP90 = execSorted[Math.floor(execSorted.length * 0.9)];
    console.log(`\nExecutor 内部延迟（buy() 函数耗时）:`);
    console.log(`  avg=${execAvg.toFixed(0)}ms median=${execMed}ms p90=${execP90}ms`);
  }

  console.log('\n解读建议:');
  if (avg <= 1.5) {
    console.log('  ✅ 顶级竞争梯队（同 slot 或下一 slot），与最快的 sniper 持平。');
    console.log('     如果实际利润不理想，看仓位大小和反弹幅度。');
  } else if (avg <= 3) {
    console.log('  🟡 落后顶级 1-2 个 slot（约 400-800ms）。可以买到反弹但不是最低点。');
    console.log('     检查项：');
    console.log('     - MAX_PRIORITY_FEE_LAMPORTS 是否 ≥ 20_000_000 (0.02 SOL)');
    console.log('     - HELIUS_SENDER_ENDPOINT 是否用 fra-sender（同区域）');
    console.log('     - executor latency p90 是否 < 200ms');
  } else if (avg <= 6) {
    console.log('  🔴 落后 3-5 个 slot（约 1-2 秒）。已经在反弹中后段才抄到。');
    console.log('     主要损失：抄底价比最快者贵 5-10%，吃掉大半利润空间。');
    console.log('     必须排查：');
    console.log('     1. Priority fee：当前 ' + (process.env.MAX_PRIORITY_FEE_LAMPORTS || '5000000') +
      ' lamports 太低');
    console.log('        砸盘事件中竞争者通常用 20-50M lamports，建议立即调到 30_000_000');
    console.log('     2. Sender endpoint: ' + (process.env.HELIUS_SENDER_ENDPOINT || '(未设置)'));
    console.log('        必须用 fra-sender.helius-rpc.com/fast (同区域提交延迟降到 5ms)');
    console.log('     3. 看 executor latency p90：>200ms 说明本地慢，<150ms 说明慢在网络');
  } else {
    console.log('  ⚫ 落后 >6 个 slot。基本错过反弹机会。');
    console.log('     这种情况通常是基础设施问题（Helius 配额耗尽 / 服务器不在 FRA / RPC 限速）');
    console.log('     先检查 Helius dashboard 看是否触发限流。');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
