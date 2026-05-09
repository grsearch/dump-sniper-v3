#!/usr/bin/env node
'use strict';

/**
 * 补充代币的 pool 信息（pool_address / pool_base_vault / pool_quote_vault）
 *
 * 用法：
 *   node scripts/fill-pools.js                 # 补充所有缺失的代币
 *   node scripts/fill-pools.js --all           # 重新拉所有代币（包括已有的）
 *   node scripts/fill-pools.js MINT1 MINT2     # 只处理指定的几个 mint
 */

const TokenRegistry = require('../src/data/TokenRegistry');
const PoolFinder = require('../src/utils/poolFinder');

(async () => {
  const args = process.argv.slice(2);
  const refreshAll = args.includes('--all');
  const explicitMints = args.filter((a) => !a.startsWith('--'));

  const registry = new TokenRegistry();
  const finder = new PoolFinder({});

  let targets;
  if (explicitMints.length > 0) {
    targets = explicitMints
      .map((m) => registry.getToken(m))
      .filter(Boolean);
  } else {
    const all = registry.listAll();
    targets = refreshAll
      ? all
      : all.filter((t) => !t.pool_address || !t.pool_base_vault || !t.pool_quote_vault);
  }

  if (targets.length === 0) {
    console.log('No tokens need pool info');
    process.exit(0);
  }

  console.log(`[fill-pools] processing ${targets.length} tokens`);
  let ok = 0;
  let fail = 0;

  for (const t of targets) {
    process.stdout.write(`  ${t.symbol || t.mint.slice(0, 8)}... `);
    try {
      const result = await finder.findPoolForMint(t.mint);
      if (result) {
        registry.setPoolInfo(t.mint, result);
        console.log(
          `✓ pool=${result.poolAddress.slice(0, 6)}.. ` +
            `(${result.occurrences} matches)`,
        );
        ok += 1;
      } else {
        console.log('✗ no pool found');
        fail += 1;
      }
    } catch (err) {
      console.log(`✗ error: ${err.message}`);
      fail += 1;
    }
    // 节流，避免 Helius rate limit
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n[fill-pools] done: ${ok} OK, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('[fill-pools] fatal:', err);
  process.exit(2);
});
