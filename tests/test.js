/**
 * Integration test suite for Webhook Delivery Engine
 * Run with: node tests/test.js
 * 
 * Starts the server, runs tests, then exits.
 */

const http = require('http');

const BASE = 'http://localhost:3001';
let passed = 0;
let failed = 0;
let createdEndpointId = null;
let createdEventId = null;
let createdDeliveryId = null;

// Override PORT for testing
process.env.PORT = '3001';

async function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };

    const reqObj = http.request(options, res => {
      let rawData = '';
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(rawData) }); }
        catch { resolve({ status: res.statusCode, body: rawData }); }
      });
    });

    reqObj.on('error', reject);
    if (data) reqObj.write(data);
    reqObj.end();
  });
}

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('\n🧪 Starting Webhook Engine Test Suite\n');
  console.log('='.repeat(50));

  // Wait for server to be ready
  await sleep(1500);

  // ── Health Check ──────────────────────────────────
  console.log('\n📋 Health Check');
  const health = await req('GET', '/api/health');
  assert(health.status === 200, 'GET /api/health returns 200');
  assert(health.body.status === 'ok', 'Health status is ok');

  // ── Endpoint CRUD ─────────────────────────────────
  console.log('\n📋 Endpoint Registration');

  const create = await req('POST', '/api/endpoints', {
    name: 'Test Endpoint',
    url: 'https://httpbin.org/post',
    event_types: ['order.created', 'order.updated'],
    max_retries: 3,
    timeout_ms: 5000
  });
  assert(create.status === 201, 'POST /api/endpoints returns 201');
  assert(create.body.success === true, 'Endpoint created successfully');
  assert(typeof create.body.data.secret === 'string', 'Secret returned on creation');
  assert(create.body.data.secret.length === 64, 'Secret is 64 hex chars (32 bytes)');
  createdEndpointId = create.body.data.id;

  const list = await req('GET', '/api/endpoints');
  assert(list.status === 200, 'GET /api/endpoints returns 200');
  assert(Array.isArray(list.body.data), 'Returns array of endpoints');
  assert(list.body.data.length >= 1, 'At least one endpoint exists');

  const getOne = await req('GET', `/api/endpoints/${createdEndpointId}`);
  assert(getOne.status === 200, 'GET /api/endpoints/:id returns 200');
  assert(getOne.body.data.name === 'Test Endpoint', 'Returns correct endpoint');

  const update = await req('PUT', `/api/endpoints/${createdEndpointId}`, {
    name: 'Updated Test Endpoint'
  });
  assert(update.status === 200, 'PUT /api/endpoints/:id returns 200');
  assert(update.body.data.name === 'Updated Test Endpoint', 'Name updated correctly');

  // ── Validation ────────────────────────────────────
  console.log('\n📋 Input Validation');

  const badUrl = await req('POST', '/api/endpoints', {
    name: 'Bad',
    url: 'not-a-url',
    event_types: ['test']
  });
  assert(badUrl.status === 400, 'Rejects invalid URL with 400');

  const missingFields = await req('POST', '/api/endpoints', { name: 'Only name' });
  assert(missingFields.status === 400, 'Rejects missing required fields');

  // ── Event Triggering ──────────────────────────────
  console.log('\n📋 Event Triggering');

  const trigger = await req('POST', '/api/events/trigger', {
    event_type: 'order.created',
    payload: { id: 'ord_test_001', amount: 9999, currency: 'USD' }
  });
  assert(trigger.status === 202, 'POST /api/events/trigger returns 202');
  assert(trigger.body.success === true, 'Event triggered successfully');
  assert(trigger.body.data.queued_deliveries >= 1, 'At least 1 delivery queued');
  createdEventId = trigger.body.data.event_id;

  const evList = await req('GET', '/api/events');
  assert(evList.status === 200, 'GET /api/events returns 200');
  assert(Array.isArray(evList.body.data), 'Returns events array');

  // Trigger unsubscribed event type (should queue 0)
  const noSubs = await req('POST', '/api/events/trigger', {
    event_type: 'payment.refunded',
    payload: { id: 'ref_001' }
  });
  assert(noSubs.body.data.queued_deliveries === 0, 'Unsubscribed event queues 0 deliveries');

  // ── Delivery Logs ─────────────────────────────────
  console.log('\n📋 Delivery Logs');
  await sleep(500);

  const epDeliveries = await req('GET', `/api/endpoints/${createdEndpointId}/deliveries`);
  assert(epDeliveries.status === 200, 'GET /api/endpoints/:id/deliveries returns 200');
  assert(Array.isArray(epDeliveries.body.data), 'Returns delivery array');

  if (epDeliveries.body.data.length > 0) {
    const del = epDeliveries.body.data[0];
    createdDeliveryId = del.id;
    assert(del.attempts !== undefined, 'Delivery includes attempts array');
    assert(typeof del.attempt_count === 'number', 'Delivery has attempt_count');
    assert(del.status !== undefined, 'Delivery has status');
  }

  const allDeliveries = await req('GET', '/api/deliveries?limit=10');
  assert(allDeliveries.status === 200, 'GET /api/deliveries returns 200');

  // ── Stats ─────────────────────────────────────────
  console.log('\n📋 Stats & Analytics');

  const stats = await req('GET', '/api/deliveries/stats/summary');
  assert(stats.status === 200, 'GET /api/deliveries/stats/summary returns 200');
  assert(typeof stats.body.data.total === 'number', 'Stats includes total');
  assert(typeof stats.body.data.success_rate === 'number', 'Stats includes success_rate');

  // ── Signature Verification ────────────────────────
  console.log('\n📋 Signature Verification');

  const crypto = require('crypto');
  const { generateSignature, verifySignature, generateSecret } = require('../src/utils/signature');

  const secret = generateSecret();
  assert(secret.length === 64, 'generateSecret returns 64-char hex string');

  const payload = '{"test": "data"}';
  const sig = generateSignature(payload, secret);
  assert(sig.startsWith('sha256='), 'Signature starts with sha256=');
  assert(verifySignature(payload, secret, sig) === true, 'Valid signature verifies correctly');
  assert(verifySignature(payload, 'wrong-secret', sig) === false, 'Wrong secret fails verification');
  assert(verifySignature('tampered', secret, sig) === false, 'Tampered payload fails verification');

  // ── Backoff ───────────────────────────────────────
  console.log('\n📋 Exponential Backoff Logic');

  const { getBackoffDelay, shouldRetry } = require('../src/utils/backoff');

  const d1 = getBackoffDelay(0);
  const d2 = getBackoffDelay(1);
  const d3 = getBackoffDelay(2);
  assert(d2 > d1, 'Delay increases with each attempt (0→1)');
  assert(d3 > d2, 'Delay increases with each attempt (1→2)');

  assert(shouldRetry(500, 1, 5) === true, '500 error triggers retry');
  assert(shouldRetry(200, 1, 5) === false, '200 success does not retry');
  assert(shouldRetry(404, 1, 5) === false, '404 client error does not retry');
  assert(shouldRetry(500, 5, 5) === false, 'Max retries reached stops retrying');
  assert(shouldRetry(null, 1, 5) === true, 'Network error (null code) triggers retry');

  // ── Circuit Breaker ───────────────────────────────
  console.log('\n📋 Circuit Breaker');

  const { isCircuitOpen, recordSuccess, recordFailure, getCircuitState } = require('../src/utils/circuitBreaker');

  const testEpId = 'circuit-test-' + Date.now();
  assert(isCircuitOpen(testEpId) === false, 'New circuit starts closed');
  assert(getCircuitState(testEpId) === 'closed', 'New circuit state is closed');

  // Record failures to open circuit
  for (let i = 0; i < 5; i++) recordFailure(testEpId);
  assert(isCircuitOpen(testEpId) === true, 'Circuit opens after threshold failures');
  assert(getCircuitState(testEpId) === 'open', 'Circuit state is open after failures');

  // ── Secret Rotation ───────────────────────────────
  console.log('\n📋 Secret Rotation');

  const rotate = await req('POST', `/api/endpoints/${createdEndpointId}/rotate-secret`);
  assert(rotate.status === 200, 'POST /api/endpoints/:id/rotate-secret returns 200');
  assert(typeof rotate.body.secret === 'string', 'New secret returned');
  assert(rotate.body.secret.length === 64, 'New secret is valid length');

  // ── Cleanup ───────────────────────────────────────
  console.log('\n📋 Cleanup');

  const del = await req('DELETE', `/api/endpoints/${createdEndpointId}`);
  assert(del.status === 200, 'DELETE /api/endpoints/:id returns 200');

  const notFound = await req('GET', `/api/endpoints/${createdEndpointId}`);
  assert(notFound.status === 404, 'Deleted endpoint returns 404');

  // ── Summary ───────────────────────────────────────
  console.log('\n' + '='.repeat(50));
  console.log(`\n🎯 Results: ${passed} passed, ${failed} failed\n`);

  if (failed === 0) {
    console.log('🎉 All tests passed!\n');
  } else {
    console.log(`⚠️  ${failed} test(s) failed\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

// Start server in background then run tests
require('../src/index');
runTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
