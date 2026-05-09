'use strict';

/**
 * TickStream
 * ==========
 * 订阅 Helius LaserStream gRPC，过滤涉及 Pump AMM 程序且与监控代币 mint 相关的交易。
 *
 * 关键修复（v1.1）：
 * - 监控列表为空时不订阅（避免误订全网 Pump 流量）
 * - accountInclude=[mints] + accountRequired=[PUMP_AMM_PROGRAM]：tx 必须涉及 Pump
 *   程序 AND 至少涉及一个监控代币
 * - 监控列表变化时重建 stream（yellowstone-grpc 的 write 不一定替换旧过滤器，
 *   重建是最稳妥的）
 * - 自动重连 + 指数退避
 */

const Client = require('@triton-one/yellowstone-grpc').default;
const { CommitmentLevel } = require('@triton-one/yellowstone-grpc');
const EventEmitter = require('events');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const PUMP_AMM_PROGRAM_ID = config.programs.pumpAmm; // string

const monitor = getMonitor();
monitor.registerModule('TickStream', { staleMs: 90_000, label: 'LaserStream gRPC' });

class TickStream extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.stream = null;
    this.watchedMints = new Set();
    this.connected = false;
    this.reconnectAttempts = 0;
    this.shouldRun = false;
    this._rebuildPending = false;
  }

  async start(initialMints = []) {
    this.shouldRun = true;
    initialMints.forEach((m) => this.watchedMints.add(m));
    if (this.watchedMints.size === 0) {
      console.log('[TickStream] no tokens to watch yet, idle');
      return;
    }
    await this._connect();
  }

  async stop() {
    this.shouldRun = false;
    await this._closeStream();
  }

  async _closeStream() {
    if (this.stream) {
      try { this.stream.end(); } catch (_) {}
      this.stream = null;
    }
    if (this.client) {
      try {
        // yellowstone client 通常没有显式 close，但置 null 让 GC 处理
        this.client = null;
      } catch (_) {}
    }
    this.connected = false;
  }

  async _connect() {
    if (this.watchedMints.size === 0) {
      console.log('[TickStream] no mints to watch, skipping connect');
      return;
    }
    try {
      this.client = new Client(
        config.helius.laserstreamEndpoint,
        config.helius.laserstreamToken,
        { 'grpc.max_receive_message_length': 64 * 1024 * 1024 },
      );
      this.stream = await this.client.subscribe();

      this.stream.on('data', (msg) => this._handleMessage(msg));
      this.stream.on('error', (err) => this._handleError(err));
      this.stream.on('end', () => this._handleEnd());
      this.stream.on('close', () => this._handleEnd());

      await this._sendSubscribeRequest();
      this.connected = true;
      this.reconnectAttempts = 0;
      monitor.inc('TickStream.connectsTotal', 1, 'TickStream');
      monitor.beat('TickStream', `connected:${this.watchedMints.size}_mints`);
      console.log(`[TickStream] connected, watching ${this.watchedMints.size} mints`);
      this.emit('connected');
    } catch (err) {
      monitor.recordError('TickStream', err, { phase: 'connect' });
      console.error(`[TickStream] connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  async _sendSubscribeRequest() {
    const mints = Array.from(this.watchedMints);
    if (mints.length === 0) return;

    // 语义：tx 必须涉及 Pump AMM 程序（accountRequired），并且必须涉及 mints 之一
    // (accountInclude 是 OR 关系，但 accountRequired 是 AND；同时使用时是 AND 后的 OR
    // —— 也就是必须有 Pump AMM **且** 命中 accountInclude 的至少一项)
    const request = {
      transactions: {
        pumpAmmTrades: {
          vote: false,
          failed: false,
          accountInclude: mints,
          accountExclude: [],
          accountRequired: [PUMP_AMM_PROGRAM_ID],
        },
      },
      slots: {},
      accounts: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      transactionsStatus: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    };

    return new Promise((resolve, reject) => {
      this.stream.write(request, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * 监控列表变化时调用，重建 stream（最稳妥）。
   *
   * 关键修复：
   * - 2 秒防抖（批量添加大量代币时，最后一次再 rebuild，前面的全部丢弃）
   * - 互斥锁：上一次 rebuild 没完成时，新的 rebuild 会等
   * - 真正等 close 完成（包括 gRPC 连接的资源释放）才开新连接
   */
  async updateSubscription(mints) {
    this.watchedMints = new Set(mints);
    // 取消上一次未触发的定时器，重新计时（真正的 trailing-edge debounce）
    if (this._rebuildTimer) {
      clearTimeout(this._rebuildTimer);
    }
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      this._performRebuild().catch((err) => {
        monitor.recordError('TickStream', err, { phase: 'rebuild' });
        console.error(`[TickStream] rebuild failed: ${err.message}`);
      });
    }, 2000);
  }

  async _performRebuild() {
    // 互斥：上一次 rebuild 还在进行中，等它完成
    if (this._rebuildInProgress) {
      this._rebuildQueued = true;
      return;
    }
    this._rebuildInProgress = true;
    try {
      do {
        this._rebuildQueued = false;
        const targetMints = new Set(this.watchedMints);
        console.log(`[TickStream] subscription change → rebuilding (${targetMints.size} mints)`);
        await this._closeStream();
        // 给 gRPC 客户端充分时间释放底层 socket（重要：避免 RESOURCE_EXHAUSTED）
        await new Promise((r) => setTimeout(r, 500));
        if (this.shouldRun && targetMints.size > 0) {
          await this._connect();
        }
      } while (this._rebuildQueued); // 期间又有新变化就再来一次
    } finally {
      this._rebuildInProgress = false;
    }
  }

  _handleMessage(msg) {
    if (!msg.transaction) return;
    monitor.inc('TickStream.txReceived', 1, 'TickStream');
    monitor.beat('TickStream', 'tx');
    this.emit('transaction', msg.transaction);
  }

  _handleError(err) {
    monitor.inc('TickStream.streamErrors', 1, 'TickStream');
    monitor.recordError('TickStream', err, { phase: 'stream' });
    console.error(`[TickStream] stream error: ${err.message || err}`);
    this.connected = false;
    this._scheduleReconnect();
  }

  _handleEnd() {
    if (!this.shouldRun) return;
    monitor.inc('TickStream.streamEnded', 1, 'TickStream');
    console.warn('[TickStream] stream ended');
    this.connected = false;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.shouldRun || this.watchedMints.size === 0) return;
    monitor.inc('TickStream.reconnects', 1, 'TickStream');
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    console.log(`[TickStream] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (!this.shouldRun) return;
      this._connect();
    }, delay);
  }
}

module.exports = TickStream;
