const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeBayesianStats } = require('../bayesian');
const { detectSRM } = require('../srm');
const { getVariantResults, getGoalBreakdown, getTimeseries, getPrimaryVariantData, annotateUniqueConversions, visibleEventSql } = require('../metrics');
const { flagIsOn, summariseTestTraffic } = require('../test-traffic');
const { outcomeGate } = require('../experiment-plan');
const { hideOutcomeRow } = require('../reading');
const { buildVerdict } = require('../verdict');
const { ownedExperiment } = require('../tenant');
const { countOptions } = require('../demo-test');
const { csvFilename, sendCsv } = require('../csv');
const router = express.Router();

router.use(requireAuth(['owner'])); // results are for your eyes only, not the public snippet

async function assertOwned(req, res, experimentId) {
  const row = await ownedExperiment(req.account.id, experimentId);
  if (!row) {
    res.status(404).json({ error: 'no experiment found with that id' });
    return null;
  }
  return row;
}

function wantsTestTraffic(req) {
  return flagIsOn(req.query && req.query.include_test);
}

// A demo test always reads test traffic, and never mixes real visitors in
// when include_test is set. A live test is unchanged.
function prepared(experiment, req) {
  const options = countOptions(experiment, wantsTestTraffic(req));
  return {
    options,
    includeTest: !!options.includeTest,
    mode: options.testOnly ? 'test' : undefined,
  };
}

// "New" vs "returning" is defined by day, not by event count: a visitor is "new"
// on the calendar day of their first-ever view for this experiment, and
// "returning" on any later day they come back. This deliberately does NOT count
// a second pageview in the same sitting (e.g. a refresh) as "returning" — only
// an actual later visit does. Test traffic follows the same rule as the table.
function firstSeenCte(mode) {
  return `
  WITH first_seen AS (
    SELECT visitor_id, MIN(created_at)::date AS first_day
    FROM events
    WHERE experiment_id = $1 AND event_type = 'view'
      AND ${visibleEventSql('', 2, mode)}
    GROUP BY visitor_id
  )
`;
}

const TEST_ONLY_LABEL = 'Test traffic only. Real visitors are not included. This is not the verdict, and opening it does not count as an early look.';

function wantsTestOnly(req) {
  return flagIsOn(req.query && req.query.test_only);
}

// GET /api/results/:experimentId/test-traffic
// Owner only. Full figures for test traffic, even while real results are
// blind. Never mixes in real visitors, and does not set peeked_at.
router.get('/:experimentId/test-traffic', async (req, res) => {
  const { experimentId } = req.params;
  try {
    if (!(await assertOwned(req, res, experimentId))) return;
    const options = { testOnly: true };
    const [{ results, primaryKey }, breakdown] = await Promise.all([
      getVariantResults(experimentId, undefined, options),
      getGoalBreakdown(experimentId, options),
    ]);
    res.json({
      experiment_id: experimentId,
      test_only: true,
      include_test: false,
      blinded: false,
      peeked: false,
      label: TEST_ONLY_LABEL,
      primary_goal: primaryKey,
      results,
      goals: breakdown.goals,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId?visitor_type=new|returning
// conversions is unique converting visitors (rate cannot exceed 100%).
// conversion_events is the raw goal-hit count, including repeats.
// goals breaks the same unique count out per goal when an experiment has several.
router.get('/:experimentId', async (req, res) => {
  const { experimentId } = req.params;

  try {
    const experiment = await assertOwned(req, res, experimentId);
    if (!experiment) return;
    const read = prepared(experiment, req);
    const includeTest = read.includeTest;
    const [{ results, primaryKey }, breakdown, testTraffic] = await Promise.all([
      getVariantResults(experimentId, req.query.visitor_type, read.options),
      getGoalBreakdown(experimentId, read.options),
      summariseTestTraffic(experimentId),
    ]);

    const gate = await outcomeGate(experimentId, includeTest, req.account.id);
    const visible = gate.visible;
    res.json({
      experiment_id: experimentId,
      visitor_type: req.query.visitor_type || 'all',
      include_test: includeTest,
      test_traffic: { ...testTraffic, excluded: !includeTest },
      primary_goal: visible ? primaryKey : null,
      results: visible ? results : results.map(hideOutcomeRow),
      goals: visible ? breakdown.goals : [],
      reading: gate.reading,
      blinded: !visible,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId/timeseries
// Daily unique visitors and unique same-day converters, plus running unique
// totals (cumulative_visitors / cumulative_conversions) for the trend chart.
// Cumulative is not a sum of the daily rows.
router.get('/:experimentId/timeseries', async (req, res) => {
  const { experimentId } = req.params;

  try {
    const experiment = await assertOwned(req, res, experimentId);
    if (!experiment) return;
    const read = prepared(experiment, req);
    const includeTest = read.includeTest;
    const gate = await outcomeGate(experimentId, includeTest, req.account.id);
    if (!gate.visible) {
      res.json({ experiment_id: experimentId, include_test: includeTest, series: [], blinded: true, reading: gate.reading });
      return;
    }
    const series = await getTimeseries(experimentId, read.options);
    res.json({ experiment_id: experimentId, include_test: includeTest, series, blinded: false, reading: gate.reading });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId/recent
// The most recent 20 raw events, unaggregated — a direct "is anything actually
// arriving?" check, independent of the totals/rate calculations above.
router.get('/:experimentId/recent', async (req, res) => {
  const { experimentId } = req.params;
  try {
    const experiment = await assertOwned(req, res, experimentId);
    if (!experiment) return;
    const read = prepared(experiment, req);
    const includeTest = read.includeTest;
    const gate = await outcomeGate(experimentId, includeTest, req.account.id);
    const outcomeSql = gate.visible ? '' : ` AND e.event_type = 'view'`;
    const { rows } = await db.query(
      `SELECT e.event_type, e.goal_id, e.created_at, v.name AS variant_name
       FROM events e JOIN variants v ON v.id = e.variant_id
       WHERE e.experiment_id = $1 AND ${visibleEventSql('e', 2, read.mode)}${outcomeSql}
       ORDER BY e.created_at DESC
       LIMIT 20`,
      [experimentId, includeTest]
    );
    res.json({ events: rows, blinded: !gate.visible, reading: gate.reading });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

function eventCsvRows(rows, extraColumn) {
  const header = ['created_at', 'event_type', 'variant_name', 'goal_id', 'visitor_id', 'visitor_type', 'unique_conversion'];
  if (extraColumn) header.push(extraColumn);
  const body = annotateUniqueConversions(rows).map((row) => header.map((col) => {
    if (col === 'traffic') return 'test';
    return row[col];
  }));
  return [header, ...body];
}

// GET /api/results/:experimentId/export
// Every raw event for this experiment as a downloadable CSV — one row per event,
// including a computed new/returning label per the same day-based rule used above.
// The browser saves this response as-is (GET + Content-Disposition). Do not
// re-wrap it in a blob on the client.
router.get('/:experimentId/export', async (req, res) => {
  const { experimentId } = req.params;
  try {
    const experiment = await assertOwned(req, res, experimentId);
    if (!experiment) return;
    // Test traffic only, including conversions, even while real results are
    // blind. Real visitor rows are not in this file, and peeked_at is not set.
    if (wantsTestOnly(req)) {
      const { rows } = await db.query(
        `${firstSeenCte('test')}
         SELECT e.created_at, e.event_type, v.name AS variant_name, e.goal_id, e.visitor_id,
           CASE WHEN e.created_at::date = fs.first_day THEN 'new' ELSE 'returning' END AS visitor_type
         FROM events e
         JOIN variants v ON v.id = e.variant_id
         LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
         WHERE e.experiment_id = $1 AND ${visibleEventSql('e', 2, 'test')}
         ORDER BY e.created_at ASC`,
        [experimentId, false]
      );
      sendCsv(res, csvFilename(experiment.name, 'test-traffic'), eventCsvRows(rows, 'traffic'));
      return;
    }
    const read = prepared(experiment, req);
    const includeTest = read.includeTest;
    const gate = await outcomeGate(experimentId, includeTest, req.account.id);
    if (!gate.visible) {
      const header = ['variant_name', 'visitors', 'target_visitors', 'traffic_split_percent', 'days_elapsed', 'minimum_days'];
      const progress = (gate.reading && gate.reading.variants) || [];
      const body = progress.map((row) => [
        row.variant_name,
        row.visitors,
        row.target == null ? '' : row.target,
        row.traffic_split == null ? '' : row.traffic_split,
        gate.reading.days_elapsed,
        gate.reading.min_runtime_days == null ? '' : gate.reading.min_runtime_days,
      ]);
      sendCsv(res, csvFilename(experiment.name, 'progress'), [header, ...body]);
      return;
    }
    const { rows } = await db.query(
      `${firstSeenCte(read.mode)}
       SELECT e.created_at, e.event_type, v.name AS variant_name, e.goal_id, e.visitor_id,
         CASE WHEN e.created_at::date = fs.first_day THEN 'new' ELSE 'returning' END AS visitor_type
       FROM events e
       JOIN variants v ON v.id = e.variant_id
       LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
       WHERE e.experiment_id = $1 AND ${visibleEventSql('e', 2, read.mode)}
       ORDER BY e.created_at ASC`,
      [experimentId, includeTest]
    );

    // unique_conversion is 1 only on the first convert for that visitor, variant
    // and goal. Later repeats are 0, so a sum of the column is unique converters.
    sendCsv(res, csvFilename(experiment.name, 'results'), eventCsvRows(rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId/bayesian
// Bayesian read on the same data as the main endpoint: for each variant, the
// posterior mean conversion rate, a 95% credible interval, and the probability
// it's the best-performing variant. See src/bayesian.js for the model itself.
router.get('/:experimentId/bayesian', async (req, res) => {
  const { experimentId } = req.params;
  try {
    const experiment = await assertOwned(req, res, experimentId);
    if (!experiment) return;
    const read = prepared(experiment, req);
    const includeTest = read.includeTest;
    const gate = await outcomeGate(experimentId, includeTest, req.account.id);
    const { variantData } = await getPrimaryVariantData(experimentId, read.options);
    const totalVisitors = variantData.reduce((sum, v) => sum + v.visitors, 0);
    if (!gate.visible) {
      res.json({
        experiment_id: experimentId,
        total_visitors: totalVisitors,
        low_sample_warning: false,
        stats: [],
        blinded: true,
        reading: gate.reading,
      });
      return;
    }
    const stats = computeBayesianStats(variantData);
    const lowSample = variantData.some((v) => v.visitors < 30);

    res.json({
      experiment_id: experimentId,
      total_visitors: totalVisitors,
      low_sample_warning: lowSample,
      stats,
      blinded: false,
      reading: gate.reading,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId/srm
// Sample Ratio Mismatch check: does actual traffic match each variant's
// configured traffic_split, or does the split look broken/biased? See
// src/srm.js for the statistical method and why this matters.
router.get('/:experimentId/srm', async (req, res) => {
  const { experimentId } = req.params;
  try {
    const experiment = await assertOwned(req, res, experimentId);
    if (!experiment) return;
    const read = prepared(experiment, req);
    const { rows } = await db.query(
      `SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         v.traffic_split,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id AND ${visibleEventSql('e', 2, read.mode)}
       WHERE v.experiment_id = $1 AND v.enabled = true
       GROUP BY v.id, v.name, v.traffic_split
       ORDER BY v.name`,
      [experimentId, read.includeTest]
    );

    const variantData = rows.map((r) => ({
      name: r.variant_name,
      visitors: Number(r.visitors),
      traffic_split: r.traffic_split,
    }));

    const srm = detectSRM(variantData);
    res.json({ experiment_id: experimentId, variants: variantData, ...srm });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId/verdict
// Win, loss or inconclusive once the plan is met. Empty until then.
router.get('/:experimentId/verdict', async (req, res) => {
  const { experimentId } = req.params;
  try {
    const experiment = await assertOwned(req, res, experimentId);
    if (!experiment) return;
    const read = prepared(experiment, req);
    const gate = await outcomeGate(experimentId, read.includeTest, req.account.id);
    if (!gate.loaded) return res.status(404).json({ error: 'no experiment found with that id' });
    if (!gate.reading.plan_met) {
      return res.json({ ready: false, reading: gate.reading, peeked: gate.reading.peeked });
    }
    const { variantData } = await getPrimaryVariantData(experimentId, read.options);
    const verdict = buildVerdict({
      variants: variantData,
      plan: gate.loaded.experiment.plan,
      srmDetected: !!(gate.loaded.srm && gate.loaded.srm.srm_detected),
    });
    res.json({ ...verdict, peeked: gate.reading.peeked, reading: gate.reading });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
