# Dump Sniper V3

Solana memecoin dump-rebound sniper. Listens for large sell orders with high price impact, executes counter-trade buys via **direct Pump.fun AMM SDK** (no Jupiter), exits on rebound or timeout.

> **v3 vs v2**: Switched from Jupiter V6 to direct Pump.fun AMM SDK — saves 100-200ms per trade.

---

## v3 关键变化

| 维度 | v2 (Jupiter V6) | v3 (Pump SDK 直调) |
|---|---|---|
| Quote 调用 | 80-150ms HTTP 跨洋 | 30-80ms RPC（同区域 staked） |
| Swap tx 构建 | 80-150ms HTTP | <10ms 本地 |
| 总延迟 (quote→落链前) | 210-350ms | **90-140ms** |
| 适配 Pump 程序升级 | 受 Jupiter 路由器影响 | SDK 自动跟随升级 |
| 多池子代币（含非 Pump 池）| 自动选最优 | 仅 Pump 池 |

**为什么改**：观察 Solana 链上正在做这种策略的 sniper 钱包，**全部走 Pump.fun AMM 直调**，没有一个走 Jupiter。原因：Jupiter HTTP API 慢 100-200ms，在 400ms 一个 slot 的窗口里足以错过最佳反弹点。

---

## Strategy

When a wallet dumps ≥ 10 SOL of a watched token causing ≥ 10% single-tx price impact:
1. **Buy** 0.1 SOL worth via Pump AMM SDK within 1-2 slots (~400-800ms after the dump tx)
2. Wait for rebound:
   - **+8% rebound** (with double-confirmation): take profit
   - **-15% further drop** (emergency stop): cut losses
   - **15s timeout**: exit at market

All thresholds are configurable in `.env`.

---

## Quick start

```bash
npm install
cp .env.example .env
vim .env   # fill in HELIUS_*, BIRDEYE_API_KEY, WALLET_PRIVATE_KEY_BS58
           # KEEP DRY_RUN=true initially!
npm start
open http://localhost:3001
```

Add tokens via dashboard, webhook, or batch API:

```bash
curl -X POST http://localhost:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump","symbol":"Nana"}'
```

---

## Architecture

```
LaserStream gRPC (FRA)
      │ tx
      ▼
   TickStream  ──────────────► HealthMonitor ◄──── AlertChecker
      │ raw tx                                          │
      ▼                                                 │
  DumpDetector  (precise pool ID via known vaults)      │
      │                                                 │
      ├──► priceTick                                    │
      │      │                                          │
      ▼      ▼                                          │
  PriceTracker (anomaly filter)                         │
      │                                                 │
      │ update                                          │
      ▼                                                 │
  PositionManager (2x confirm TP + emergency stop)      │
      ▲                       │                         │
      │ buyOrder              │ sell()                  │
      │                       ▼                         │
  SignalEngine ─────► Executor (Pump SDK direct → Helius staked/Sender)
      ▲                              │
      │ dumpSignal                   ▼
      └─── DumpDetector       @pump-fun/pump-swap-sdk
                              (官方 SDK，自动跟随程序升级)
```

**Data layer**: SQLite (`data/sniper.db`) — `tokens`, `signals`, `trades`, `positions` tables. WAL mode, restart-safe.

**Persistence**: All open positions are restored from DB on startup. Tokens persist. Trades/signals/positions are append-only.

---

## Configuration

See `.env.example` for full reference. Key knobs:

| Var | Default | Purpose |
|---|---|---|
| `DRY_RUN` | `true` | Simulate trades without real funds |
| `MIN_SELL_SOL` | `10.0` | Min trigger sell size |
| `MIN_PRICE_IMPACT_PCT` | `10.0` | Min single-tx drop to trigger |
| `POSITION_SIZE_SOL` | `0.1` | Per-trade size — start small! |
| `TAKE_PROFIT_PCT` | `8.0` | Take-profit % |
| `TP_CONFIRM_COUNT` | `2` | Require N consecutive ticks at TP |
| `TP_CONFIRM_MIN_GAP_MS` | `300` | Min ms between confirmation ticks |
| `EMERGENCY_STOP_LOSS_PCT` | `-15.0` | Hard stop loss |
| `MAX_HOLD_MS` | `15000` | Forced timeout exit |
| `BUY_SLIPPAGE_BPS` | `1500` | 15% slippage on buy |
| `SELL_SLIPPAGE_BPS` | `2000` | 20% slippage on sell |
| `COMPUTE_UNIT_LIMIT` | `300000` | Per-tx compute units (Pump CPI 需要余量) |
| `MAX_PRIORITY_FEE_LAMPORTS` | `5000000` | Priority fee 上限 0.005 SOL |
| `HELIUS_SENDER_ENDPOINT` | (empty) | Helius Sender (optional, faster submits) |
| `PRICE_MAX_JUMP_RATIO` | `1.5` | Reject ticks with >50% jump unless confirmed |

---

## Operations

```bash
# Health check (CLI)
npm run health
HEALTH_URL=http://server:3001 npm run health
npm run health:json | jq .active_alerts

# Backfill pool info for tokens (auto-runs on startup, but can run manually)
npm run fill-pools                    # only those missing pool info
npm run fill-pools -- --all           # refresh all
npm run fill-pools MINT1 MINT2        # specific mints

# Generate yesterday's report manually
curl -X POST http://localhost:3001/api/reports/generate -d '{}'
```

---

## Health monitoring

The bot has a built-in 3-layer health system:

- **Heartbeats**: each module reports liveness; STALE → fires alert
- **Counters**: every event tracked (txReceived, dumpSignals, buySuccess, etc.)
- **LastErrors**: last 20 errors per module with context (mint, signature, phase)

**Auto-fired alerts**:
| Alert | Severity | Triggers when |
|---|---|---|
| `tickstream.no_traffic` | warn | Watching tokens but 60s+ no tx |
| `executor.buy_failures` | error | BUY fail rate ≥ 60% |
| `executor.sell_failures` | critical | SELL fail rate ≥ 60% (funds may be stuck) |
| `positions.stuck` | critical | Position past `maxHoldMs+5s` not yet exited |
| `detector.high_parse_error_rate` | warn | DumpDetector parse errors > 10% |

View via `npm run health`, `GET /api/health`, or the Dashboard's bottom panel.

---

## Deployment (systemd)

```bash
# On server
sudo bash deploy/install.sh /opt/dump-sniper

# Edit config
sudo -u ubuntu vim /opt/dump-sniper/.env

# Start
sudo systemctl start dump-sniper
sudo systemctl enable dump-sniper

# Logs
sudo journalctl -u dump-sniper -f
```

---

## Important: SDK 跟随程序升级

`@pump-fun/pump-swap-sdk` 是 Pump.fun 官方维护，每次程序升级都会同步更新。**升级时你需要做：**

1. 查看 [pump-public-docs](https://github.com/pump-fun/pump-public-docs) 或 [@pump_tech_updates Telegram](https://t.me/pump_tech_updates) 是否有升级公告
2. 升级公告通常提前 7-14 天
3. 升级时 `npm update @pump-fun/pump-swap-sdk` 然后重启服务

**历史升级记录** (这些都已经被 SDK 处理了，无需手动改代码)：
- 2025-08-01: 加 `global_volume_accumulator` / `user_volume_accumulator`
- 2025-09-01: 加 `fee_config` / `fee_program` (动态 fee)
- 2025-11-04: pool 账户改为 mutable
- 2025-11-12: Mayhem mode + 7 new fee recipients
- 2025-12: Cashback rewards (backwards compatible)

---

## Migration from v1/v2

v3 fixes 4 critical bugs that caused real money loss in v1, AND fixes the Jupiter latency issue from v2:

| Bug | Fix |
|---|---|
| (v1) Direct Pump AMM ix calls fail (Pump upgraded to 301-byte pool) | (v2) Jupiter V6 → (v3) **Official Pump SDK auto-tracks upgrades** |
| (v1) DumpDetector heuristic "biggest balance = pool" → polluted prices | Use known `pool_base_vault`/`pool_quote_vault` from registry |
| (v1) Single price spike triggered TAKE_PROFIT → SELL at lower real price | Double-confirm: 2 ticks at TP, 300ms apart |
| (v1) -98% catastrophic dumps held to timeout | Emergency stop at -15% (configurable) |
| (v2) Jupiter HTTP latency 200-300ms ate sniper window | Direct SDK call: 30-80ms RPC + <10ms local construct |

**Migration steps**:

1. **Back up your DB**: `cp /opt/dump-sniper-v1/data/sniper.db ~/sniper.db.bak`
2. **Stop old version**: `sudo systemctl stop dump-sniper`
3. **Install v3**: `sudo bash deploy/install.sh /opt/dump-sniper`
4. **Copy DB** (schema is compatible — auto-migrates): `sudo cp ~/sniper.db.bak /opt/dump-sniper/data/sniper.db && sudo chown ubuntu:ubuntu /opt/dump-sniper/data/sniper.db`
5. **Update `.env`** — remove `JUPITER_*` vars (v3 doesn't use Jupiter), add v3 vars (see `.env.example`):
   - `COMPUTE_UNIT_LIMIT=300000`
   - `EMERGENCY_STOP_LOSS_PCT=-15.0`
   - `TP_CONFIRM_COUNT=2`
   - `POSITION_SIZE_SOL=0.1` (start small)
6. **Backfill pool info**: `cd /opt/dump-sniper && npm run fill-pools`
7. **DRY_RUN first**: keep `DRY_RUN=true` for 24h, watch `npm run health` and dashboard
8. **Start**: `sudo systemctl start dump-sniper`

After 24h DRY_RUN, query SQLite to validate:

```sql
SELECT exit_reason, COUNT(*), ROUND(AVG(pnl_pct),2) as avg_pnl
FROM positions WHERE closed_at IS NOT NULL
  AND opened_at > strftime('%s','now','-24 hours')*1000
GROUP BY exit_reason;
```

Healthy: `TAKE_PROFIT.avg_pnl > +6%`. v1 bug had this NEGATIVE.

---

## File structure

```
src/
├── core/
│   ├── TickStream.js         LaserStream gRPC subscription
│   ├── DumpDetector.js       precise pool-vault parsing → priceTick / dumpSignal
│   ├── PriceTracker.js       anomaly filter + double-confirm gating
│   ├── SignalEngine.js       cooldown / concurrency / self-trigger filter
│   ├── Executor.js           Pump SDK direct → Helius staked/Sender (NO Jupiter)
│   └── PositionManager.js    100ms tick + double-confirm TP + emergency stop + sell retry
├── data/
│   ├── TokenRegistry.js      tokens table + in-memory active set + pool info cache
│   └── TradeLogger.js        signals/trades/positions tables
├── monitor/
│   ├── HealthMonitor.js      heartbeats / counters / lastErrors
│   └── AlertChecker.js       business rule alerts
├── reports/
│   └── DailyReport.js        BJT 08:00 markdown reports
├── server/
│   ├── server.js             Express + WebSocket
│   └── public/dashboard.html
├── utils/
│   ├── poolFinder.js         Helius Enhanced Tx → auto pool/vault discovery
│   ├── tokenMeta.js          Helius DAS + Birdeye market data
│   ├── priorityFee.js        Helius getPriorityFeeEstimate (legacy helper)
│   └── bjt.js                Beijing time utilities
├── config.js
└── index.js
scripts/
├── health.js                 CLI health check
└── fill-pools.js             CLI pool backfill
deploy/
├── dump-sniper.service       systemd unit
├── install.sh                installer
└── logrotate.conf
```

---

## License

Private — for personal use only.
