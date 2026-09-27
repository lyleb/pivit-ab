const express = require('express');
const db = require('../db');
const router = express.Router();

// POST /api/event
// body: { experiment_id, variant_id, visitor_id, event_type, goal_id?, value? }
// value = revenue amount for revenue goals (a plain number, e.g. 49.99).
router.post('/', async (req, res) => {
  const { experiment_id, variant_id, visitor_id, event_type, goal_id, value } = req.body;

  if (!experiment_id || !variant_id || !visitor_id || !event_type) {
    return res.status(400).json({ error: 'experiment_id, variant_id, visitor_id, event_type are required' });
  }
  if (!['view', 'click', 'convert'].includes(event_type)) {
    return res.status(400).json({ error: 'event_type must be view, click, or convert' });
  }

  // Only accept a sane, finite revenue number; anything else is stored as no value.
  const numericValue = Number(value);
  const safeValue = value !== undefined && value !== null && Number.isFinite(numericValue) && numericValue >= 0 && numericValue < 1e9
    ? numericValue : null;

  try {
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, goal_id, value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [experiment_id, variant_id, visitor_id, event_type, goal_id ?? null, safeValue]
    );
    // 204 keeps the beacon call cheap — no body needed on the client.
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
