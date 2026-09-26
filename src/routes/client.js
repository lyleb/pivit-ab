const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth(['client']));

// Every route below double-checks client_id server-side before returning
// anything — a client's session can never be used to view another client's
// experiment just by guessing/changing an id in the URL.
async function assertOwnsExperiment(clientId, experimentId) {
  const { rows } = await db.query(
    `SELECT id, name, status, url_match FROM experiments WHERE id = $1 AND client_id = $2`,
    [experimentId, clientId]
  );
  return rows[0] || null;
}

// GET /api/client/experiments — this client's own experiments only
router.get('/experiments', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, status, url_match, created_at FROM experiments
       WHERE client_id = $1 ORDER BY url_match, created_at DESC`,
      [req.session.clientId]
    );
    res.json({ experiments: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/client/results/:experimentId — same shape as the owner results
// endpoint (visitors/new/returning/clicks/conversions/rate per variant), minus
// anything an owner-only view would need.
router.get('/results/:experimentId', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const { rows } = await db.query(
      `WITH first_seen AS (
         SELECT visitor_id, MIN(created_at)::date AS first_day
         FROM events WHERE experiment_id = $1 AND event_type = 'view'
         GROUP BY visitor_id
       )
       SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view' AND e.created_at::date = fs.first_day) AS new_visitors,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view' AND e.created_at::date > fs.first_day) AS returning_visitors,
         COUNT(*) FILTER (WHERE e.event_type = 'convert') AS conversions
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id
       LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
       WHERE v.experiment_id = $1
       GROUP BY v.id, v.name
       ORDER BY v.name`,
      [req.params.experimentId]
    );

    const results = rows.map((r) => ({
      ...r,
      visitors: Number(r.visitors),
      new_visitors: Number(r.new_visitors),
      returning_visitors: Number(r.returning_visitors),
      conversions: Number(r.conversions),
      conversion_rate: r.visitors > 0 ? +(r.conversions / r.visitors * 100).toFixed(2) : 0,
    }));

    res.json({ experiment: { id: experiment.id, name: experiment.name, status: experiment.status }, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/client/results/:experimentId/timeseries — trend chart data, same ownership check
router.get('/results/:experimentId/timeseries', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const { rows } = await db.query(
      `SELECT
         date_trunc('day', e.created_at) AS day,
         v.id AS variant_id,
         v.name AS variant_name,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors,
         COUNT(*) FILTER (WHERE e.event_type = 'convert') AS conversions
       FROM events e
       JOIN variants v ON v.id = e.variant_id
       WHERE e.experiment_id = $1
       GROUP BY day, v.id, v.name
       ORDER BY day`,
      [req.params.experimentId]
    );

    const series = rows.map((r) => ({
      day: r.day,
      variant_id: r.variant_id,
      variant_name: r.variant_name,
      visitors: Number(r.visitors),
      conversions: Number(r.conversions),
    }));

    res.json({ series });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
