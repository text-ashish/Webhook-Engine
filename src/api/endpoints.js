const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query, run, get } = require('../db/database');
const { generateSecret } = require('../utils/signature');
const { getCircuitState, getCircuitBreaker } = require('../utils/circuitBreaker');
const { createLimiter } = require('../middleware/rateLimiter');

// GET /api/endpoints - list all endpoints with health status
router.get('/', (req, res) => {
  try {
    const endpoints = query('SELECT * FROM endpoints ORDER BY created_at DESC', []);

    const result = endpoints.map(ep => {
      const eventTypes = JSON.parse(ep.event_types || '[]');
      const cb = getCircuitBreaker(ep.id);
      
      // Calculate health from recent deliveries
      const recent = query(
        `SELECT status FROM deliveries WHERE endpoint_id = ? ORDER BY updated_at DESC LIMIT 20`,
        [ep.id]
      );
      
      const health = computeHealth(recent, cb);
      const stats = getEndpointStats(ep.id);

      return {
        ...ep,
        event_types: eventTypes,
        health,
        circuit_state: cb.state || 'closed',
        stats
      };
    });

    res.json({ success: true, data: result, total: result.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/endpoints/:id
router.get('/:id', (req, res) => {
  try {
    const ep = get('SELECT * FROM endpoints WHERE id = ?', [req.params.id]);
    if (!ep) return res.status(404).json({ success: false, error: 'Endpoint not found' });

    ep.event_types = JSON.parse(ep.event_types || '[]');
    ep.circuit_state = getCircuitState(ep.id);
    ep.stats = getEndpointStats(ep.id);

    res.json({ success: true, data: ep });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/endpoints - register new endpoint
router.post('/', createLimiter, (req, res) => {
  try {
    const { name, url, event_types, max_retries, timeout_ms } = req.body;

    if (!name || !url || !event_types) {
      return res.status(400).json({ success: false, error: 'name, url, and event_types are required' });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({ success: false, error: 'Invalid URL' });
    }

    if (!Array.isArray(event_types) || event_types.length === 0) {
      return res.status(400).json({ success: false, error: 'event_types must be a non-empty array' });
    }

    const id = uuidv4();
    const secret = generateSecret();
    const now = new Date().toISOString();

    run(
      `INSERT INTO endpoints (id, name, url, secret, event_types, is_active, max_retries, timeout_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [id, name, url, secret, JSON.stringify(event_types), max_retries || 5, timeout_ms || 10000, now, now]
    );

    const created = get('SELECT * FROM endpoints WHERE id = ?', [id]);
    created.event_types = JSON.parse(created.event_types);

    res.status(201).json({
      success: true,
      data: created,
      message: 'Endpoint registered. Store your secret — it will not be shown again.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/endpoints/:id - update endpoint
router.put('/:id', (req, res) => {
  try {
    const ep = get('SELECT * FROM endpoints WHERE id = ?', [req.params.id]);
    if (!ep) return res.status(404).json({ success: false, error: 'Endpoint not found' });

    const { name, url, event_types, is_active, max_retries, timeout_ms } = req.body;

    if (url && !isValidUrl(url)) {
      return res.status(400).json({ success: false, error: 'Invalid URL' });
    }

    const now = new Date().toISOString();
    run(
      `UPDATE endpoints SET
        name = ?,
        url = ?,
        event_types = ?,
        is_active = ?,
        max_retries = ?,
        timeout_ms = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        name || ep.name,
        url || ep.url,
        event_types ? JSON.stringify(event_types) : ep.event_types,
        is_active !== undefined ? (is_active ? 1 : 0) : ep.is_active,
        max_retries || ep.max_retries,
        timeout_ms || ep.timeout_ms,
        now,
        ep.id
      ]
    );

    const updated = get('SELECT * FROM endpoints WHERE id = ?', [ep.id]);
    updated.event_types = JSON.parse(updated.event_types);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/endpoints/:id
router.delete('/:id', (req, res) => {
  try {
    const ep = get('SELECT * FROM endpoints WHERE id = ?', [req.params.id]);
    if (!ep) return res.status(404).json({ success: false, error: 'Endpoint not found' });

    run('DELETE FROM endpoints WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Endpoint deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/endpoints/:id/deliveries - delivery logs
router.get('/:id/deliveries', (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;
    
    let sql = `SELECT d.*, e.event_type, e.payload FROM deliveries d
               JOIN events e ON d.event_id = e.id
               WHERE d.endpoint_id = ?`;
    const params = [req.params.id];

    if (status) {
      sql += ' AND d.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const deliveries = query(sql, params);

    const enriched = deliveries.map(d => ({
      ...d,
      attempts: query(
        'SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number ASC',
        [d.id]
      )
    }));

    res.json({ success: true, data: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/endpoints/:id/rotate-secret
router.post('/:id/rotate-secret', (req, res) => {
  try {
    const ep = get('SELECT * FROM endpoints WHERE id = ?', [req.params.id]);
    if (!ep) return res.status(404).json({ success: false, error: 'Endpoint not found' });

    const newSecret = generateSecret();
    run('UPDATE endpoints SET secret = ?, updated_at = ? WHERE id = ?',
      [newSecret, new Date().toISOString(), ep.id]);

    res.json({ success: true, secret: newSecret, message: 'Secret rotated. Store it securely.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper functions
function computeHealth(recentDeliveries, cb) {
  if (cb && cb.state === 'open') return 'failing';
  if (recentDeliveries.length === 0) return 'healthy';
  
  const failed = recentDeliveries.filter(d => d.status === 'failed').length;
  const ratio = failed / recentDeliveries.length;

  if (ratio === 0) return 'healthy';
  if (ratio < 0.3) return 'degraded';
  return 'failing';
}

function getEndpointStats(endpointId) {
  const total = get('SELECT COUNT(*) as count FROM deliveries WHERE endpoint_id = ?', [endpointId]);
  const delivered = get("SELECT COUNT(*) as count FROM deliveries WHERE endpoint_id = ? AND status = 'delivered'", [endpointId]);
  const failed = get("SELECT COUNT(*) as count FROM deliveries WHERE endpoint_id = ? AND status = 'failed'", [endpointId]);
  const pending = get("SELECT COUNT(*) as count FROM deliveries WHERE endpoint_id = ? AND status IN ('pending', 'retrying')", [endpointId]);
  const avgTime = get('SELECT AVG(last_response_time_ms) as avg FROM deliveries WHERE endpoint_id = ? AND last_response_time_ms IS NOT NULL', [endpointId]);

  return {
    total: total?.count || 0,
    delivered: delivered?.count || 0,
    failed: failed?.count || 0,
    pending: pending?.count || 0,
    avg_response_time_ms: Math.round(avgTime?.avg || 0)
  };
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = router;
