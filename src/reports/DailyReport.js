'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { config } = require('../config');
const { bjtDayRange, bjtDateString, bjtIsoString } = require('../utils/bjt');

class DailyReport {
  constructor({ tradeLogger, tokenRegistry }) {
    this.tradeLogger = tradeLogger;
    this.tokenRegistry = tokenRegistry;
    fs.mkdirSync(path.resolve(config.storage.reportsDir), { recursive: true });
  }

  /**
   * 启动定时任务：每天 BJT 08:00 生成「昨天」的报告。
   * BJT 08:00 = UTC 00:00。
   */
  start() {
    // node-cron 默认是服务器本地时区，这里用 UTC 触发 00:00 = BJT 08:00
    cron.schedule(
      '0 0 * * *',
      () => {
        // 生成昨天的报告（BJT 视角）
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        this.generateForDate(yesterday).catch((err) =>
          console.error(`[DailyReport] generation failed: ${err.message}`),
        );
      },
      { timezone: 'UTC' },
    );
    console.log('[DailyReport] scheduled: BJT 08:00 (UTC 00:00) daily');
  }

  /**
   * 生成指定 BJT 日期的报告（默认昨天）。
   */
  async generateForDate(date = new Date(Date.now() - 24 * 60 * 60 * 1000)) {
    const range = bjtDayRange(date);
    const dateStr = range.dateStr;

    const signals = this.tradeLogger.getSignalsInRange(range.startMs, range.endMs);
    const trades = this.tradeLogger.getTradesInRange(range.startMs, range.endMs);
    const positions = this.tradeLogger.getPositionsInRange(range.startMs, range.endMs);

    const md = this._renderMarkdown({ dateStr, signals, trades, positions });
    const filepath = path.join(path.resolve(config.storage.reportsDir), `${dateStr}.md`);
    fs.writeFileSync(filepath, md, 'utf-8');
    console.log(`[DailyReport] generated: ${filepath}`);
    return filepath;
  }

  _renderMarkdown({ dateStr, signals, trades, positions }) {
    const closed = positions.filter((p) => p.closed_at);
    const winners = closed.filter((p) => (p.pnl_sol ?? 0) > 0);
    const losers = closed.filter((p) => (p.pnl_sol ?? 0) <= 0);
    const totalPnl = closed.reduce((s, p) => s + (p.pnl_sol || 0), 0);

    const acceptedSignals = signals.filter((s) => s.accepted);
    const rejectedSignals = signals.filter((s) => !s.accepted);

    // 拒绝原因统计
    const rejectReasons = {};
    rejectedSignals.forEach((s) => {
      const r = s.reject_reason || 'unknown';
      rejectReasons[r] = (rejectReasons[r] || 0) + 1;
    });

    let md = `# Dump Sniper 每日报告 — ${dateStr} (BJT)\n\n`;
    md += `> 生成时间: ${bjtIsoString()} BJT\n`;
    md += `> 时间范围: ${dateStr} 00:00 ~ 24:00 (BJT)\n\n`;

    md += `## 📊 总览\n\n`;
    md += `| 指标 | 数值 |\n|---|---|\n`;
    md += `| 检测到的砸盘信号 | ${signals.filter((s) => s.kind === 'DUMP_DETECTED' || s.kind === 'BUY_SIGNAL').length} |\n`;
    md += `| 通过过滤的买入信号 | ${acceptedSignals.length} |\n`;
    md += `| 被拒绝的信号 | ${rejectedSignals.length} |\n`;
    md += `| 实际开仓数 | ${positions.length} |\n`;
    md += `| 已平仓数 | ${closed.length} |\n`;
    md += `| 盈利笔数 | ${winners.length} |\n`;
    md += `| 亏损笔数 | ${losers.length} |\n`;
    md += `| 胜率 | ${closed.length ? ((winners.length / closed.length) * 100).toFixed(1) : '-'}% |\n`;
    md += `| 总 PnL (SOL) | ${totalPnl.toFixed(4)} |\n\n`;

    if (Object.keys(rejectReasons).length) {
      md += `## ⏭ 拒绝原因分布\n\n`;
      md += `| 原因 | 次数 |\n|---|---|\n`;
      for (const [r, n] of Object.entries(rejectReasons).sort((a, b) => b[1] - a[1])) {
        md += `| ${r} | ${n} |\n`;
      }
      md += `\n`;
    }

    md += `## 💼 持仓明细\n\n`;
    if (closed.length === 0) {
      md += `无平仓记录。\n\n`;
    } else {
      md += `| 时间 | 代币 | 入场价 | 出场价 | 数量 | 入场SOL | 出场SOL | PnL SOL | PnL % | 退出原因 | 模式 |\n`;
      md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
      for (const p of closed) {
        const t = bjtIsoString(new Date(p.opened_at));
        md += `| ${t} | ${p.symbol || p.mint.slice(0, 6)} | ${(p.entry_price ?? 0).toExponential(4)} | ${(p.exit_price ?? 0).toExponential(4)} | ${(p.token_amount ?? 0).toFixed(2)} | ${(p.entry_sol ?? 0).toFixed(4)} | ${(p.exit_sol ?? 0).toFixed(4)} | ${(p.pnl_sol ?? 0).toFixed(4)} | ${(p.pnl_pct ?? 0).toFixed(2)}% | ${p.exit_reason || '-'} | ${p.dry_run ? 'DRY' : 'LIVE'} |\n`;
      }
      md += `\n`;
    }

    md += `## 📜 信号日志\n\n`;
    md += `<details><summary>点击展开 (共 ${signals.length} 条)</summary>\n\n`;
    md += `| 时间 | 代币 | 类型 | 卖出SOL | 跌幅% | 接受 | 备注 |\n`;
    md += `|---|---|---|---|---|---|---|\n`;
    for (const s of signals) {
      const t = bjtIsoString(new Date(s.ts));
      md += `| ${t} | ${s.symbol || (s.mint || '').slice(0, 6)} | ${s.kind} | ${(s.sell_sol ?? 0).toFixed(2)} | ${(s.price_impact_pct ?? 0).toFixed(2)} | ${s.accepted ? '✅' : '❌'} | ${(s.notes || s.reject_reason || '').slice(0, 60)} |\n`;
    }
    md += `\n</details>\n\n`;

    md += `## 🔄 交易记录\n\n`;
    md += `<details><summary>点击展开 (共 ${trades.length} 条)</summary>\n\n`;
    md += `| 时间 | 代币 | 方向 | SOL | 数量 | 价格 | 成功 | 模式 | 延迟ms | 签名 |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const t of trades) {
      const time = bjtIsoString(new Date(t.ts));
      const sig = t.signature ? `\`${t.signature.slice(0, 8)}...\`` : '-';
      md += `| ${time} | ${t.symbol || (t.mint || '').slice(0, 6)} | ${t.side} | ${(t.sol_amount ?? 0).toFixed(4)} | ${(t.token_amount ?? 0).toFixed(2)} | ${(t.price ?? 0).toExponential(4)} | ${t.success ? '✅' : '❌'} | ${t.dry_run ? 'DRY' : 'LIVE'} | ${t.latency_ms ?? '-'} | ${sig} |\n`;
    }
    md += `\n</details>\n\n`;

    md += `---\n*由 dump-sniper-v1 自动生成*\n`;
    return md;
  }
}

module.exports = DailyReport;
