'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { config } = require('../config');
const TokenRegistry = require('../data/TokenRegistry');

class Server {
  constructor({
    tokenRegistry,
    tradeLogger,
    positionManager,
    signalEngine,
    dailyReport,
    onTokenListChanged,
    onTokenAdded,
  }) {
    this.tokenRegistry = tokenRegistry;
    this.tradeLogger = tradeLogger;
    this.positionManager = positionManager;
    this.signalEngine = signalEngine;
    this.dailyReport = dailyReport;
    this.onTokenListChanged = onTokenListChanged;
    this.onTokenAdded = onTokenAdded;

    this.app = express();
    this.app.use(express.json({ limit: '64kb' }));

    // 可选：dashboard 访问保护（X-Dashboard-Token header / ?token= query）
    if (config.server.dashboardToken) {
      this.app.use('/api', this._authMiddleware());
      this.app.use('/dashboard.html', this._authMiddleware());
      this.app.use('/index.html', this._authMiddleware());
      this.app.use('/', (req, res, next) => {
        if (req.path === '/' || req.path === '/health') return next();
        return next();
      });
    }

    this.app.use(express.static(path.join(__dirname, 'public')));

    this._setupRoutes();

    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: '/ws',
      verifyClient: (info, cb) => {
        if (!config.server.dashboardToken) return cb(true);
        try {
          const url = new URL(info.req.url, 'http://localhost');
          const token = url.searchParams.get('token');
          if (token === config.server.dashboardToken) return cb(true);
          return cb(false, 401, 'Unauthorized');
        } catch (_) {
          return cb(false, 401, 'Unauthorized');
        }
      },
    });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', dryRun: config.DRY_RUN, ts: Date.now() }));
    });
  }

  _authMiddleware() {
    const token = config.server.dashboardToken;
    return (req, res, next) => {
      const provided = req.headers['x-dashboard-token'] || req.query.token;
      if (provided !== token) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      next();
    };
  }

  _validateWebhookSecret(req) {
    if (!config.server.webhookSecret) return true; // 未配置则跳过
    const provided =
      req.headers['x-webhook-secret'] ||
      req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    return provided === config.server.webhookSecret;
  }

  _setupRoutes() {
    const app = this.app;

    // ============ Webhook ============
    app.post('/webhook/add-token', async (req, res) => {
      try {
        if (!this._validateWebhookSecret(req)) {
          return res.status(401).json({ ok: false, error: 'invalid webhook secret' });
        }
        const { network, address, symbol } = req.body || {};
        if (network && network.toLowerCase() !== 'solana') {
          return res.status(400).json({ ok: false, error: 'only solana network supported' });
        }
        if (!address || typeof address !== 'string') {
          return res.status(400).json({ ok: false, error: 'address required' });
        }
        try {
          TokenRegistry.validateMint(address);
        } catch (err) {
          return res.status(400).json({ ok: false, error: err.message });
        }
        const token = await this.tokenRegistry.addToken(address, { symbol, source: 'webhook' });
        if (this.onTokenListChanged) this.onTokenListChanged();
        if (this.onTokenAdded) this.onTokenAdded(token);
        this.broadcast({ type: 'tokenAdded', token });
        res.json({ ok: true, token });
      } catch (err) {
        console.error(`[webhook] add-token error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ============ Token list ============
    app.get('/api/tokens', (req, res) => {
      res.json({ ok: true, tokens: this.tokenRegistry.listAll() });
    });

    app.post('/api/tokens', async (req, res) => {
      try {
        const { address, symbol } = req.body || {};
        if (!address) return res.status(400).json({ ok: false, error: 'address required' });
        try {
          TokenRegistry.validateMint(address);
        } catch (err) {
          return res.status(400).json({ ok: false, error: err.message });
        }
        const token = await this.tokenRegistry.addToken(address, { symbol, source: 'manual' });
        if (this.onTokenListChanged) this.onTokenListChanged();
        if (this.onTokenAdded) this.onTokenAdded(token);
        this.broadcast({ type: 'tokenAdded', token });
        res.json({ ok: true, token });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    /**
     * 批量添加：避免每次添加都触发 LaserStream 重建。
     * Body: { tokens: [{ address, symbol }, ...] }
     */
    app.post('/api/tokens/batch', async (req, res) => {
      try {
        const { tokens } = req.body || {};
        if (!Array.isArray(tokens) || tokens.length === 0) {
          return res.status(400).json({ ok: false, error: 'tokens array required' });
        }
        const results = [];
        const errors = [];
        for (const t of tokens) {
          try {
            TokenRegistry.validateMint(t.address);
            const token = await this.tokenRegistry.addToken(t.address, {
              symbol: t.symbol,
              source: 'batch',
            });
            results.push(token);
            if (this.onTokenAdded) this.onTokenAdded(token);
          } catch (err) {
            errors.push({ address: t.address, error: err.message });
          }
        }
        // 全部加完后只通知一次（重建 LaserStream 一次）
        if (this.onTokenListChanged) this.onTokenListChanged();
        this.broadcast({ type: 'tokensAdded', count: results.length });
        res.json({ ok: true, added: results.length, failed: errors.length, errors });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.delete('/api/tokens/:mint', (req, res) => {
      try {
        this.tokenRegistry.removeToken(req.params.mint);
        if (this.onTokenListChanged) this.onTokenListChanged();
        this.broadcast({ type: 'tokenRemoved', mint: req.params.mint });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ============ Logs ============
    app.get('/api/signals', (req, res) => {
      const limit = parseInt(req.query.limit || '100', 10);
      res.json({ ok: true, signals: this.tradeLogger.getRecentSignals(limit) });
    });

    app.get('/api/trades', (req, res) => {
      const limit = parseInt(req.query.limit || '100', 10);
      res.json({ ok: true, trades: this.tradeLogger.getRecentTrades(limit) });
    });

    app.get('/api/positions', (req, res) => {
      const limit = parseInt(req.query.limit || '100', 10);
      res.json({
        ok: true,
        open: this.positionManager.listOpen(),
        recent: this.tradeLogger.getRecentPositions(limit),
      });
    });

    // ============ Manual report trigger ============
    app.post('/api/reports/generate', async (req, res) => {
      try {
        const { date } = req.body || {};
        const target = date ? new Date(date) : new Date(Date.now() - 24 * 60 * 60 * 1000);
        const filepath = await this.dailyReport.generateForDate(target);
        res.json({ ok: true, filepath });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ============ Status ============
    app.get('/api/status', (req, res) => {
      res.json({
        ok: true,
        dryRun: config.DRY_RUN,
        watchedTokens: this.tokenRegistry.listActive().length,
        openPositions: this.positionManager.openPositionCount(),
        config: {
          minSellSol: config.strategy.minSellSol,
          minPriceImpactPct: config.strategy.minPriceImpactPct,
          positionSizeSol: config.strategy.positionSizeSol,
          takeProfitPct: config.strategy.takeProfitPct,
          maxHoldMs: config.strategy.maxHoldMs,
        },
      });
    });

    app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

    // ============ 健康监控 ============
    app.get('/api/health', (req, res) => {
      const { getMonitor } = require('../monitor/HealthMonitor');
      res.json({ ok: true, report: getMonitor().report() });
    });

    app.get('/api/health/summary', (req, res) => {
      const { getMonitor } = require('../monitor/HealthMonitor');
      res.type('text/plain').send(getMonitor().summary());
    });
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        try { client.send(data); } catch (_) {}
      }
    }
  }

  start() {
    const host = config.server.bindHost || '0.0.0.0';
    this.httpServer.listen(config.server.port, host, () => {
      console.log(`[Server] listening on ${host}:${config.server.port}`);
      console.log(`[Server] dashboard: http://${host}:${config.server.port}`);
      console.log(`[Server] webhook:   POST http://${host}:${config.server.port}/webhook/add-token`);
      if (config.server.webhookSecret) console.log('[Server] webhook secret: ENABLED');
      if (config.server.dashboardToken) console.log('[Server] dashboard auth: ENABLED');
    });
  }
}

module.exports = Server;
