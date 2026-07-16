# ROUNDBOX spend attribution (fork addition)

> **This directory is a ROUNDBOX addition to the Portkey fork — not upstream.**
> It is self-contained precisely so upstream parity merges stay conflict-free.
> The only edits to upstream files are marked `>>> ROUNDBOX ADDITION` blocks in
> `src/index.ts` (one import + one `app.use`) and `src/start-server.ts` (start
> the worker). Keep it that way.

## What it does

Per completed `/v1` request, a non-blocking middleware (mirrors upstream
`logHandler`) builds an attributed **UsageEvent** and enqueues it to a durable
**BullMQ (Redis)** queue. A worker delivers each event to BlackGate's
**signed metering webhook** with retry + exponential backoff. Nothing billable
is lost: failed jobs are retained (`removeOnFail:false`) as a dead-letter, and
every event is also written as a structured stdout line (recoverable from Azure
Monitor) even if Redis or the webhook is down.

Identity rides Portkey's native `x-portkey-metadata` header
(`{"partnerId","clientId","keyId","requestId"}`) — no custom headers, so merges
stay clean. **Billing math stays in BlackGate** (authoritative dual-ledger,
dedupes on `requestId`); the gateway only attributes + emits.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `RBX_SPEND_ENABLED` | `true` if webhook URL set | Master switch |
| `RBX_SPEND_WEBHOOK_URL` | — | BlackGate metering ingest URL |
| `RBX_SPEND_WEBHOOK_SECRET` | — | HMAC-SHA256 signing secret (`x-roundbox-signature`) |
| `RBX_SPEND_REDIS_URL` / `REDIS_URL` | `redis://localhost:6379` | BullMQ Redis |
| `RBX_SPEND_QUEUE` | `roundbox-spend` | Queue name |
| `RBX_SPEND_MAX_ATTEMPTS` | `25` | Delivery attempts before dead-letter |
| `RBX_SPEND_BACKOFF_MS` | `5000` | Exponential backoff base |
| `RBX_SPEND_LOG` | `true` | Structured stdout backstop |

## Runtime

BullMQ requires **Node** (the ROUNDBOX deploy target). The queue is loaded via
dynamic import and the worker starts only from the Node entrypoint, so the
`workerd`/wrangler bundle is unaffected. Running the gateway on workerd would
need the spend module externalized.

## Known follow-up

**Stream usage:** streamed responses currently emit `streamed:true` with null
token counts (the provider's `include_usage` final chunk isn't parsed in the
middleware yet). Until wired, BlackGate reconciles stream usage from the
response it receives. Non-streamed usage is captured exactly.
