const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeBayesianStats } = require('../bayesian');
const { publicServerError } = require('../public-error');
const { getVariantResults, getGoalBreakdown, getTimeseries, getPrimaryVariantData } = require('../metrics');
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
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/client/results/:experimentId — same shape as the owner results
// endpoint (visitors/new/returning/clicks/conversions/rate per variant), minus
// anything an owner-only view would need.
router.get('/results/:experimentId', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const [{ results, primaryKey }, breakdown] = await Promise.all([
      getVariantResults(req.params.experimentId),
      getGoalBreakdown(req.params.experimentId),
    ]);

    res.json({
      experiment: { id: experiment.id, name: experiment.name, status: experiment.status },
      primary_goal: primaryKey,
      results,
      goals: breakdown.goals,
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/client/results/:experimentId/timeseries — trend chart data, same ownership check
router.get('/results/:experimentId/timeseries', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const series = await getTimeseries(req.params.experimentId);
    res.json({ series });
  } catch (err) {
    res.status(500).json(publicServerError(err));
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
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
