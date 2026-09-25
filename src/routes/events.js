const express = require('express');
const db = require('../db');
const router = express.Router();

// POST /api/event
// body: { experiment_id, variant_id, visitor_id, event_type, goal_id? }
router.post('/', async (req, res) => {
  const { experiment_id, variant_id, visitor_id, event_type, goal_id } = req.body;

  if (!experiment_id || !variant_id || !visitor_id || !event_type) {
    return res.status(400).json({ error: 'experiment_id, variant_id, visitor_id, event_type are required' });
  }
  if (!['view', 'click', 'convert'].includes(event_type)) {
    return res.status(400).json({ error: 'event_type must be view, click, or convert' });
  }

  try {
    await db.query(
      `INSERT INTO events (experiment_id, variant_id, visitor_id, event_type, goal_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [experiment_id, variant_id, visitor_id, event_type, goal_id ?? null]
    );
    // 204 keeps the beacon call cheap — no body needed on the client.
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
