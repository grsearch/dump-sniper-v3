#!/usr/bin/env node
'use strict';

/**
 * Stuck Position 管理工具
 * ====================
 * 列出 / 重试 / 强制关闭 状态为 'stuck' 的 position（重试上限耗尽，token 还在钱包里）
 *
 * 用法：
 *   node scripts/stuck.js                      # 列出所有 stuck position
 *   node scripts/stuck.js --balance            # 列出 + 显示链上真实余额
 *   node scripts/stuck.js retry <position_id>  # 重置 sell_attempts，触发重试
 *   node scripts/stuck.js retry-all            # 重置所有 stuck，触发重试
 *   node scripts/stuck.js close <position_id>  # 强制标 closed（认亏，不卖）
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const Database = require('better-sqlite3');
const { Connection, PublicKey } = require('@solana/web3.js');

const args = process.argv.slice(2);
const dbPath = path.resolve(__dirname, '..', 'data', 'sniper.db');
const db = new Database(dbPath);

function listStuck(opts = {}) {
  const rows = db.prepare(
    `SELECT * FROM positions WHERE status = 'stuck' AND closed_at IS NULL ORDER BY opened_at DESC`,
  ).all();

  if (rows.length === 0) {
    console.log('✓ 没有 stuck position');
    return;
  }

  console.log(`找到 ${rows.length} 个 stuck position:\n`);

  const conn = opts.checkBalance ? new Connection(process.env.HELIUS_RPC_URL, 'confirmed') : null;
  const owner = opts.checkBalance ? deriveOwner() : null;

  (async () => {
    for (const r of rows) {
      const ageMin = Math.round((Date.now() - r.opened_at) / 60_000);
      console.log(`📍 ${r.symbol || r.mint.slice(0, 6)} (${r.mint})`);
      console.log(`   position_id: ${r.position_id}`);
      console.log(`   opened: ${ageMin} min ago`);
      console.log(`   entry: ${r.entry_sol} SOL @ ${Number(r.entry_price).toExponential(3)}`);
      console.log(`   tokens (DB): ${(r.token_amount || 0).toFixed(2)}`);
      console.log(`   sell_attempts: ${r.sell_attempts}`);
      console.log(`   exit_intent: ${r.exit_intent || 'none'}`);
      console.log(`   last_error: ${r.last_error || 'none'}`);

      if (opts.checkBalance && conn && owner) {
        try {
          const resp = await conn.getParsedTokenAccountsByOwner(
            owner,
            { mint: new PublicKey(r.mint) },
            'confirmed',
          );
          let total = 0;
          for (const acc of resp.value) {
            const ui = acc.account.data.parsed?.info?.tokenAmount?.uiAmount;
            if (typeof ui === 'number') total += ui;
          }
          console.log(`   tokens (链上): ${total.toFixed(2)} ${total > 0 ? '🪙 还在钱包' : '✓ 已经空了'}`);
        } catch (err) {
          console.log(`   tokens (链上): 查询失败 (${err.message})`);
        }
      }
      console.log('');
    }
  })();
}

function deriveOwner() {
  if (!process.env.WALLET_PRIVATE_KEY_BS58) return null;
  try {
    const bs58Lib = require('bs58');
    const bs58 = bs58Lib.default || bs58Lib;
    const { Keypair } = require('@solana/web3.js');
    const kp = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY_BS58));
    return kp.publicKey;
  } catch (_) {
    return null;
  }
}

function retryOne(positionId) {
  const r = db.prepare(`SELECT * FROM positions WHERE position_id = ?`).get(positionId);
  if (!r) {
    console.error(`未找到 position ${positionId}`);
    process.exit(1);
  }
  if (r.status !== 'stuck') {
    console.error(`position 不是 stuck 状态 (当前: ${r.status})`);
    process.exit(1);
  }
  // 重置 attempts + 状态，让 reconciler 立即拾起
  db.prepare(
    `UPDATE positions
     SET status = 'sell_pending',
         sell_attempts = 0,
         next_retry_at = ?,
         last_error = NULL
     WHERE position_id = ?`,
  ).run(Date.now(), positionId);
  console.log(`✓ ${r.symbol || r.mint.slice(0, 6)} 已重置，等 reconciler（5s 内）触发重试`);
  console.log(`  注意：必须 dump-sniper 服务正在运行，否则不会自动重试`);
}

function retryAll() {
  const stuck = db.prepare(`SELECT position_id, symbol, mint FROM positions WHERE status = 'stuck' AND closed_at IS NULL`).all();
  if (stuck.length === 0) {
    console.log('✓ 没有 stuck position 可重试');
    return;
  }
  const result = db.prepare(
    `UPDATE positions
     SET status = 'sell_pending',
         sell_attempts = 0,
         next_retry_at = ?,
         last_error = NULL
     WHERE status = 'stuck' AND closed_at IS NULL`,
  ).run(Date.now());
  console.log(`✓ 已重置 ${result.changes} 个 stuck position`);
  for (const r of stuck) {
    console.log(`  - ${r.symbol || r.mint.slice(0, 6)} (${r.position_id.slice(0, 8)}..)`);
  }
}

function closeOne(positionId) {
  const r = db.prepare(`SELECT * FROM positions WHERE position_id = ?`).get(positionId);
  if (!r) {
    console.error(`未找到 position ${positionId}`);
    process.exit(1);
  }
  // 标记为人工关闭，PnL 标 -100% 提醒
  db.prepare(
    `UPDATE positions
     SET closed_at = ?,
         exit_sol = 0,
         pnl_sol = ?,
         pnl_pct = -100,
         exit_reason = 'MANUAL_CLOSE',
         status = 'closed'
     WHERE position_id = ?`,
  ).run(Date.now(), -(r.entry_sol || 0), positionId);
  console.log(`✓ ${r.symbol || r.mint.slice(0, 6)} 已强制关闭 (认亏 ${r.entry_sol} SOL)`);
  console.log(`  ⚠️ token 仍在钱包里，需要你手动卖出（用 GMGN/Phantom 等）`);
}

const cmd = args[0];
if (!cmd) {
  listStuck();
} else if (cmd === '--balance') {
  listStuck({ checkBalance: true });
} else if (cmd === 'retry') {
  if (!args[1]) { console.error('需要 position_id'); process.exit(1); }
  retryOne(args[1]);
} else if (cmd === 'retry-all') {
  retryAll();
} else if (cmd === 'close') {
  if (!args[1]) { console.error('需要 position_id'); process.exit(1); }
  closeOne(args[1]);
} else {
  console.error(`未知命令: ${cmd}`);
  console.error(`用法: node scripts/stuck.js [--balance | retry <id> | retry-all | close <id>]`);
  process.exit(1);
}
