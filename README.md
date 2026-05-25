# Hermes Backend

Hermes Command Center backend — ingests Telegram **Hermes hourly briefing** messages
via webhook, stores them in SQLite, derives open/close **trades** by diffing
consecutive open-position snapshots, and pushes live updates to the frontend over
WebSocket.

## Stack

- Node.js + TypeScript (strict)
- Express + Socket.io
- better-sqlite3 (synchronous, WAL mode)
- zod (input validation)
- pino + pino-pretty (logging)

## How it works

1. Hermes POSTs an hourly briefing to `POST /webhook/hermes`.
2. The message is parsed into a briefing, by-symbol rows, and an open-positions snapshot.
3. The new snapshot is diffed against the previous briefing's snapshot:
   - a position **hash present now but not before** → trade **OPEN**
   - a position **hash present before but not now** → trade **CLOSED** (exit price from the symbol's market source)
4. New briefing + opened/closed trades are broadcast over Socket.io.

`position_hash = md5(symbol|side|entry_price|strategy)` gives each open position a
stable identity across briefings.

### Markets & price sources

Each trade symbol is classified into a market and priced from the matching source:

- **CRYPTO** — Binance (`BINANCE_API_BASE`). Pairs carry a quote suffix (`BTCUSDT`).
- **BIST** (Borsa İstanbul equities) — Yahoo Finance (`YAHOO_API_BASE`), addressed as
  `<TICKER>.IS` (e.g. `THYAO` → `THYAO.IS`). Bare tickers are treated as BIST; set
  `BIST_SYMBOLS` to force-classify any edge case.

Live prices, exit prices on close, and `/charts` all route through this, so BIST
positions appear alongside crypto. A symbol with no quote yet (e.g. BIST outside
trading hours) is still surfaced in `pnl:update` with a `null` price rather than
dropped. The resolved market is exposed as `market` on trade and live-position payloads.

## Local development

```bash
npm install
cp .env.example .env        # then fill AUTH_TOKEN / WEBHOOK_SECRET
# point DB_PATH/LOG_PATH at local paths, e.g. ./hermes.db and ./app.log
npm run dev                 # tsx watch, pino-pretty to stdout
```

Generate strong secrets:

```bash
openssl rand -hex 32
```

## Build

```bash
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
```

## VPS deploy (PM2)

```bash
cd /opt && git clone <repo>
cd hermes-backend && npm install
cp .env.example .env        # fill in secrets + paths
mkdir -p /var/lib/hermes /var/log/hermes
npm run build
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

> `better-sqlite3` is a native module. On Linux x64 with a current LTS Node it
> installs a prebuilt binary; if no prebuild matches your Node version it compiles
> from source (needs `build-essential` + `python3`).

## API

All routes except `/health` require `Authorization: Bearer <AUTH_TOKEN>`.
The webhook requires `Authorization: Bearer <WEBHOOK_SECRET>`.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/webhook/hermes` | WEBHOOK_SECRET | `{ message, timestamp? }` |
| GET | `/health` | none | uptime, db_ok, last_briefing_at, version |
| GET | `/briefings?limit=24` | AUTH_TOKEN | limit 1–168 (default 24) |
| GET | `/trades?status=OPEN&symbol=BTCUSDT&limit=100` | AUTH_TOKEN | filtered list |
| GET | `/trades/stats?window=24h` | AUTH_TOKEN | window: `24h`\|`7d`\|`30d`\|`all` |
| GET | `/agents` | AUTH_TOKEN | pm2 process list + status; `commandable` flag |
| GET | `/agents/:name/logs?lines=200` | AUTH_TOKEN | recent pm2 log lines (allowlisted name) |
| POST | `/agents/:name/action` | AUTH_TOKEN | `{ action: restart\|stop\|start }`, audited |
| POST | `/agents/command` | AUTH_TOKEN | `{ command: STOP_BOT\|GET_STATUS\|CLOSE_ALL_POSITIONS }`, audited |

`/trades/stats` returns `win_count`/`loss_count`, `win_rate`/`loss_rate` (fractions
of closed trades with a known P&L; they sum to 1), `win_loss_ratio`, `profit_factor`,
and per-`by_symbol`/`by_strategy` breakdowns with the same win/loss fields.

### Agent control (VPS Agent tab)

The `/agents` routes power the dashboard's agent console. Status/logs come from
`pm2` (the backend shells out with fixed, validated args — no shell, process names
allowlisted via `AGENT_PM2_NAMES`). `/agents/command` forwards `STOP_BOT` /
`GET_STATUS` / `CLOSE_ALL_POSITIONS` to the trading bot's command webhook
(`BOT_COMMAND_URL` + `BOT_AUTH_TOKEN`, same contract as the Hermes Agent). Every
action/command is written to the `events` table (`AGENT_ACTION` / `AGENT_COMMAND`)
for audit. Destructive commands are expected to be confirmed client-side.

### Socket.io

Connect with `auth: { token: <AUTH_TOKEN> }`. Events emitted:
`briefing:new`, `trade:open`, `trade:close`, `stats:update`.

## Smoke test

With the server running on port 4000 (Windows `cmd`):

```bat
curl -X POST http://localhost:4000/webhook/hermes ^
  -H "Authorization: Bearer change-me-with-openssl-rand-hex-32" ^
  -H "Content-Type: application/json" ^
  --data-binary "@test-payload.json"
```

Expected: `{ "ok": true, "briefing_id": 1, "opened_count": 2, "closed_count": 0, "parsed": { ... } }`
