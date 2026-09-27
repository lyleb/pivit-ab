const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeBayesianStats } = require('../bayesian');
const { getPrimaryGoalKey, getPrimaryVariantData, getGoalBreakdown, PRIMARY_CONVERT } = require('../metrics');
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

    const primaryKey = await getPrimaryGoalKey(req.params.experimentId);
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
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE ${PRIMARY_CONVERT}) AS conversions,
         COALESCE(SUM(e.value) FILTER (WHERE e.event_type = 'convert'), 0) AS revenue
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id
       LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
       WHERE v.experiment_id = $1
       GROUP BY v.id, v.name
       ORDER BY v.name`,
      [req.params.experimentId, primaryKey]
    );

    const results = rows.map((r) => ({
      ...r,
      visitors: Number(r.visitors),
      new_visitors: Number(r.new_visitors),
      returning_visitors: Number(r.returning_visitors),
      conversions: Number(r.conversions),
      conversion_rate: r.visitors > 0 ? +(r.conversions / r.visitors * 100).toFixed(2) : 0,
      revenue: +Number(r.revenue).toFixed(2),
      revenue_per_visitor: r.visitors > 0 ? +(Number(r.revenue) / r.visitors).toFixed(2) : 0,
    }));

    res.json({ primary_goal: primaryKey, experiment: { id: experiment.id, name: experiment.name, status: experiment.status }, results });
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

    const primaryKey = await getPrimaryGoalKey(req.params.experimentId);
    const { rows } = await db.query(
      `SELECT
         date_trunc('day', e.created_at) AS day,
         v.id AS variant_id,
         v.name AS variant_name,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE ${PRIMARY_CONVERT}) AS conversions
       FROM events e
       JOIN variants v ON v.id = e.variant_id
       WHERE e.experiment_id = $1
       GROUP BY day, v.id, v.name
       ORDER BY day`,
      [req.params.experimentId, primaryKey]
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

// GET /api/client/results/:experimentId/bayesian — short-form version of the
// owner's Bayesian panel: same model (src/bayesian.js), used client-side to
// generate one plain-English sentence rather than a full table.
router.get('/results/:experimentId/bayesian', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const { variantData } = await getPrimaryVariantData(req.params.experimentId);

    const stats = computeBayesianStats(variantData);
    const lowSample = variantData.some((v) => v.visitors < 30);
    res.json({ low_sample_warning: lowSample, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/client/results/:experimentId/goals — read-only per-goal breakdown,
// same ownership check as everything else here.
router.get('/results/:experimentId/goals', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });
    res.json(await getGoalBreakdown(req.params.experimentId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
