const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query, run, get } = require('../db/database');
const { queueDeliveries } = require('../engine/deliveryWorker');

// POST /api/events/trigger - trigger an event
router.post('/trigger', async (req, res) => {
  try {
    const { event_type, payload } = req.body;

    if (!event_type || !payload) {
      return res.status(400).json({ success: false, error: 'event_type and payload are required' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      'INSERT INTO events (id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
      [id, event_type, JSON.stringify(payload), now]
    );

    // Queue deliveries asynchronously — return immediately
    const deliveryCount = await queueDeliveries(id, event_type);

    res.status(202).json({
      success: true,
      data: {
        event_id: id,
        event_type,
        queued_deliveries: deliveryCount,
        message: `Event queued. Delivering to ${deliveryCount} endpoint(s) in the background.`
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/events - list recent events
router.get('/', (req, res) => {
  try {
    const { limit = 50, event_type } = req.query;
    
    let sql = 'SELECT * FROM events';
    const params = [];
    
    if (event_type) {
      sql += ' WHERE event_type = ?';
      params.push(event_type);
    }
    
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const events = query(sql, params);

    const enriched = events.map(e => ({
      ...e,
      payload: JSON.parse(e.payload),
      delivery_summary: getDeliverySummary(e.id)
    }));

    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/events/:id
router.get('/:id', (req, res) => {
  try {
    const event = get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!event) return res.status(404).json({ success: false, error: 'Event not found' });

    event.payload = JSON.parse(event.payload);
    
    const deliveries = query(
      `SELECT d.*, ep.name as endpoint_name, ep.url as endpoint_url FROM deliveries d
       JOIN endpoints ep ON d.endpoint_id = ep.id
       WHERE d.event_id = ?`,
      [event.id]
    );

    res.json({
      success: true,
      data: {
        ...event,
        deliveries: deliveries.map(d => ({
          ...d,
          attempts: query(
            'SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number ASC',
            [d.id]
          )
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/events/types/list - get all known event types
router.get('/types/list', (req, res) => {
  try {
    const types = query(
      'SELECT DISTINCT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC',
      []
    );
    res.json({ success: true, data: types });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── EVENT REPLAY ──────────────────────────────────────────────────
// POST /api/events/:id/replay - replay a past event to all current subscribers
router.post('/:id/replay', async (req, res) => {
  try {
    const { endpoint_id } = req.body; // optional — replay to one specific endpoint only

    const original = get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!original) return res.status(404).json({ success: false, error: 'Event not found' });

    // Create a new event record that is a replay of the original
    const replayId = uuidv4();
    const now = new Date().toISOString();
    const replayPayload = JSON.parse(original.payload);

    // Stamp it so receivers know this is a replay
    replayPayload._replay = true;
    replayPayload._original_event_id = original.id;
    replayPayload._replayed_at = now;

    run(
      'INSERT INTO events (id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
      [replayId, original.event_type, JSON.stringify(replayPayload), now]
    );

    let deliveryCount = 0;

    if (endpoint_id) {
      // Replay to one specific endpoint only
      const ep = get('SELECT * FROM endpoints WHERE id = ? AND is_active = 1', [endpoint_id]);
      if (!ep) return res.status(404).json({ success: false, error: 'Endpoint not found or inactive' });

      const deliveryId = uuidv4();
      run(
        `INSERT INTO deliveries (id, event_id, endpoint_id, status, attempt_count, max_retries, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
        [deliveryId, replayId, endpoint_id, ep.max_retries || 5, now, now]
      );
      deliveryCount = 1;
    } else {
      // Replay to all current subscribers of this event type
      deliveryCount = await queueDeliveries(replayId, original.event_type);
    }

    res.status(202).json({
      success: true,
      data: {
        original_event_id: original.id,
        replay_event_id: replayId,
        event_type: original.event_type,
        queued_deliveries: deliveryCount,
        message: `Event replayed. Delivering to ${deliveryCount} endpoint(s) in the background.`
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function getDeliverySummary(eventId) {
  const total = get('SELECT COUNT(*) as count FROM deliveries WHERE event_id = ?', [eventId]);
  const delivered = get("SELECT COUNT(*) as count FROM deliveries WHERE event_id = ? AND status = 'delivered'", [eventId]);
  const failed = get("SELECT COUNT(*) as count FROM deliveries WHERE event_id = ? AND status = 'failed'", [eventId]);
  const pending = get("SELECT COUNT(*) as count FROM deliveries WHERE event_id = ? AND status IN ('pending', 'retrying')", [eventId]);
  
  return {
    total: total?.count || 0,
    delivered: delivered?.count || 0,
    failed: failed?.count || 0,
    pending: pending?.count || 0
  };
}

module.exports = router;
