#!/usr/bin/env node
'use strict';

/**
 * CLI 健康检查工具
 *
 * 用法：
 *   node scripts/health.js              # 默认 http://localhost:3001
 *   node scripts/health.js --json       # 输出完整 JSON
 *   HEALTH_URL=http://server:3001 node scripts/health.js
 *
 * 退出码：
 *   0 - 状态 OK
 *   1 - 状态 DEGRADED（有告警）
 *   2 - 无法连接 / fatal error
 */

const http = require('http');
const https = require('https');

const url = process.env.HEALTH_URL || 'http://localhost:3001';
const wantJson = process.argv.includes('--json');
const token = process.env.DASHBOARD_TOKEN || '';

function request(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function color(c, s) {
  return process.stdout.isTTY ? c + s + RESET : s;
}

(async () => {
  const headers = {};
  if (token) headers['X-Dashboard-Token'] = token;

  let report;
  try {
    const { body } = await request(`${url}/api/health`, headers);
    const j = JSON.parse(body);
    if (!j.ok) throw new Error('response not ok');
    report = j.report;
  } catch (err) {
    console.error(color(RED, `❌ Health check failed: ${err.message}`));
    console.error(`   URL: ${url}/api/health`);
    process.exit(2);
  }

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'OK' ? 0 : 1);
  }

  // ============ Overall ============
  const statusColor = report.status === 'OK' ? GREEN : RED;
  console.log('');
  console.log(color(BOLD, `Dump Sniper Health Report`));
  console.log(`  Status: ${color(statusColor, report.status)}`);
  console.log(`  Uptime: ${formatUptime(report.uptime_s)}`);
  console.log(`  Memory: ${report.mem_mb} MB`);
  console.log(`  Time:   ${new Date(report.ts).toLocaleString()}`);
  console.log('');

  // ============ Heartbeats ============
  console.log(color(BOLD, '── Heartbeats ──'));
  for (const [name, h] of Object.entries(report.heartbeats)) {
    const icon =
      h.status === 'OK' ? color(GREEN, '✅') :
      h.status === 'STALE' ? color(RED, '❌') :
      color(YELLOW, '⏳');
    const elapsed = h.elapsed_ms != null ? `${Math.round(h.elapsed_ms / 1000)}s ago` : 'never';
    const ctxStr = h.last_context ? color(CYAN, ` [${h.last_context}]`) : '';
    console.log(`  ${icon} ${name.padEnd(20)} ${h.status.padEnd(10)} last beat: ${elapsed}${ctxStr}`);
  }
  console.log('');

  // ============ Counters ============
  console.log(color(BOLD, '── Module Counters ──'));
  for (const [moduleName, counters] of Object.entries(report.modules)) {
    console.log(color(CYAN, `  [${moduleName}]`));
    const entries = Object.entries(counters).sort();
    for (const [k, v] of entries) {
      const shortName = k.replace(`${moduleName}.`, '');
      const pad = '    ' + shortName.padEnd(28);
      // 高亮异常计数
      const isError = /(error|fail|reject|stuck)/i.test(shortName);
      const valStr = isError && v > 0 ? color(RED, String(v)) : String(v);
      console.log(`${pad}${valStr}`);
    }
  }
  console.log('');

  // ============ Active alerts ============
  if (report.active_alerts.length > 0) {
    console.log(color(BOLD + RED, '── 🔔 Active Alerts ──'));
    for (const a of report.active_alerts) {
      const ago = Math.round((Date.now() - a.since) / 1000);
      const sevColor = a.severity === 'critical' ? RED : a.severity === 'error' ? RED : YELLOW;
      console.log(`  ${color(sevColor, '[' + a.severity.toUpperCase() + ']')} ${a.name}`);
      console.log(`    ${a.message}`);
      console.log(color(CYAN, `    fired ${ago}s ago`));
      if (a.context && Object.keys(a.context).length > 0) {
        console.log(color(CYAN, `    context: ${JSON.stringify(a.context)}`));
      }
    }
    console.log('');
  }

  // ============ Recent errors ============
  const errorModules = Object.entries(report.errors).filter(([_, e]) => e.length > 0);
  if (errorModules.length > 0) {
    console.log(color(BOLD, '── Recent Errors ──'));
    for (const [moduleName, errs] of errorModules) {
      console.log(color(CYAN, `  [${moduleName}]`));
      for (const e of errs.slice(0, 3)) {
        const ago = Math.round((Date.now() - e.ts) / 1000);
        console.log(`    ${color(RED, '✗')} ${e.message}`);
        console.log(`      ${color(CYAN, ago + 's ago')}`);
        if (e.context && Object.keys(e.context).length > 0) {
          const ctxStr = JSON.stringify(e.context);
          console.log(`      context: ${ctxStr.slice(0, 120)}${ctxStr.length > 120 ? '...' : ''}`);
        }
      }
    }
    console.log('');
  }

  process.exit(report.status === 'OK' ? 0 : 1);
})();

function formatUptime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (s < 86400) return `${h}h ${m}m`;
  const d = Math.floor(s / 86400);
  return `${d}d ${h % 24}h ${m}m`;
}
