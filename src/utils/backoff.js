/**
 * Calculate exponential backoff delay
 * Formula: min(base * 2^attempt + jitter, maxDelay)
 */
function getBackoffDelay(attemptNumber, baseDelayMs = 1000, maxDelayMs = 300000) {
  const exponential = baseDelayMs * Math.pow(2, attemptNumber);
  const jitter = Math.random() * 1000; // up to 1s jitter
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Get next retry timestamp
 */
function getNextRetryAt(attemptNumber) {
  const delayMs = getBackoffDelay(attemptNumber);
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * Check if a delivery should be retried
 */
function shouldRetry(statusCode, attemptCount, maxRetries) {
  if (attemptCount >= maxRetries) return false;
  if (!statusCode) return true; // timeout/network error
  if (statusCode >= 200 && statusCode < 300) return false; // success
  if (statusCode === 429) return true; // rate limited
  if (statusCode >= 500) return true; // server error
  if (statusCode >= 400 && statusCode < 500) return false; // client error - don't retry
  return true;
}

/**
 * Format delay for human display
 */
function formatDelay(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

module.exports = { getBackoffDelay, getNextRetryAt, shouldRetry, formatDelay };
