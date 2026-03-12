/**
 * Test Receiver Server
 * ---------------------
 * A tiny Express server that acts as a webhook subscriber.
 * It verifies the HMAC-SHA256 signature on every incoming request
 * and logs pass/fail clearly to the terminal.
 *
 * Usage:
 *   WEBHOOK_SECRET=your_secret_here node receiver.js
 *
 * Or with a wrong secret to demonstrate rejection:
 *   WEBHOOK_SECRET=wrong_secret node receiver.js
 *
 * Listens on http://localhost:4000/webhook
 */

const http = require('http');
const crypto = require('crypto');

const PORT   = process.env.PORT   || 4000;
const SECRET = process.env.WEBHOOK_SECRET || '';
const ROUTE  = '/webhook';

let requestCount   = 0;
let successCount   = 0;
let failCount      = 0;

function verifySignature(rawBody, signature, secret) {
  if (!secret) return { valid: false, reason: 'No secret configured on receiver' };
  if (!signature) return { valid: false, reason: 'Missing X-Webhook-Signature header' };

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
    return { valid, reason: valid ? 'Signature matched' : 'Signature mismatch — payload may be tampered' };
  } catch {
    return { valid: false, reason: 'Signature comparison failed (length mismatch)' };
  }
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const server = http.createServer((req, res) => {
  // Only handle POST /webhook
  if (req.method !== 'POST' || req.url !== ROUTE) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let rawBody = '';
  req.on('data', chunk => { rawBody += chunk.toString(); });

  req.on('end', () => {
    requestCount++;

    const signature  = req.headers['x-webhook-signature'];
    const eventType  = req.headers['x-webhook-event']     || 'unknown';
    const deliveryId = req.headers['x-webhook-id']        || 'unknown';
    const attempt    = req.headers['x-delivery-attempt']  || '?';
    const timestamp  = req.headers['x-webhook-timestamp'] || 'unknown';

    const { valid, reason } = verifySignature(rawBody, signature, SECRET);

    // Parse payload for display
    let payload = {};
    try { payload = JSON.parse(rawBody); } catch { /* raw body */ }

    // Terminal output
    console.log('\n' + '─'.repeat(60));
    console.log(color(valid ? '32' : '31', valid ? '  SIGNATURE VALID' : '  SIGNATURE INVALID'));
    console.log('─'.repeat(60));
    console.log(`  Request #     : ${requestCount}`);
    console.log(`  Event Type    : ${color('36', eventType)}`);
    console.log(`  Delivery ID   : ${deliveryId.substring(0, 16)}...`);
    console.log(`  Attempt #     : ${attempt}`);
    console.log(`  Timestamp     : ${timestamp}`);
    console.log(`  Signature     : ${signature ? signature.substring(0, 30) + '...' : 'MISSING'}`);
    console.log(`  Verdict       : ${color(valid ? '32' : '31', reason)}`);
    console.log(`  Payload       : ${JSON.stringify(payload)}`);

    if (valid) {
      successCount++;
      console.log(color('32', `\n  Responding 200 OK — delivery will be marked delivered`));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Signature verified, event accepted' }));
    } else {
      failCount++;
      console.log(color('31', `\n  Responding 401 — delivery will be marked failed and retried`));
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid signature' }));
    }

    console.log(`\n  Stats: ${successCount} accepted / ${failCount} rejected / ${requestCount} total`);
    console.log('─'.repeat(60));
  });
});

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('  Webhook Test Receiver');
  console.log('='.repeat(60));
  console.log(`  Listening on  : http://localhost:${PORT}${ROUTE}`);
  console.log(`  Secret set    : ${SECRET ? color('32', 'YES (' + SECRET.substring(0, 8) + '...)') : color('31', 'NO — all signatures will fail')}`);
  console.log('');
  console.log('  Register this URL as an endpoint:');
  console.log(color('36', `  http://localhost:${PORT}${ROUTE}`));
  console.log('');
  console.log('  To test with wrong secret:');
  console.log('  WEBHOOK_SECRET=wrongsecret node receiver.js');
  console.log('='.repeat(60) + '\n');
});
