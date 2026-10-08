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
const router = express.Router();

router.use(requireAuth(['owner'])); // results are for your eyes only, not the public snippet

function wantsTestTraffic(req) {
  return flagIsOn(req.query && req.query.include_test);
}

// "New" vs "returning" is defined by day, not by event count: a visitor is "new"
// on the calendar day of their first-ever view for this experiment, and
// "returning" on any later day they come back. This deliberately does NOT count
// a second pageview in the same sitting (e.g. a refresh) as "returning" — only
// an actual later visit does. Test traffic follows the same rule as the table.
function firstSeenCte() {
  return `
  WITH first_seen AS (
    SELECT visitor_id, MIN(created_at)::date AS first_day
    FROM events
    WHERE experiment_id = $1 AND event_type = 'view'
      AND ${visibleEventSql('', 2)}
    GROUP BY visitor_id
  )
`;
}

// GET /api/results/:experimentId?visitor_type=new|returning
// conversions is unique converting visitors (rate cannot exceed 100%).
// conversion_events is the raw goal-hit count, including repeats.
// goals breaks the same unique count out per goal when an experiment has several.
router.get('/:experimentId', async (req, res) => {
  const { experimentId } = req.params;
  const includeTest = wantsTestTraffic(req);

  try {
    const [{ results, primaryKey }, breakdown, testTraffic] = await Promise.all([
      getVariantResults(experimentId, req.query.visitor_type, { includeTest }),
      getGoalBreakdown(experimentId, { includeTest }),
      summariseTestTraffic(experimentId),
    ]);

    const gate = await outcomeGate(experimentId, includeTest);
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
    const includeTest = wantsTestTraffic(req);
    const gate = await outcomeGate(experimentId, includeTest);
    if (!gate.visible) {
      res.json({ experiment_id: experimentId, include_test: includeTest, series: [], blinded: true, reading: gate.reading });
      return;
    }
    const series = await getTimeseries(experimentId, { includeTest });
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
    const includeTest = wantsTestTraffic(req);
    const gate = await outcomeGate(experimentId, includeTest);
    const outcomeSql = gate.visible ? '' : ` AND e.event_type = 'view'`;
    const { rows } = await db.query(
      `SELECT e.event_type, e.goal_id, e.created_at, v.name AS variant_name
       FROM events e JOIN variants v ON v.id = e.variant_id
       WHERE e.experiment_id = $1 AND ${visibleEventSql('e', 2)}${outcomeSql}
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

// Minimal CSV field escaping: wrap in quotes and double up any embedded quotes
// whenever the field contains a comma, quote, or newline.
function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// GET /api/results/:experimentId/export
// Every raw event for this experiment as a downloadable CSV — one row per event,
// including a computed new/returning label per the same day-based rule used above.
router.get('/:experimentId/export', async (req, res) => {
  const { experimentId } = req.params;
  try {
    const includeTest = wantsTestTraffic(req);
    const gate = await outcomeGate(experimentId, includeTest);
    if (!gate.visible) {
      const header = ['variant_name', 'visitors', 'target_visitors', 'traffic_split_percent', 'days_elapsed', 'minimum_days'];
      const lines = [header.join(',')];
      const progress = (gate.reading && gate.reading.variants) || [];
      progress.forEach((row) => {
        lines.push([
          csvField(row.variant_name),
          row.visitors,
          row.target == null ? '' : row.target,
          row.traffic_split == null ? '' : row.traffic_split,
          gate.reading.days_elapsed,
          gate.reading.min_runtime_days == null ? '' : gate.reading.min_runtime_days,
        ].join(','));
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="experiment-${experimentId}-progress.csv"`);
      res.send(lines.join('\n'));
      return;
    }
    const { rows } = await db.query(
      `${firstSeenCte()}
       SELECT e.created_at, e.event_type, v.name AS variant_name, e.goal_id, e.visitor_id,
         CASE WHEN e.created_at::date = fs.first_day THEN 'new' ELSE 'returning' END AS visitor_type
       FROM events e
       JOIN variants v ON v.id = e.variant_id
       LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
       WHERE e.experiment_id = $1 AND ${visibleEventSql('e', 2)}
       ORDER BY e.created_at ASC`,
      [experimentId, includeTest]
    );

    const header = ['created_at', 'event_type', 'variant_name', 'goal_id', 'visitor_id', 'visitor_type', 'unique_conversion'];
    const lines = [header.join(',')];
    // unique_conversion is 1 only on the first convert for that visitor, variant
    // and goal. Later repeats are 0, so a sum of the column is unique converters.
    annotateUniqueConversions(rows).forEach((r) => {
      lines.push(header.map((col) => csvField(r[col])).join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="experiment-${experimentId}-export.csv"`);
    res.send(lines.join('\n'));
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
    const includeTest = wantsTestTraffic(req);
    const gate = await outcomeGate(experimentId, includeTest);
    const { variantData } = await getPrimaryVariantData(experimentId, { includeTest });
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
    const includeTest = wantsTestTraffic(req);
    const { rows } = await db.query(
      `SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         v.traffic_split,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id AND ${visibleEventSql('e', 2)}
       WHERE v.experiment_id = $1 AND v.enabled = true
       GROUP BY v.id, v.name, v.traffic_split
       ORDER BY v.name`,
      [experimentId, includeTest]
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
    const includeTest = wantsTestTraffic(req);
    const gate = await outcomeGate(experimentId, includeTest);
    if (!gate.loaded) return res.status(404).json({ error: 'no experiment found with that id' });
    if (!gate.reading.plan_met) {
      return res.json({ ready: false, reading: gate.reading, peeked: gate.reading.peeked });
    }
    const { variantData } = await getPrimaryVariantData(experimentId, { includeTest });
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
