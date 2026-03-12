# Webhook Delivery Engine

A production-grade webhook delivery system with reliable event delivery, exponential backoff retries, HMAC signature verification, circuit breakers, and a real-time monitoring dashboard.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Client / Dashboard                     │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP
┌────────────────────────────▼────────────────────────────────┐
│                    Express API Server                         │
│   /api/endpoints   /api/events   /api/deliveries             │
│   Rate Limiting · Helmet · CORS · Morgan                     │
└────────────┬───────────────────────────┬────────────────────┘
             │                           │
┌────────────▼──────────┐  ┌────────────▼────────────────────┐
│     SQLite Database    │  │     Background Delivery Worker   │
│  endpoints            │  │  Polls every 2s for pending/     │
│  events               │  │  retrying deliveries             │
│  deliveries           │  │  Processes up to 10 at a time    │
│  delivery_attempts    │  │  Exponential backoff scheduling  │
│  circuit_breakers     │  └──────────────┬──────────────────┘
└───────────────────────┘                 │
                                          │ HTTP POST
                          ┌───────────────▼──────────────────┐
                          │     Subscriber Endpoints          │
                          │  HMAC-SHA256 signed requests      │
                          │  X-Webhook-Signature header       │
                          └──────────────────────────────────┘
```

### How the Delivery Engine Works Internally

1. **Event Trigger** — `POST /api/events/trigger` stores the event and immediately calls `queueDeliveries()`. This finds all active endpoints subscribed to the event type and inserts a `delivery` row with status `pending`. The HTTP response returns instantly with a `202 Accepted` — no waiting.

2. **Background Worker** — A `setInterval` loop runs every 2 seconds. It queries for deliveries where `status IN ('pending', 'retrying') AND next_retry_at <= NOW()`, then attempts up to 10 in parallel via `Promise.allSettled`.

3. **Attempt Execution** — For each delivery, the worker checks the circuit breaker, builds the HMAC signature, and fires an HTTP POST to the target URL with all webhook headers.

4. **Outcome Recording** — Every attempt is recorded in `delivery_attempts`. On success, the delivery is marked `delivered`. On failure, `shouldRetry()` determines whether to schedule a retry (based on status code + attempt count). Retries set `next_retry_at` using exponential backoff.

5. **Permanent Failure** — After `max_retries` attempts with no success, the delivery is marked `failed`. Manual retry is possible from the dashboard or API.

---

## Setup & Run

### Prerequisites
- Node.js 18+

### Installation

```bash
git clone <your-repo>
cd webhook-delivery-engine
npm install
cp .env.example .env
npm start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | HTTP server port |
| `NODE_ENV` | `development` | Environment |

Open **http://localhost:3000** for the monitoring dashboard.

### Run Tests

```bash
npm test
```

Runs 51 integration tests covering all API routes, signature logic, backoff algorithm, and circuit breaker behavior.

---

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
| `GET` | `/api/events/types/list` | List all known event types |

### Deliveries

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/deliveries` | All deliveries (filterable by status) |
| `GET` | `/api/deliveries/:id` | Single delivery with full attempt history |
| `POST` | `/api/deliveries/:id/retry` | Manually retry a failed delivery |
| `GET` | `/api/deliveries/stats/summary` | Global delivery statistics |

---

## Signature Verification

Every webhook request includes an HMAC-SHA256 signature so your server can verify the payload came from this system.

**Header sent:**
```
X-Webhook-Signature: sha256=<hex_digest>
X-Webhook-ID: <delivery_uuid>
X-Webhook-Event: order.created
X-Webhook-Timestamp: 2024-01-15T10:30:00.000Z
X-Delivery-Attempt: 1
```

**Verification example (Node.js):**
```javascript
const crypto = require('crypto');

function verifyWebhook(rawBody, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

app.post('/webhook', (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  if (!verifyWebhook(JSON.stringify(req.body), sig, YOUR_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  // Process webhook...
  res.json({ ok: true });
});
```

---

## Step-by-Step Guide

### 1. Register an Endpoint

```bash
curl -X POST http://localhost:3000/api/endpoints \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Order Service",
    "url": "https://your-server.com/webhooks",
    "event_types": ["order.created", "order.updated"],
    "max_retries": 5,
    "timeout_ms": 10000
  }'
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "abc-123",
    "secret": "a1b2c3d4...64chars",
    ...
  },
  "message": "Endpoint registered. Store your secret — it will not be shown again."
}
```

⚠️ **Save the `secret` immediately** — it's only shown once.

### 2. Trigger an Event

```bash
curl -X POST http://localhost:3000/api/events/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "order.created",
    "payload": {
      "id": "ord_001",
      "amount": 4999,
      "currency": "USD"
    }
  }'
```

**Response (202 — immediate):**
```json
{
  "success": true,
  "data": {
    "event_id": "evt-xyz",
    "queued_deliveries": 1,
    "message": "Event queued. Delivering to 1 endpoint(s) in the background."
  }
}
```

### 3. Observe Delivery + Retries

```bash
# Check delivery status
curl http://localhost:3000/api/endpoints/abc-123/deliveries

# Full delivery detail with attempt timeline
curl http://localhost:3000/api/deliveries/<delivery_id>
```

The delivery transitions through states:
```
pending → retrying → retrying → ... → delivered
                                    ↘ failed (after max_retries)
```

### 4. Manually Retry a Failed Delivery

```bash
curl -X POST http://localhost:3000/api/deliveries/<id>/retry
```

Or click the **↻** button in the dashboard.

---

## Retry Behavior

| Attempt | Delay (approx) |
|---------|----------------|
| 1st retry | ~2 seconds |
| 2nd retry | ~4 seconds |
| 3rd retry | ~8 seconds |
| 4th retry | ~16 seconds |
| 5th retry | ~32 seconds |

Formula: `min(1000 * 2^attempt + random_jitter, 300000ms)`

**Retried on:** 5xx errors, 429 rate limit, network timeout, connection refused  
**Not retried on:** 4xx client errors (except 429) — these indicate a bad request that won't succeed on retry

---

## 4 Self-Initiated Improvements

### 1. Health Scoring

**Problem it solves:** Raw delivery counts tell you nothing at a glance. With 50 endpoints you cannot manually inspect logs for each one to know which are struggling. Operators need a single signal — act now, watch it, or leave it alone.

**How it works:** Every time endpoints are fetched, the last 20 deliveries for each endpoint are evaluated. Zero failures = `healthy`. Under 30% failure rate = `degraded`. Above 30% = `failing`. The circuit breaker state also feeds into this — an open circuit forces `failing` regardless of the ratio. The badge updates every 5 seconds automatically in the dashboard.

**Implementation:** `computeHealth()` and `getEndpointStats()` in `src/api/endpoints.js`. Surfaced on every `GET /api/endpoints` call. Color-coded badges visible in the endpoints table with no additional queries needed from the frontend.

---

### 2. Circuit Breaker

**Problem it solves:** Without a circuit breaker a dead endpoint gets retried indefinitely. Every attempt consumes a worker slot, a database write, and an outbound connection — all guaranteed to fail. This delays delivery to healthy endpoints and wastes system resources proportional to how broken the dead endpoint is.

**How it works:** Three states persisted in the `circuit_breakers` table. After 5 consecutive failures the circuit opens — the worker skips that endpoint entirely. After 60 seconds it transitions to half-open and allows exactly one test delivery. Success closes the circuit and resets the failure count. Failure reopens it for another 60 seconds.

```
closed  --[5 failures]-->  open  --[60s timeout]-->  half-open
  ^                                                       |
  |----[1 success]---------------------------------------|
  open  <--[1 failure]----------------------------------|
```

**Implementation:** `src/utils/circuitBreaker.js` — checked by the worker before every delivery attempt. State transitions are atomic DB updates. The circuit state is visible as a dedicated badge column in the dashboard endpoints table.

---

### 3. Secret Rotation

**Problem it solves:** A signing secret that cannot be rotated is a security liability. If a secret is leaked in logs, exposed in a breach, or shared with a contractor who left — the only option without rotation is to delete the entire endpoint, lose all delivery history, and re-register from scratch.

**How it works:** `POST /api/endpoints/:id/rotate-secret` generates a fresh 32-byte secret via `crypto.randomBytes`, overwrites the current secret in the database immediately, and returns the new secret exactly once in the response. All subsequent deliveries use the new secret. The old secret stops working instantly — there is no grace period or dual-secret window.

**Implementation:** `src/api/endpoints.js`. The Rotate Secret button in the dashboard calls this endpoint and shows the new secret in the same reveal box used at registration time, with a dismiss button to clear it from the DOM after copying.

---

### 4. Rate Limiting

**Problem it solves:** Without rate limiting a misconfigured client, a runaway script, or a bad actor can call the event trigger endpoint thousands of times per second — flooding the delivery queue, filling the database, and blocking legitimate traffic. A single blanket limit would also break the dashboard since the auto-refresh calls GET endpoints every 5 seconds.

**How it works:** Three separate tiers applied selectively to write operations only:

| Tier | Limit | Applied to |
|------|-------|------------|
| Global | 2000 req / 15 min | All API routes |
| Event trigger | 120 req / min | POST /api/events/trigger only |
| Endpoint creation | 60 req / min | POST /api/endpoints only |

GET requests for listing endpoints, fetching delivery history, and loading stats never count against any limit. The dashboard auto-refresh runs unimpeded.

**Implementation:** `src/middleware/rateLimiter.js` using `express-rate-limit`. The creation limiter is applied as route-level middleware directly on `router.post('/', createLimiter, ...)` rather than on the entire `/api/endpoints` prefix, which was the original bug that caused the "Creation rate limit exceeded" error on the listing page.

---

## Bonus: Scaling to 100,000+ Deliveries per Minute

### Current Bottlenecks

1. **Single-process worker** — the setInterval worker is single-threaded. At 100k/min (~1,667/sec) it will fall behind within seconds.

2. **SQLite** — serializes all writes. Under high concurrent delivery load the DB becomes the bottleneck immediately.

3. **In-process queue** — if the process crashes, all in-flight deliveries that have been dequeued but not yet attempted are lost.

4. **Batch size of 10** — only 10 deliveries processed per 2-second poll cycle caps throughput at roughly 300/min on a single worker.

### Architectural Changes

**Replace SQLite with PostgreSQL** — handles high-concurrency reads and writes, supports row-level locking, and enables `SELECT FOR UPDATE SKIP LOCKED` which is the correct pattern for a multi-worker job queue without double-processing.

**Add Redis and BullMQ for job queuing** — decouple event ingestion from delivery entirely. Triggering an event pushes a job to Redis. Multiple worker processes pull from the queue. BullMQ handles retries, delays, priority, and job persistence natively with far better throughput than polling a SQL table.

```
API Servers (stateless, horizontally scaled)
     | push job
     v
Redis / BullMQ
     | pull job
     v
Worker Pool (horizontally scaled, N instances)
     | HTTP POST
     v
Subscriber Endpoints
```

**Horizontal worker scaling** — workers become stateless processes deployable across machines. Scale by adding containers. Kubernetes HPA can autoscale based on Redis queue depth.

**Batched DB writes** — buffer attempt records in memory and flush every second in batches instead of one DB write per attempt. Reduces write pressure by 10-50x at high volume.

**Per-endpoint concurrency limits** — prevent a single slow endpoint from holding open worker connections indefinitely. Add configurable max concurrent deliveries per endpoint in the worker.

**Estimated throughput at scale:**
10 worker instances x 500 deliveries/sec each = 300,000 deliveries/min with p99 under 1 second.

---

## Project Structure

```
webhook-delivery-engine/
├── src/
│   ├── index.js              # Express app entry point
│   ├── api/
│   │   ├── endpoints.js      # Endpoint CRUD, health scoring, secret rotation
│   │   ├── events.js         # Event trigger and history
│   │   └── deliveries.js     # Delivery logs, retry, stats
│   ├── engine/
│   │   └── deliveryWorker.js # Background delivery engine, exponential backoff
│   ├── db/
│   │   └── database.js       # SQLite via sql.js
│   ├── middleware/
│   │   └── rateLimiter.js    # Three-tier rate limiting
│   └── utils/
│       ├── signature.js      # HMAC-SHA256 signing and verification
│       ├── backoff.js        # Exponential backoff calculation
│       └── circuitBreaker.js # Circuit breaker state machine
├── dashboard/
│   └── index.html            # Single-page monitoring dashboard
├── receiver.js               # Test receiver with signature verification
├── data/                     # SQLite database (auto-created)
├── tests/
│   └── test.js               # 51 integration tests
├── .env.example
└── package.json
```