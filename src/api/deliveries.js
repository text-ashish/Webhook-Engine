const express = require('express');
const router = express.Router();
const { query, run, get } = require('../db/database');
const { retryDelivery } = require('../engine/deliveryWorker');

// GET /api/deliveries - all deliveries with filters
router.get('/', (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let sql = `SELECT d.*, e.event_type, ep.name as endpoint_name, ep.url as endpoint_url
               FROM deliveries d
               JOIN events e ON d.event_id = e.id
               JOIN endpoints ep ON d.endpoint_id = ep.id`;
    const params = [];

    if (status) {
      sql += ' WHERE d.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY d.updated_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const deliveries = query(sql, params);
    res.json({ success: true, data: deliveries, total: deliveries.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/deliveries/:id - single delivery with full attempt history
router.get('/:id', (req, res) => {
  try {
    const delivery = get(
      `SELECT d.*, e.event_type, e.payload, ep.name as endpoint_name, ep.url as endpoint_url
       FROM deliveries d
       JOIN events e ON d.event_id = e.id
       JOIN endpoints ep ON d.endpoint_id = ep.id
       WHERE d.id = ?`,
      [req.params.id]
    );

    if (!delivery) return res.status(404).json({ success: false, error: 'Delivery not found' });

    delivery.payload = JSON.parse(delivery.payload || '{}');
    delivery.attempts = query(
      'SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number ASC',
      [delivery.id]
    );

    res.json({ success: true, data: delivery });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/deliveries/:id/retry - manually retry a failed delivery
router.post('/:id/retry', async (req, res) => {
  try {
    const result = await retryDelivery(req.params.id);
    res.json({ success: true, data: result, message: 'Delivery retried' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── DEAD LETTER QUEUE ─────────────────────────────────────────────
// GET /api/deliveries/dlq - all permanently failed deliveries
router.get('/dlq', (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;

    const items = query(
      `SELECT d.*, e.event_type, e.payload,
              ep.name as endpoint_name, ep.url as endpoint_url
       FROM deliveries d
       JOIN events e ON d.event_id = e.id
       JOIN endpoints ep ON d.endpoint_id = ep.id
       WHERE d.status = 'failed'
       ORDER BY d.updated_at DESC
       LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );

    const total = get("SELECT COUNT(*) as count FROM deliveries WHERE status = 'failed'", []);

    const enriched = items.map(d => ({
      ...d,
      payload: JSON.parse(d.payload || '{}'),
      attempts: query(
        'SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number ASC',
        [d.id]
      )
    }));

    res.json({
      success: true,
      data: enriched,
      total: total?.count || 0,
      message: 'Dead letter queue — permanently failed deliveries that exhausted all retry attempts'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/deliveries/dlq/retry-all - retry everything in the DLQ
router.post('/dlq/retry-all', async (req, res) => {
  try {
    const failed = query(
      "SELECT id FROM deliveries WHERE status = 'failed'",
      []
    );

    if (!failed.length) {
      return res.json({ success: true, retried: 0, message: 'DLQ is empty' });
    }

    const now = new Date().toISOString();
    for (const d of failed) {
      run(
        "UPDATE deliveries SET status = 'pending', next_retry_at = NULL, updated_at = ? WHERE id = ?",
        [now, d.id]
      );
    }

    res.json({
      success: true,
      retried: failed.length,
      message: `${failed.length} delivery(s) moved from DLQ back to pending queue`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/deliveries/stats/summary - global stats
router.get('/stats/summary', (req, res) => {
  try {
    const total = get('SELECT COUNT(*) as count FROM deliveries', []);
    const delivered = get("SELECT COUNT(*) as count FROM deliveries WHERE status = 'delivered'", []);
    const failed = get("SELECT COUNT(*) as count FROM deliveries WHERE status = 'failed'", []);
    const retrying = get("SELECT COUNT(*) as count FROM deliveries WHERE status = 'retrying'", []);
    const pending = get("SELECT COUNT(*) as count FROM deliveries WHERE status = 'pending'", []);
    const avgTime = get('SELECT AVG(last_response_time_ms) as avg FROM deliveries WHERE last_response_time_ms IS NOT NULL', []);

    const last24h = new Date(Date.now() - 86400000).toISOString();
    const todayTotal = get('SELECT COUNT(*) as count FROM deliveries WHERE created_at >= ?', [last24h]);
    const todaySuccess = get("SELECT COUNT(*) as count FROM deliveries WHERE status = 'delivered' AND updated_at >= ?", [last24h]);

    res.json({
      success: true,
      data: {
        total: total?.count || 0,
        delivered: delivered?.count || 0,
        failed: failed?.count || 0,
        retrying: retrying?.count || 0,
        pending: pending?.count || 0,
        avg_response_time_ms: Math.round(avgTime?.avg || 0),
        success_rate: total?.count > 0
          ? Math.round(((delivered?.count || 0) / total.count) * 100)
          : 0,
        last_24h: {
          total: todayTotal?.count || 0,
          delivered: todaySuccess?.count || 0
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
