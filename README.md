# Webhook Delivery Engine

A production-grade webhook delivery system with reliable event delivery, automatic retries, exponential backoff, HMAC signature verification, circuit breakers, and a real-time monitoring dashboard.

---

## Table of Contents

- [Architecture](#architecture)
- [Setup & Run](#setup--run)
- [Using the Dashboard](#using-the-dashboard)
- [Step-by-Step Guide](#step-by-step-guide)
- [API Reference](#api-reference)
- [Signature Verification](#signature-verification)
- [Retry Behavior](#retry-behavior)
- [4 Self-Initiated Improvements](#4-self-initiated-improvements)
- [Bonus: Scaling to 100,000+ Deliveries/min](#bonus-scaling-to-100000-deliveriesmin)
- [Project Structure](#project-structure)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Dashboard                          │
│         Register · Trigger · Monitor · Retry                 │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP
┌────────────────────────▼────────────────────────────────────┐
│                   Express API Server                          │
│   /api/endpoints   /api/events   /api/deliveries             │
│   Rate Limiting · Helmet · CORS · Morgan                     │
└────────────┬──────────────────────────┬─────────────────────┘
             │                          │
┌────────────▼──────────┐  ┌───────────▼─────────────────────┐
│    SQLite Database     │  │    Background Delivery Worker    │
│  endpoints            │  │  Polls every 2s                  │
│  events               │  │  Processes up to 10 in parallel  │
│  deliveries           │  │  Exponential backoff scheduling  │
│  delivery_attempts    │  │  Circuit breaker checks          │
│  circuit_breakers     │  └──────────────┬──────────────────┘
└───────────────────────┘                 │ HTTP POST
                          ┌───────────────▼──────────────────┐
                          │      Subscriber Endpoints         │
                          │   HMAC-SHA256 signed requests     │
                          │   X-Webhook-Signature header      │
                          └──────────────────────────────────┘
```

### How the Delivery Engine Works Internally

1. **Event Trigger** — `POST /api/events/trigger` stores the event and immediately calls `queueDeliveries()`. This finds all active endpoints subscribed to the event type and inserts a `delivery` row with status `pending`. The HTTP response returns instantly with `202 Accepted` — no waiting for delivery.

2. **Background Worker** — A `setInterval` loop runs every 2 seconds. It queries for deliveries where `status IN ('pending', 'retrying') AND next_retry_at <= NOW()`, then processes up to 10 in parallel via `Promise.allSettled`.

3. **Attempt Execution** — For each delivery, the worker checks the circuit breaker state, builds the HMAC-SHA256 signature, and fires an HTTP POST to the target URL with all webhook headers.

4. **Outcome Recording** — Every attempt is logged in `delivery_attempts`. On success, the delivery is marked `delivered`. On failure, `shouldRetry()` checks the status code and attempt count. Retriable failures get a new `next_retry_at` calculated using exponential backoff.

5. **Permanent Failure** — After `max_retries` exhausted attempts, the delivery is marked `failed`. It is never deleted — it stays visible in the dashboard and can be manually retried at any time.

---

## Setup & Run

### Prerequisites

- Node.js 18+

### Installation

```bash
git clone <your-repo-url>
cd webhook-engine
npm install
cp .env.example .env
npm start
```

Open **http://localhost:3000** to access the monitoring dashboard.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | Environment |

### Run Tests

```bash
npm test
```

51 integration tests covering all API routes, HMAC signature logic, exponential backoff formula, and the full circuit breaker state machine.

---

## Using the Dashboard

Everything you need is in the browser at `http://localhost:3000`. You do not need curl or any external tool to operate this system.

**Left column**
- **Trigger Test Event** — fire an event by type and optional JSON payload. Returns 202 immediately.
- **Register Endpoint** — subscribe a URL to one or more event types. Configure timeout, max retries, and backoff base. Leave secret blank to auto-generate.

**Right column**
- **Registered Endpoints table** — shows every endpoint with health badge, circuit breaker state, delivery policy, and action buttons (Rotate Secret, Delete).
- **Endpoint Delivery History** — click any endpoint row to load its full attempt history below, showing status, HTTP code, response time, attempt number, timestamp, and error for every attempt ever made.
- **Permanently Failed Deliveries** — deliveries that exhausted all retries appear here with a Retry button for manual recovery.

**Top metrics strip** — six live counters updating every 5 seconds: total events, endpoints, delivered, queued, permanently failed, success rate.

---

## Step-by-Step Guide

This guide uses the dashboard UI. Every action is also available via the REST API — see [API Reference](#api-reference).

### 1. Register an Endpoint

Open `http://localhost:3000` and scroll to the **Register Endpoint** card on the left.

Fill in:
- **Endpoint URL** — the server that will receive webhook deliveries
- **Event Types** — comma-separated e.g. `order.created, order.updated`
- **Secret** — leave blank to auto-generate a cryptographically secure 32-byte key

Click **Register Endpoint**.

> ⚠️ The signing secret appears **exactly once** in the green box. Copy it before dismissing — it cannot be retrieved again, only rotated.

<!-- SCREENSHOT: Dashboard showing a registered endpoint in the table with HEALTHY and CLOSED badges -->
> 📸 **Screenshot:** Dashboard with registered endpoint

![alt text](<Screenshot 2026-03-12 at 1.13.13 pm.png>)

### 2. Trigger an Event

Scroll to the **Trigger Test Event** card at the top left.

- Set **Event Type** to `order.created` (or any type your endpoints subscribe to)
- Leave **Payload** as the default or enter your own JSON
- Click **Trigger Event**

The green result box shows `202 Accepted` with the event ID and how many deliveries were queued. This is immediate — delivery happens entirely in the background.

<!-- SCREENSHOT: Green 202 result box showing event_id and queued_deliveries count -->
> 📸 **Screenshot:** 202 Accepted response after triggering an event

![alt text](<Screenshot 2026-03-13 at 4.10.48 am.png>)

### 3. Observe Delivery and Retries

Click any row in the **Registered Endpoints** table. The **Endpoint Delivery History** section loads below it.

Each attempt row shows:

| Column | What it means |
|--------|---------------|
| Time | Exact timestamp of the attempt |
| Status | `success`, `failed`, or `retrying` |
| Attempt | Which attempt number (1, 2, 3...) |
| HTTP | Response code from the target server |
| Response Time | How long the request took in ms |
| Error | Error message if the attempt failed |

For a failing endpoint, click **Refresh Details** every few seconds to watch retry attempts appear as the worker processes them.

Delivery state flow:
```
pending → retrying → retrying → ... → delivered
                                    ↘ failed  (after max_retries)
```

<!-- SCREENSHOT: Attempts table showing multiple FAILED rows with increasing attempt numbers and timestamps proving exponential backoff -->
> 📸 **Screenshot:** Delivery history showing retries with exponential backoff

![alt text](<Screenshot 2026-03-13 at 4.10.35 am.png>)

### 4. Manually Retry a Permanently Failed Delivery

When all retry attempts are exhausted, the delivery moves to the **Permanently Failed Deliveries** section at the bottom of the history panel.

Click **Retry** on any row. The worker picks it up within 2 seconds.

<!-- SCREENSHOT: Permanently Failed Deliveries table with a row showing 5/5 attempts and the Retry button -->
> 📸 **Screenshot:** Permanently failed delivery with Retry button

![alt text](<Screenshot 2026-03-13 at 4.17.20 am.png>)

## API Reference

### Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/endpoints` | List all endpoints with health status |
| `POST` | `/api/endpoints` | Register a new endpoint |
| `GET` | `/api/endpoints/:id` | Get single endpoint |
| `PUT` | `/api/endpoints/:id` | Update endpoint |
| `DELETE` | `/api/endpoints/:id` | Delete endpoint |
| `GET` | `/api/endpoints/:id/deliveries` | Delivery logs for an endpoint |
| `POST` | `/api/endpoints/:id/rotate-secret` | Rotate signing secret |

### Events

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/events/trigger` | Trigger an event (returns 202 immediately) |
| `GET` | `/api/events` | List recent events |
| `GET` | `/api/events/:id` | Get event with all deliveries |

### Deliveries

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/deliveries` | All deliveries (filterable by status) |
| `GET` | `/api/deliveries/:id` | Single delivery with full attempt history |
| `POST` | `/api/deliveries/:id/retry` | Manually retry a failed delivery |
| `GET` | `/api/deliveries/stats/summary` | Global delivery statistics |

### Example — Register via curl

```bash
curl -X POST http://localhost:3000/api/endpoints \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Order Service",
    "url": "https://your-server.com/webhook",
    "event_types": ["order.created"],
    "max_retries": 5,
    "timeout_ms": 5000
  }'
```

Response `201`:
```json
{
  "success": true,
  "data": { "id": "abc-123", "secret": "a1b2c3...64chars" },
  "message": "Endpoint registered. Store your secret — it will not be shown again."
}
```

### Example — Trigger via curl

```bash
curl -X POST http://localhost:3000/api/events/trigger \
  -H "Content-Type: application/json" \
  -d '{ "event_type": "order.created", "payload": { "id": "ord_001" } }'
```

Response `202`:
```json
{
  "success": true,
  "data": {
    "event_id": "evt-xyz",
    "queued_deliveries": 2,
    "message": "Event queued. Delivering to 2 endpoint(s) in the background."
  }
}
```

---

## Signature Verification

Every webhook delivery includes an HMAC-SHA256 signature so the receiving server can verify the payload came from this system and was not modified in transit.

**Headers sent on every request:**

```
X-Webhook-Signature: sha256=<hex_digest>
X-Webhook-ID:        <delivery_uuid>
X-Webhook-Event:     order.created
X-Webhook-Timestamp: 2024-01-15T10:30:00.000Z
X-Delivery-Attempt:  1
```

**Verification in Node.js:**

```javascript
const crypto = require('crypto');

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const expected = 'sha256=' + crypto
    .createHmac('sha256', YOUR_SECRET)
    .update(req.body)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.json({ ok: true });
});
```

> `crypto.timingSafeEqual` is used intentionally — a regular string comparison leaks timing information that can be exploited to forge signatures.

---

## Retry Behavior

| Attempt | Approximate delay |
|---------|-------------------|
| 1st retry | ~2 seconds |
| 2nd retry | ~4 seconds |
| 3rd retry | ~8 seconds |
| 4th retry | ~16 seconds |
| 5th retry | ~32 seconds |

**Formula:** `min(base_ms × 2^attempt + random_jitter, 300000ms)`

Jitter (up to 1 second of random noise) prevents multiple failing endpoints from retrying simultaneously — the thundering herd problem.

**Retried on:** 5xx server errors, 429 rate limit, network timeout, connection refused

**Not retried on:** 4xx client errors (except 429) — a bad request will not succeed on retry

---

## 4 Self-Initiated Improvements

### 1. Health Scoring

**Problem it solves:** Raw delivery counts tell you nothing at a glance. With many registered endpoints you cannot manually inspect logs for each one to know which are struggling. Operators need one signal per row — act now, watch it, or leave it alone.

**How it works:** Every time endpoints are listed, the last 20 delivery attempts per endpoint are evaluated server-side.

| Badge | Condition |
|-------|-----------|
| 🟢 Healthy | 0% failure rate |
| 🟡 Degraded | Under 30% failure rate |
| 🔴 Failing | 30%+ failure rate, or circuit is open |

Updates every 5 seconds via dashboard auto-refresh.

**Implementation:** `computeHealth()` in `src/api/endpoints.js`, computed on every `GET /api/endpoints` with no extra queries.

---

### 2. Circuit Breaker

**Problem it solves:** Without a circuit breaker, a dead endpoint gets retried indefinitely. Every guaranteed-to-fail attempt burns a worker slot, a database write, and an outbound connection. One broken endpoint can monopolise the worker and delay delivery to every healthy endpoint behind it in the queue.

**How it works:**

```
closed ──[5 consecutive failures]──▶ open ──[60s]──▶ half-open
  ▲                                                       │
  └────────────────[1 success]───────────────────────────┘
  open ◀──────────────────────[1 failure]────────────────┘
```

- **Closed** — normal operation
- **Open** — worker skips this endpoint entirely for 60 seconds
- **Half-open** — one test delivery allowed; success closes, failure reopens

**Implementation:** `src/utils/circuitBreaker.js`. Checked before every delivery attempt. State visible as the Circuit column badge in the dashboard.

---

### 3. Secret Rotation

**Problem it solves:** A secret that cannot be rotated is a security liability. If it leaks — in logs, in a breach, or through a person who has since left — the only option without rotation is to delete the endpoint entirely, losing all delivery history.

**How it works:** `POST /api/endpoints/:id/rotate-secret` generates a fresh 32-byte secret via `crypto.randomBytes`, overwrites the current secret immediately, and returns the new value exactly once. The old secret stops working instantly — no grace period.

**Implementation:** `src/api/endpoints.js`. The **Rotate Secret** button in the dashboard shows the new secret in the same one-time reveal box used at registration.

---

### 4. Rate Limiting

**Problem it solves:** Without limits, a runaway script or bad actor can flood the event trigger endpoint — filling the delivery queue, exhausting the database, and blocking legitimate traffic. A single blanket limit would also break the dashboard auto-refresh.

**How it works:** Three independent tiers applied only to write operations:

| Tier | Limit | Applied to |
|------|-------|------------|
| Global | 2000 req / 15 min | All API routes |
| Event trigger | 120 req / min | `POST /api/events/trigger` |
| Endpoint creation | 60 req / min | `POST /api/endpoints` |

GET requests never count against any limit — the dashboard auto-refresh runs completely unimpeded.

**Implementation:** `src/middleware/rateLimiter.js`. The creation limiter is applied to `router.post('/', createLimiter, ...)` directly, not the entire route prefix — which was the fix for a bug where every dashboard auto-refresh consumed endpoint creation quota.

---

## Bonus: Scaling to 100,000+ Deliveries/min

### Current Bottlenecks

| Bottleneck | Why it breaks at scale |
|------------|------------------------|
| Single-process worker | Single-threaded. At 1,667 deliveries/sec it falls behind within seconds |
| SQLite | Serialises all writes. Becomes the bottleneck immediately under load |
| 2-second polling | Adds unnecessary latency on every delivery |
| Batch size of 10 | Caps throughput at ~300/min per worker instance |
| In-process state | Crash = in-flight deliveries lost |

### Architectural Changes

**Replace SQLite with PostgreSQL** — supports high-concurrency writes and `SELECT FOR UPDATE SKIP LOCKED`, the correct pattern for a multi-worker job queue with no double-processing.

**Replace polling with Redis + BullMQ** — triggering an event pushes a job to Redis. Multiple worker processes pull from the queue. BullMQ handles retries, delays, and persistence natively at far greater throughput than polling SQL.

```
API Servers (stateless, N instances)
       │ push job
       ▼
Redis / BullMQ
       │ pull job
       ▼
Worker Pool (stateless, N instances, autoscaled by queue depth)
       │ HTTP POST
       ▼
Subscriber Endpoints
```

**Horizontal worker scaling** — workers are stateless, deployable across machines, autoscaled by Kubernetes HPA based on Redis queue depth.

**Batched DB writes** — buffer attempt records and flush every second in batches instead of one write per attempt. Reduces write pressure by 10–50×.

**Per-endpoint concurrency limits** — prevent one slow endpoint from holding open worker connections and blocking the rest.

**Estimated throughput:** 10 workers × 500 deliveries/sec = **300,000 deliveries/min** with p99 under 1 second.

---

## Project Structure

```
webhook-engine/
├── src/
│   ├── index.js                 # Express app, middleware, bootstrap
│   ├── api/
│   │   ├── endpoints.js         # CRUD, health scoring, secret rotation
│   │   ├── events.js            # Event trigger and history
│   │   └── deliveries.js        # Delivery logs, retry, stats
│   ├── engine/
│   │   └── deliveryWorker.js    # Background worker, backoff scheduling
│   ├── db/
│   │   └── database.js          # SQLite via sql.js, auto-saves every 5s
│   ├── middleware/
│   │   └── rateLimiter.js       # Three-tier rate limiting
│   └── utils/
│       ├── signature.js         # HMAC-SHA256 sign and verify
│       ├── backoff.js           # Exponential backoff formula
│       └── circuitBreaker.js    # Circuit breaker state machine
├── dashboard/
│   └── index.html               # Single-page monitoring UI
├── receiver.js                  # Test receiver with signature verification
├── tests/
│   └── test.js                  # 51 integration tests
├── data/                        # SQLite DB (auto-created on first run)
├── .env.example
└── package.json
```