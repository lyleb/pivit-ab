const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeBayesianStats } = require('../bayesian');
const { publicServerError } = require('../public-error');
const { getVariantResults, getGoalBreakdown, getTimeseries, getPrimaryVariantData } = require('../metrics');
const { outcomeGate } = require('../experiment-plan');
const { hideOutcomeRow } = require('../reading');
const { buildVerdict } = require('../verdict');
const { isDemo } = require('../demo-test');
const { listForClient, detailForClient, owned } = require('../client-portal');
const { requestReview } = require('../review-request');
const { formatLondonDay, londonDateISO } = require('../clock');
const {
  MISSING,
  clientConclusionView,
  clientPdf,
  approveConclusion,
  deliverPdf,
} = require('../conclusion');
const router = express.Router();

router.use(requireAuth(['client']));

// Every route below double-checks client_id server-side before returning
// anything — a client's session can never be used to view another client's
// experiment just by guessing/changing an id in the URL.
async function assertOwnsExperiment(clientId, experimentId, accountId) {
  const { rows } = await db.query(
    `SELECT id, name, status, url_match, test_type FROM experiments
     WHERE id = $1 AND client_id = $2 AND account_id = $3`,
    [experimentId, clientId, accountId]
  );
  return rows[0] || null;
}

// GET /api/client/experiments — this client's own experiments only.
// Headlines and progress come from the stored daily snapshot. This handler
// does not count events or run a verdict.
router.get('/experiments', async (req, res) => {
  try {
    const payload = await listForClient(req.session.clientId, req.account.id);
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/client/experiments/:experimentId — blind or concluded portal view.
// Reads the snapshot and the test setup (name, page, variants). No live stats.
router.get('/experiments/:experimentId', async (req, res) => {
  try {
    const detail = await detailForClient(req.session.clientId, req.account.id, req.params.experimentId);
    if (!detail) return res.status(404).json({ error: 'no experiment found with that id' });
    const conclusion = await clientConclusionView(req.session.clientId, req.account.id, req.params.experimentId);
    detail.conclusion = conclusion.conclusion || null;
    res.set('Cache-Control', 'no-store');
    res.json(detail);
  } catch (err) {
    if (err && err.code === 'BLIND_LEAK') {
      console.error(err.message);
      return res.status(500).json(publicServerError(err));
    }
    res.status(500).json(publicServerError(err));
  }
});

// POST /api/client/experiments/:experimentId/review-request
// Logs the ask and notifies the owner. Does not reveal results or stop the test.
// An email failure is recorded and still returns ok.
router.post('/experiments/:experimentId/review-request', async (req, res) => {
  try {
    const experiment = await owned(req.session.clientId, req.account.id, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });
    if (experiment.status === 'draft') {
      return res.status(400).json({ error: 'This test has not started, so there is nothing to review yet.' });
    }
    const client = await db.query(
      `SELECT name FROM clients WHERE id = $1 AND account_id = $2`,
      [req.session.clientId, req.account.id]
    );
    const result = await requestReview({
      experiment,
      clientId: req.session.clientId,
      clientName: client.rows[0] ? client.rows[0].name : 'A viewer',
      accountId: req.account.id,
      ip: req.ip,
    });
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      requested_at: result.requested_at,
      requested_label: result.requested_label || formatLondonDay(londonDateISO(new Date(result.requested_at))),
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/client/experiments/:experimentId/conclusion.pdf
// Only a released conclusion. A draft is the same 404 as a missing test.
router.get('/experiments/:experimentId/conclusion.pdf', async (req, res) => {
  try {
    const file = await clientPdf(req.session.clientId, req.account.id, req.params.experimentId, 'conclusion');
    if (!deliverPdf(res, file)) return res.status(404).json({ error: MISSING });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// POST /api/client/experiments/:experimentId/approve
// Click to approve a released conclusion. Records who and when.
router.post('/experiments/:experimentId/approve', async (req, res) => {
  try {
    const result = await approveConclusion({
      clientId: req.session.clientId,
      accountId: req.account.id,
      experimentId: req.params.experimentId,
      ip: req.ip,
    });
    if (result.error === 'missing') return res.status(404).json({ error: MISSING });
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      already: !!result.already,
      approver_name: result.approver_name,
      approved_at: result.approved_at,
      approved_label: result.approved_label,
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

// GET /api/client/experiments/:experimentId/approval.pdf
router.get('/experiments/:experimentId/approval.pdf', async (req, res) => {
  try {
    const file = await clientPdf(req.session.clientId, req.account.id, req.params.experimentId, 'approval');
    if (!deliverPdf(res, file)) return res.status(404).json({ error: MISSING });
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

    const options = isDemo(experiment) ? { testOnly: true } : undefined;
    const [{ results, primaryKey }, breakdown, gate] = await Promise.all([
      getVariantResults(req.params.experimentId, undefined, options),
      getGoalBreakdown(req.params.experimentId, options),
      outcomeGate(req.params.experimentId, false, req.account.id),
    ]);
    const visible = gate.visible;
    let verdict = null;
    if (visible && gate.reading && gate.reading.plan_met) {
      const { variantData } = await getPrimaryVariantData(req.params.experimentId, options);
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

    const options = isDemo(experiment) ? { testOnly: true } : undefined;
    const gate = await outcomeGate(req.params.experimentId, false, req.account.id);
    if (!gate.visible) return res.json({ series: [], blinded: true, reading: gate.reading });
    const series = await getTimeseries(req.params.experimentId, options);
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

    const options = isDemo(experiment) ? { testOnly: true } : undefined;
    const gate = await outcomeGate(req.params.experimentId, false, req.account.id);
    const { variantData } = await getPrimaryVariantData(req.params.experimentId, options);
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
