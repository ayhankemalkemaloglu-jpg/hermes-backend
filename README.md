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
   - a position **hash present before but not now** → trade **CLOSED** (exit price from Binance)
4. New briefing + opened/closed trades are broadcast over Socket.io.

`position_hash = md5(symbol|side|entry_price|strategy)` gives each open position a
stable identity across briefings.

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
