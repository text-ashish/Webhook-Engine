const crypto = require('crypto');

/**
 * Generate HMAC-SHA256 signature for webhook payload
 * Format: sha256=<hex_digest>
 */
function generateSignature(payload, secret) {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadString, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Verify incoming webhook signature
 */
function verifySignature(payload, secret, signature) {
  const expected = generateSignature(payload, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

/**
 * Generate a random secret for new endpoints
 */
function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { generateSignature, verifySignature, generateSecret };
