'use strict';

/**
 * HealthMonitor
 * =============
 * 核心模块运行健康度监控，目标：出问题时能立刻知道是**哪个模块的哪一步**炸了，
 * 而不是翻日志。
 *
 * 三类信号：
 *
 * 1. Heartbeat：模块定期/事件触发上报"我还活着"。超过 staleMs 未上报 → STALE
 * 2. Counter：事件计数（增量），用于看事件率、成功率、异常率
 * 3. LastError：每个模块保留最近 N 条错误（含 message、stack 摘要、上下文）
 *
 * 此外：
 * - 每 30 秒做一次快照（counters 的 delta 和 absolute），保留最近 120 个（约 1h）
 * - 自动检测告警（如 LaserStream 连接但 60s 无 tx），通过 emit('alert', ...) 发出
 * - 快照可通过 dashboard /api/health 实时看到
 */

const EventEmitter = require('events');

const SNAPSHOT_INTERVAL_MS = 30_000;
const SNAPSHOT_HISTORY = 120; // ~1 小时
const ERROR_HISTORY_PER_MODULE = 20;
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;

class HealthMonitor extends EventEmitter {
  constructor() {
    super();
    this.startedAt = Date.now();

    // module 名 → { lastBeatAt, staleMs, label }
    this.heartbeats = new Map();

    // counter 名 → { value, lastReset }
    this.counters = new Map();

    // 用于按模块分组的 counter 索引：moduleName → Set<counterName>
    this.countersByModule = new Map();

    // module 名 → 最近 N 条错误（最新在前）
    this.lastErrors = new Map();

    // 自定义告警状态：name → { active, since, lastFiredAt, message, severity }
    this.alerts = new Map();

    // 快照历史
    this.snapshots = [];
    this.lastSnapshotCounters = new Map(); // 用于计算 delta

    this._heartbeatTimer = setInterval(() => this._checkHeartbeats(), HEARTBEAT_CHECK_INTERVAL_MS);
    this._snapshotTimer = setInterval(() => this._takeSnapshot(), SNAPSHOT_INTERVAL_MS);
  }

  stop() {
    clearInterval(this._heartbeatTimer);
    clearInterval(this._snapshotTimer);
  }

  // ============ Heartbeat ============

  /**
   * 注册模块心跳。staleMs 后未再次 beat → 触发告警。
   */
  registerModule(name, { staleMs = 30_000, label = name } = {}) {
    this.heartbeats.set(name, {
      lastBeatAt: Date.now(),
      staleMs,
      label,
      everBeat: false,
    });
  }

  beat(name, contextStr = null) {
    const h = this.heartbeats.get(name);
    if (!h) {
      // 自动注册（用默认 staleMs）
      this.registerModule(name);
      return this.beat(name, contextStr);
    }
    h.lastBeatAt = Date.now();
    h.everBeat = true;
    if (contextStr) h.lastContext = contextStr;
  }

  // ============ Counters ============

  inc(name, by = 1, moduleName = null) {
    const c = this.counters.get(name);
    if (c) {
      c.value += by;
    } else {
      this.counters.set(name, { value: by, lastReset: Date.now() });
      if (moduleName) {
        if (!this.countersByModule.has(moduleName)) {
          this.countersByModule.set(moduleName, new Set());
        }
        this.countersByModule.get(moduleName).add(name);
      }
    }
  }

  set(name, value, moduleName = null) {
    this.counters.set(name, { value, lastReset: Date.now() });
    if (moduleName) {
      if (!this.countersByModule.has(moduleName)) {
        this.countersByModule.set(moduleName, new Set());
      }
      this.countersByModule.get(moduleName).add(name);
    }
  }

  getCounter(name) {
    return this.counters.get(name)?.value ?? 0;
  }

  // ============ LastError ============

  /**
   * 记录错误。err 可以是 Error 或 string。
   */
  recordError(moduleName, err, context = {}) {
    const entry = {
      ts: Date.now(),
      message: err?.message || String(err),
      stack: err?.stack ? this._truncateStack(err.stack) : null,
      context: this._safeContext(context),
    };
    let arr = this.lastErrors.get(moduleName);
    if (!arr) {
      arr = [];
      this.lastErrors.set(moduleName, arr);
    }
    arr.unshift(entry);
    if (arr.length > ERROR_HISTORY_PER_MODULE) arr.length = ERROR_HISTORY_PER_MODULE;

    // 同时更新一个总计 counter
    this.inc(`${moduleName}.errors`, 1, moduleName);
  }

  _truncateStack(stack) {
    if (!stack) return null;
    const lines = stack.split('\n').slice(0, 6);
    return lines.join('\n');
  }

  _safeContext(ctx) {
    // 限制深度和长度，避免循环引用 / 大对象
    try {
      const json = JSON.stringify(ctx, (k, v) => {
        if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '...';
        return v;
      });
      if (json && json.length > 1000) return JSON.parse(json.slice(0, 1000) + '"}');
      return JSON.parse(json || '{}');
    } catch (_) {
      return { _serialize_failed: true };
    }
  }

  // ============ Alerts ============

  fireAlert(name, severity, message, context = {}) {
    const existing = this.alerts.get(name);
    const now = Date.now();
    if (existing && existing.active) {
      // 已经在告警中，更新最后触发时间
      existing.lastFiredAt = now;
      existing.message = message;
      existing.context = this._safeContext(context);
      return;
    }
    const alert = {
      name,
      severity, // 'warn' | 'error' | 'critical'
      active: true,
      since: now,
      lastFiredAt: now,
      message,
      context: this._safeContext(context),
    };
    this.alerts.set(name, alert);
    this.emit('alert', alert);
  }

  clearAlert(name) {
    const a = this.alerts.get(name);
    if (a && a.active) {
      a.active = false;
      a.clearedAt = Date.now();
      this.emit('alertCleared', a);
    }
  }

  // ============ Heartbeat 检查 ============

  _checkHeartbeats() {
    const now = Date.now();
    for (const [name, h] of this.heartbeats.entries()) {
      // 还没第一次 beat 的不算 STALE（启动初期）
      if (!h.everBeat) continue;
      const elapsed = now - h.lastBeatAt;
      const alertName = `heartbeat.${name}`;
      if (elapsed > h.staleMs) {
        this.fireAlert(alertName, 'error', `module ${name} stale for ${Math.round(elapsed / 1000)}s`, {
          module: name,
          elapsed_s: Math.round(elapsed / 1000),
          stale_threshold_s: Math.round(h.staleMs / 1000),
          last_context: h.lastContext,
        });
      } else {
        this.clearAlert(alertName);
      }
    }
  }

  // ============ Snapshot ============

  _takeSnapshot() {
    const now = Date.now();
    const counters = {};
    const deltas = {};

    for (const [name, c] of this.counters.entries()) {
      counters[name] = c.value;
      const prev = this.lastSnapshotCounters.get(name) || 0;
      deltas[name] = c.value - prev;
      this.lastSnapshotCounters.set(name, c.value);
    }

    const snap = {
      ts: now,
      counters,
      deltas,
      memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
    this.snapshots.push(snap);
    if (this.snapshots.length > SNAPSHOT_HISTORY) {
      this.snapshots.shift();
    }
  }

  // ============ Reporting ============

  /**
   * 完整健康报告（dashboard 和 CLI 都用这个）。
   */
  report() {
    const now = Date.now();
    const heartbeats = {};
    for (const [name, h] of this.heartbeats.entries()) {
      const elapsed = h.everBeat ? now - h.lastBeatAt : null;
      heartbeats[name] = {
        label: h.label,
        ever_beat: h.everBeat,
        last_beat_at: h.everBeat ? h.lastBeatAt : null,
        elapsed_ms: elapsed,
        stale_threshold_ms: h.staleMs,
        status: !h.everBeat
          ? 'NEVER_BEAT'
          : elapsed > h.staleMs
            ? 'STALE'
            : 'OK',
        last_context: h.lastContext || null,
      };
    }

    const moduleSummary = {};
    for (const [moduleName, counterNames] of this.countersByModule.entries()) {
      const m = {};
      for (const cn of counterNames) {
        m[cn] = this.counters.get(cn)?.value ?? 0;
      }
      moduleSummary[moduleName] = m;
    }

    const errors = {};
    for (const [moduleName, arr] of this.lastErrors.entries()) {
      errors[moduleName] = arr.slice(0, 5); // 只返回最近 5 条
    }

    const activeAlerts = [];
    for (const a of this.alerts.values()) {
      if (a.active) activeAlerts.push(a);
    }

    const overallStatus = activeAlerts.length === 0 ? 'OK' : 'DEGRADED';

    return {
      status: overallStatus,
      uptime_s: Math.round((now - this.startedAt) / 1000),
      mem_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ts: now,
      heartbeats,
      modules: moduleSummary,
      errors,
      active_alerts: activeAlerts,
      snapshots_recent: this.snapshots.slice(-12), // 最近 6 分钟
      counters_total: Object.fromEntries(
        Array.from(this.counters.entries()).map(([k, v]) => [k, v.value]),
      ),
    };
  }

  /**
   * 简短摘要（CLI 友好）。
   */
  summary() {
    const r = this.report();
    const lines = [];
    lines.push(`Status: ${r.status}`);
    lines.push(`Uptime: ${r.uptime_s}s, Memory: ${r.mem_mb} MB`);
    lines.push('');
    lines.push('=== Heartbeats ===');
    for (const [name, h] of Object.entries(r.heartbeats)) {
      const tag = h.status === 'OK' ? '✅' : h.status === 'STALE' ? '⚠️' : '⏳';
      const t = h.elapsed_ms != null ? `${Math.round(h.elapsed_ms / 1000)}s ago` : 'never';
      lines.push(`  ${tag} ${name}: ${h.status} (last beat ${t})`);
    }
    lines.push('');
    lines.push('=== Counters ===');
    for (const [moduleName, counters] of Object.entries(r.modules)) {
      lines.push(`  [${moduleName}]`);
      for (const [k, v] of Object.entries(counters)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
    if (r.active_alerts.length > 0) {
      lines.push('');
      lines.push('=== 🔔 ACTIVE ALERTS ===');
      for (const a of r.active_alerts) {
        const ago = Math.round((Date.now() - a.since) / 1000);
        lines.push(`  [${a.severity.toUpperCase()}] ${a.name}: ${a.message} (${ago}s ago)`);
      }
    }
    if (Object.keys(r.errors).length > 0) {
      lines.push('');
      lines.push('=== Recent Errors ===');
      for (const [moduleName, errs] of Object.entries(r.errors)) {
        if (errs.length === 0) continue;
        lines.push(`  [${moduleName}]`);
        for (const e of errs.slice(0, 3)) {
          const ago = Math.round((Date.now() - e.ts) / 1000);
          lines.push(`    - ${e.message} (${ago}s ago)`);
        }
      }
    }
    return lines.join('\n');
  }
}

// 单例：全局共享一个 monitor
let _instance = null;
function getMonitor() {
  if (!_instance) _instance = new HealthMonitor();
  return _instance;
}

module.exports = { HealthMonitor, getMonitor };
