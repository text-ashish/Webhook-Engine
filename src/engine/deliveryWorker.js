const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query, run, get } = require('../db/database');
const { generateSignature } = require('../utils/signature');
const { getNextRetryAt, shouldRetry } = require('../utils/backoff');
const { isCircuitOpen, recordSuccess, recordFailure } = require('../utils/circuitBreaker');

const WORKER_INTERVAL_MS = 2000;   // poll every 2 seconds
const BATCH_SIZE = 10;              // process 10 deliveries at a time
let isRunning = false;
let workerTimer = null;

/**
 * Queue deliveries for all subscribed endpoints when an event fires
 */
async function queueDeliveries(eventId, eventType) {
  // Find all active endpoints subscribed to this event type
  const endpoints = query(
    "SELECT * FROM endpoints WHERE is_active = 1",
    []
  );

  const subscribed = endpoints.filter(ep => {
    const types = JSON.parse(ep.event_types || '[]');
    return types.includes(eventType) || types.includes('*');
  });

  const now = new Date().toISOString();
  for (const endpoint of subscribed) {
    const deliveryId = uuidv4();
    run(
      `INSERT INTO deliveries (id, event_id, endpoint_id, status, attempt_count, max_retries, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      [deliveryId, eventId, endpoint.id, endpoint.max_retries || 5, now, now]
    );
    console.log(`📬 Queued delivery ${deliveryId} for endpoint ${endpoint.name}`);
  }

  return subscribed.length;
}

/**
 * Attempt a single delivery
 */
async function attemptDelivery(delivery) {
  const endpoint = get('SELECT * FROM endpoints WHERE id = ?', [delivery.endpoint_id]);
  const event = get('SELECT * FROM events WHERE id = ?', [delivery.event_id]);

  if (!endpoint || !event) {
    run("UPDATE deliveries SET status = 'failed', updated_at = ? WHERE id = ?",
      [new Date().toISOString(), delivery.id]);
    return;
  }

  // Check circuit breaker
  if (isCircuitOpen(endpoint.id)) {
    console.log(`⚡ Circuit open for ${endpoint.name}, skipping delivery ${delivery.id}`);
    return;
  }

  const payload = JSON.parse(event.payload);
  const payloadString = JSON.stringify(payload);
  const signature = generateSignature(payloadString, endpoint.secret);
  const attemptNumber = (delivery.attempt_count || 0) + 1;
  const startTime = Date.now();

  console.log(`🚀 Attempting delivery ${delivery.id} to ${endpoint.url} (attempt ${attemptNumber})`);

  let responseCode = null;
  let responseBody = null;
  let responseTimeMs = null;
  let errorMessage = null;
  let success = false;

  try {
    const response = await axios.post(endpoint.url, payload, {
      timeout: endpoint.timeout_ms || 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-ID': delivery.id,
        'X-Webhook-Event': event.event_type,
        'X-Webhook-Timestamp': new Date().toISOString(),
        'X-Delivery-Attempt': attemptNumber,
        'User-Agent': 'WebhookEngine/1.0'
      }
    });

    responseTimeMs = Date.now() - startTime;
    responseCode = response.status;
    responseBody = JSON.stringify(response.data).substring(0, 500);
    success = true;

    recordSuccess(endpoint.id);
    console.log(`✅ Delivery ${delivery.id} succeeded with ${responseCode} in ${responseTimeMs}ms`);

  } catch (err) {
    responseTimeMs = Date.now() - startTime;

    if (err.response) {
      responseCode = err.response.status;
      responseBody = JSON.stringify(err.response.data).substring(0, 500);
    } else if (err.code === 'ECONNABORTED') {
      errorMessage = `Timeout after ${endpoint.timeout_ms}ms`;
    } else {
      errorMessage = err.message;
    }

    recordFailure(endpoint.id);
    console.log(`❌ Delivery ${delivery.id} failed: ${errorMessage || responseCode}`);
  }

  // Record attempt
  const attemptId = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO delivery_attempts (id, delivery_id, attempt_number, status, response_code, response_body, response_time_ms, error_message, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      attemptId, delivery.id, attemptNumber,
      success ? 'success' : 'failed',
      responseCode, responseBody, responseTimeMs, errorMessage, now
    ]
  );

  // Update delivery record
  if (success) {
    run(
      `UPDATE deliveries SET status = 'delivered', attempt_count = ?, last_response_code = ?,
       last_response_body = ?, last_response_time_ms = ?, updated_at = ? WHERE id = ?`,
      [attemptNumber, responseCode, responseBody, responseTimeMs, now, delivery.id]
    );
  } else {
    const willRetry = shouldRetry(responseCode, attemptNumber, delivery.max_retries);
    
    if (willRetry) {
      const nextRetry = getNextRetryAt(attemptNumber);
      run(
        `UPDATE deliveries SET status = 'retrying', attempt_count = ?, last_response_code = ?,
         last_response_body = ?, last_response_time_ms = ?, error_message = ?,
         next_retry_at = ?, updated_at = ? WHERE id = ?`,
        [attemptNumber, responseCode, responseBody, responseTimeMs, errorMessage, nextRetry, now, delivery.id]
      );
      console.log(`🔄 Delivery ${delivery.id} scheduled for retry at ${nextRetry}`);
    } else {
      run(
        `UPDATE deliveries SET status = 'failed', attempt_count = ?, last_response_code = ?,
         last_response_body = ?, last_response_time_ms = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        [attemptNumber, responseCode, responseBody, responseTimeMs, errorMessage, now, delivery.id]
      );
      console.log(`💀 Delivery ${delivery.id} permanently failed after ${attemptNumber} attempts`);
    }
  }
}

/**
 * Worker loop: pick up pending/retrying deliveries
 */
async function processDeliveries() {
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date().toISOString();
    
    // Get deliveries that need processing
    const deliveries = query(
      `SELECT * FROM deliveries
       WHERE status IN ('pending', 'retrying')
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [now, BATCH_SIZE]
    );

    if (deliveries.length > 0) {
      console.log(`⚙️  Processing ${deliveries.length} deliveries...`);
    }

    // Process in parallel (but limit concurrency)
    await Promise.allSettled(
      deliveries.map(delivery => attemptDelivery(delivery))
    );

  } catch (err) {
    console.error('Worker error:', err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the background worker
 */
function startWorker() {
  console.log('🔧 Webhook delivery worker started');
  workerTimer = setInterval(processDeliveries, WORKER_INTERVAL_MS);
  processDeliveries(); // run immediately
}

/**
 * Stop the worker
 */
function stopWorker() {
  if (workerTimer) clearInterval(workerTimer);
}

/**
 * Manually retry a failed delivery
 */
async function retryDelivery(deliveryId) {
  const delivery = get('SELECT * FROM deliveries WHERE id = ?', [deliveryId]);
  if (!delivery) throw new Error('Delivery not found');
  if (delivery.status !== 'failed') throw new Error('Only failed deliveries can be retried');

  const now = new Date().toISOString();
  run(
    "UPDATE deliveries SET status = 'pending', next_retry_at = NULL, updated_at = ? WHERE id = ?",
    [now, deliveryId]
  );

  // Attempt immediately
  const updated = get('SELECT * FROM deliveries WHERE id = ?', [deliveryId]);
  await attemptDelivery(updated);
  return get('SELECT * FROM deliveries WHERE id = ?', [deliveryId]);
}

module.exports = { queueDeliveries, startWorker, stopWorker, retryDelivery, processDeliveries };
