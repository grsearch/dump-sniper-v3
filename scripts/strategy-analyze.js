#!/usr/bin/env node
'use strict';

/**
 * 策略分析器 - 找出哪些砸盘特征更容易盈利
 * ============================================
 *
 * 用法:
 *   node scripts/strategy-analyze.js               # 分析全部历史
 *   node scripts/strategy-analyze.js 24            # 最近 24 小时
 *
 * 从 signals + positions 表 join，按以下维度分桶看胜率：
 *   - sell_sol 大小 (10-15, 15-25, 25-50, 50+)
 *   - price_impact_pct (10-15, 15-20, 20-30, 30+)
 *   - 池子流动性
 *   - 时段 (UTC 小时)
 *   - 代币 (按 symbol 分组)
 *
 * 帮助决定：
 *   - 是否进一步收紧阈值
 *   - 哪些 token 应该从 watchlist 移除
 *   - 哪些时段更值得交易
 */

const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const hoursAgo = args[0] ? parseFloat(args[0]) : null;

const dbPath = path.resolve(__dirname, '..', 'data', 'sniper.db');
const db = new Database(dbPath, { readonly: true });

const sinceMs = hoursAgo ? Date.now() - hoursAgo * 3600 * 1000 : 0;

// 主查询：join signals 到 positions
// 用 mint + 时间窗口（signal 后 5 秒内开仓的 position）匹配
const positions = db.prepare(`
  SELECT
    p.position_id, p.mint, p.symbol, p.opened_at, p.closed_at,
    p.entry_sol, p.exit_sol, p.pnl_sol, p.pnl_pct, p.exit_reason,
    s.sell_sol, s.price_impact_pct
  FROM positions p
  LEFT JOIN (
    -- 每个 position 匹配它之前 5 秒内最接近的 accepted signal
    SELECT s1.*
    FROM signals s1
    WHERE s1.accepted = 1
  ) s ON s.mint = p.mint
       AND s.ts <= p.opened_at
       AND s.ts >= p.opened_at - 5000
  WHERE p.closed_at IS NOT NULL
    AND p.dry_run = 0
    AND p.opened_at >= ?
  ORDER BY p.opened_at DESC
`).all(sinceMs);

if (positions.length === 0) {
  console.log('没有可分析的 LIVE 平仓数据');
  process.exit(0);
}

console.log(`\n分析 ${positions.length} 笔 LIVE 平仓${hoursAgo ? ' (最近 ' + hoursAgo + 'h)' : ''}\n`);

// 总览
const total = positions.length;
const winners = positions.filter((p) => (p.pnl_sol || 0) > 0).length;
const losers = positions.filter((p) => (p.pnl_sol || 0) <= 0).length;
const totalPnl = positions.reduce((s, p) => s + (p.pnl_sol || 0), 0);
const avgPnl = totalPnl / total;
console.log('═'.repeat(70));
console.log(`总体:  ${total} 笔  胜率 ${((winners / total) * 100).toFixed(1)}%  ` +
            `总 PnL ${totalPnl.toFixed(4)} SOL  均 PnL ${(avgPnl * 100).toFixed(2)}%`);
console.log('═'.repeat(70));

// 退出原因分布
console.log('\n📊 按退出原因分桶:');
const byReason = {};
for (const p of positions) {
  const r = p.exit_reason || 'UNKNOWN';
  byReason[r] = byReason[r] || { count: 0, pnl: 0, wins: 0 };
  byReason[r].count++;
  byReason[r].pnl += p.pnl_sol || 0;
  if ((p.pnl_sol || 0) > 0) byReason[r].wins++;
}
for (const [reason, d] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
  const winRate = ((d.wins / d.count) * 100).toFixed(0);
  console.log(`  ${reason.padEnd(20)} ${d.count.toString().padStart(3)} 笔  胜率 ${winRate}%  ` +
              `总 PnL ${d.pnl.toFixed(4)} SOL`);
}

// 按 sellSol 分桶
console.log('\n📊 按砸盘卖出 SOL 分桶 (反映砸单决心):');
const sellBuckets = [
  { name: '<10 SOL', test: (s) => s < 10 },
  { name: '10-15 SOL', test: (s) => s >= 10 && s < 15 },
  { name: '15-25 SOL', test: (s) => s >= 15 && s < 25 },
  { name: '25-50 SOL', test: (s) => s >= 25 && s < 50 },
  { name: '50+ SOL', test: (s) => s >= 50 },
];
analyzeBuckets(positions, sellBuckets, 'sell_sol');

// 按 priceImpact 分桶
console.log('\n📊 按 price impact 分桶 (反映砸盘强度):');
const impactBuckets = [
  { name: '<10%', test: (i) => i < 10 },
  { name: '10-15%', test: (i) => i >= 10 && i < 15 },
  { name: '15-20%', test: (i) => i >= 15 && i < 20 },
  { name: '20-30%', test: (i) => i >= 20 && i < 30 },
  { name: '30%+', test: (i) => i >= 30 },
];
analyzeBuckets(positions, impactBuckets, 'price_impact_pct');

// 按 symbol 分组（看哪些 token 一直在亏）
console.log('\n📊 按 token 分组 (出现 ≥ 3 次的):');
const bySymbol = {};
for (const p of positions) {
  const s = p.symbol || p.mint.slice(0, 6);
  bySymbol[s] = bySymbol[s] || { count: 0, pnl: 0, wins: 0 };
  bySymbol[s].count++;
  bySymbol[s].pnl += p.pnl_sol || 0;
  if ((p.pnl_sol || 0) > 0) bySymbol[s].wins++;
}
const sortedSym = Object.entries(bySymbol)
  .filter(([_, d]) => d.count >= 3)
  .sort((a, b) => b[1].pnl - a[1].pnl);
for (const [sym, d] of sortedSym) {
  const winRate = ((d.wins / d.count) * 100).toFixed(0);
  const verdict = d.pnl > 0 ? '✅' : d.pnl < -0.05 ? '❌' : '⚠️';
  console.log(`  ${verdict} ${sym.padEnd(12)} ${d.count.toString().padStart(3)} 笔  胜率 ${winRate}%  ` +
              `总 PnL ${d.pnl.toFixed(4)} SOL  均 ${((d.pnl / d.count) * 100).toFixed(2)}%`);
}

if (sortedSym.length === 0) {
  console.log('  (无 token 出现 ≥ 3 次)');
}

// 按小时分组
console.log('\n📊 按时段分组 (UTC 小时):');
const byHour = {};
for (const p of positions) {
  const h = new Date(p.opened_at).getUTCHours();
  byHour[h] = byHour[h] || { count: 0, pnl: 0, wins: 0 };
  byHour[h].count++;
  byHour[h].pnl += p.pnl_sol || 0;
  if ((p.pnl_sol || 0) > 0) byHour[h].wins++;
}
const sortedHours = Object.entries(byHour).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
for (const [h, d] of sortedHours) {
  if (d.count < 2) continue;
  const winRate = ((d.wins / d.count) * 100).toFixed(0);
  const bar = '▇'.repeat(d.count);
  console.log(`  ${h.padStart(2, '0')}:00 UTC  ${d.count.toString().padStart(3)} 笔  胜率 ${winRate}%  PnL ${d.pnl.toFixed(4)}  ${bar}`);
}

console.log('\n' + '═'.repeat(70));
console.log('💡 解读建议:');
console.log('  - 胜率 ≥ 40% 的桶是"赚钱的特征" → 收紧阈值聚焦这个区间');
console.log('  - 胜率 ≤ 20% 且累计亏 ≥ 0.05 SOL 的桶 → 添加过滤条件排除');
console.log('  - 出现 ≥ 5 次仍亏的 token → 从 watchlist 移除');
console.log('═'.repeat(70));


function analyzeBuckets(positions, buckets, field) {
  // 注意：signals 表的字段可能没有 NULL 处理
  for (const bucket of buckets) {
    const matched = positions.filter((p) => {
      const v = p[field];
      return typeof v === 'number' && bucket.test(v);
    });
    if (matched.length === 0) continue;

    const wins = matched.filter((p) => (p.pnl_sol || 0) > 0).length;
    const winRate = ((wins / matched.length) * 100).toFixed(0);
    const totalPnl = matched.reduce((s, p) => s + (p.pnl_sol || 0), 0);
    const avgPnl = (totalPnl / matched.length) * 100;
    const marker = winRate >= 40 ? '✅' : winRate <= 15 ? '❌' : '  ';
    console.log(
      `  ${marker} ${bucket.name.padEnd(12)} ${matched.length.toString().padStart(3)} 笔  ` +
        `胜率 ${winRate.padStart(3)}%  PnL ${totalPnl.toFixed(4)} SOL  均 ${avgPnl.toFixed(2)}%`,
    );
  }

  // 无 signal 数据（join 失败）的样本
  const orphan = positions.filter((p) => typeof p[field] !== 'number').length;
  if (orphan > 0) {
    console.log(`     (${orphan} 笔无 signal 数据，跳过)`);
  }
}
