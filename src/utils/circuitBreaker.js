const { query, run, get } = require('../db/database');

const FAILURE_THRESHOLD = 5;       // failures before opening circuit
const RECOVERY_TIMEOUT_MS = 60000; // 1 minute before trying again (half-open)
const SUCCESS_THRESHOLD = 2;       // successes in half-open before closing

/**
 * Circuit breaker states:
 * closed   -> normal operation
 * open     -> reject all requests
 * half-open -> allow one test request
 */

function getCircuitBreaker(endpointId) {
  let cb = get('SELECT * FROM circuit_breakers WHERE endpoint_id = ?', [endpointId]);
  if (!cb) {
    run(
      'INSERT INTO circuit_breakers (endpoint_id, state, failure_count) VALUES (?, ?, ?)',
      [endpointId, 'closed', 0]
    );
    cb = { endpoint_id: endpointId, state: 'closed', failure_count: 0, last_failure_at: null, next_attempt_at: null };
  }
  return cb;
}

function isCircuitOpen(endpointId) {
  const cb = getCircuitBreaker(endpointId);
  
  if (cb.state === 'closed') return false;
  
  if (cb.state === 'open') {
    // Check if recovery timeout has passed
    if (cb.next_attempt_at && new Date() >= new Date(cb.next_attempt_at)) {
      // Transition to half-open
      run(
        'UPDATE circuit_breakers SET state = ? WHERE endpoint_id = ?',
        ['half-open', endpointId]
      );
      return false; // allow one attempt
    }
    return true;
  }
  
  if (cb.state === 'half-open') return false;
  
  return false;
}

function recordSuccess(endpointId) {
  const cb = getCircuitBreaker(endpointId);
  
  if (cb.state === 'half-open') {
    // Close the circuit on success
    run(
      'UPDATE circuit_breakers SET state = ?, failure_count = 0, last_failure_at = NULL, next_attempt_at = NULL WHERE endpoint_id = ?',
      ['closed', endpointId]
    );
    console.log(`🟢 Circuit breaker CLOSED for endpoint ${endpointId}`);
  } else {
    run(
      'UPDATE circuit_breakers SET failure_count = 0 WHERE endpoint_id = ?',
      [endpointId]
    );
  }
}

function recordFailure(endpointId) {
  const cb = getCircuitBreaker(endpointId);
  const newFailureCount = (cb.failure_count || 0) + 1;
  const now = new Date().toISOString();
  
  if (newFailureCount >= FAILURE_THRESHOLD || cb.state === 'half-open') {
    const nextAttempt = new Date(Date.now() + RECOVERY_TIMEOUT_MS).toISOString();
    run(
      'UPDATE circuit_breakers SET state = ?, failure_count = ?, last_failure_at = ?, next_attempt_at = ? WHERE endpoint_id = ?',
      ['open', newFailureCount, now, nextAttempt, endpointId]
    );
    console.log(`🔴 Circuit breaker OPENED for endpoint ${endpointId} after ${newFailureCount} failures`);
  } else {
    run(
      'UPDATE circuit_breakers SET failure_count = ?, last_failure_at = ? WHERE endpoint_id = ?',
      [newFailureCount, now, endpointId]
    );
  }
}

function getCircuitState(endpointId) {
  const cb = getCircuitBreaker(endpointId);
  return cb.state || 'closed';
}

module.exports = { isCircuitOpen, recordSuccess, recordFailure, getCircuitState, getCircuitBreaker };
