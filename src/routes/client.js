const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeBayesianStats } = require('../bayesian');
const { publicServerError } = require('../public-error');
const { getVariantResults, getGoalBreakdown, getTimeseries, getPrimaryVariantData } = require('../metrics');
const { outcomeGate } = require('../experiment-plan');
const { hideOutcomeRow } = require('../reading');
const { buildVerdict } = require('../verdict');
const router = express.Router();

router.use(requireAuth(['client']));

// Every route below double-checks client_id server-side before returning
// anything — a client's session can never be used to view another client's
// experiment just by guessing/changing an id in the URL.
async function assertOwnsExperiment(clientId, experimentId, accountId) {
  const { rows } = await db.query(
    `SELECT id, name, status, url_match FROM experiments
     WHERE id = $1 AND client_id = $2 AND account_id = $3`,
    [experimentId, clientId, accountId]
  );
  return rows[0] || null;
}

// GET /api/client/experiments — this client's own experiments only
router.get('/experiments', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, status, url_match, created_at FROM experiments
       WHERE client_id = $1 AND account_id = $2 ORDER BY url_match, created_at DESC`,
      [req.session.clientId, req.account.id]
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
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId, req.account.id);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const [{ results, primaryKey }, breakdown, gate] = await Promise.all([
      getVariantResults(req.params.experimentId),
      getGoalBreakdown(req.params.experimentId),
      outcomeGate(req.params.experimentId, false, req.account.id),
    ]);
    const visible = gate.visible;
    let verdict = null;
    if (visible && gate.reading && gate.reading.plan_met) {
      const { variantData } = await getPrimaryVariantData(req.params.experimentId);
      verdict = buildVerdict({
        variants: variantData,
        plan: gate.loaded.experiment.plan,
        srmDetected: !!(gate.loaded.srm && gate.loaded.srm.srm_detected),
      });
      verdict.peeked = gate.reading.peeked;
    }

    res.json({
      experiment: { id: experiment.id, name: experiment.name, status: experiment.status },
      primary_goal: visible ? primaryKey : null,
      results: visible ? results : results.map(hideOutcomeRow),
      goals: visible ? breakdown.goals : [],
      reading: gate.reading,
      blinded: !visible,
      verdict,
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/client/results/:experimentId/timeseries — trend chart data, same ownership check
router.get('/results/:experimentId/timeseries', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId, req.account.id);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const gate = await outcomeGate(req.params.experimentId, false, req.account.id);
    if (!gate.visible) return res.json({ series: [], blinded: true, reading: gate.reading });
    const series = await getTimeseries(req.params.experimentId);
    res.json({ series, blinded: false, reading: gate.reading });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/client/results/:experimentId/bayesian — short-form version of the
// owner's Bayesian panel: same model (src/bayesian.js), used client-side to
// generate one plain-English sentence rather than a full table.
router.get('/results/:experimentId/bayesian', async (req, res) => {
  try {
    const experiment = await assertOwnsExperiment(req.session.clientId, req.params.experimentId, req.account.id);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });

    const gate = await outcomeGate(req.params.experimentId, false, req.account.id);
    const { variantData } = await getPrimaryVariantData(req.params.experimentId);
    if (!gate.visible) {
      return res.json({ low_sample_warning: false, stats: [], blinded: true, reading: gate.reading });
    }
    const stats = computeBayesianStats(variantData);
    const lowSample = variantData.some((v) => v.visitors < 30);
    const secondary = !!(gate.reading && gate.reading.plan_met && gate.reading.mode !== 'data_problem');
    res.json({ low_sample_warning: lowSample, stats, blinded: false, reading: gate.reading, secondary });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
