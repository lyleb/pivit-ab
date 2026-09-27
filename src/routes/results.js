const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeBayesianStats } = require('../bayesian');
const router = express.Router();

router.use(requireAuth(['owner'])); // results are for your eyes only, not the public snippet

// Every route accepts ?data_source=live|demo (default live) so real visitor data
// and synthetic show-and-tell data never mix — a single boolean parameter threaded
// through every query below via $2, alongside experimentId as $1.
function parseDataSource(req) {
  return req.query.data_source === 'demo';
}

// "New" vs "returning" is defined by day, not by event count: a visitor is "new"
// on the calendar day of their first-ever view for this experiment, and
// "returning" on any later day they come back. This deliberately does NOT count
// a second pageview in the same sitting (e.g. a refresh) as "returning" — only
// an actual later visit does.
const FIRST_SEEN_CTE = `
  WITH first_seen AS (
    SELECT visitor_id, MIN(created_at)::date AS first_day
    FROM events WHERE experiment_id = $1 AND event_type = 'view' AND is_demo = $2
    GROUP BY visitor_id
  )
`;

function visitorTypeClause(visitorType) {
  if (visitorType === 'new') return "AND e.created_at::date = fs.first_day";
  if (visitorType === 'returning') return "AND e.created_at::date > fs.first_day";
  return '';
}

// GET /api/results/:experimentId?visitor_type=new|returning&data_source=live|demo
// Returns per-variant counts: unique visitors, views, clicks, conversions, conversion
// rate, plus a new/returning visitor breakdown. visitor_type optionally restricts
// the visitors/clicks/conversions/rate figures to just that segment.
router.get('/:experimentId', async (req, res) => {
  const { experimentId } = req.params;
  const filterClause = visitorTypeClause(req.query.visitor_type);
  const isDemo = parseDataSource(req);

  try {
    const { rows } = await db.query(
      `${FIRST_SEEN_CTE}
       SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view' ${filterClause}) AS visitors,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view' AND e.created_at::date = fs.first_day) AS new_visitors,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view' AND e.created_at::date > fs.first_day) AS returning_visitors,
         COUNT(*) FILTER (WHERE e.event_type = 'click' ${filterClause}) AS clicks,
         COUNT(*) FILTER (WHERE e.event_type = 'convert' ${filterClause}) AS conversions
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id AND e.is_demo = $2
       LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
       WHERE v.experiment_id = $1
       GROUP BY v.id, v.name
       ORDER BY v.name`,
      [experimentId, isDemo]
    );

    const results = rows.map((r) => ({
      ...r,
      visitors: Number(r.visitors),
      new_visitors: Number(r.new_visitors),
      returning_visitors: Number(r.returning_visitors),
      clicks: Number(r.clicks),
      conversions: Number(r.conversions),
      conversion_rate: r.visitors > 0 ? +(r.conversions / r.visitors * 100).toFixed(2) : 0,
    }));

    res.json({ experiment_id: experimentId, visitor_type: req.query.visitor_type || 'all', data_source: isDemo ? 'demo' : 'live', results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId/timeseries?data_source=live|demo
// Daily visitor + conversion counts per variant, for the trend chart.
router.get('/:experimentId/timeseries', async (req, res) => {
  const { experimentId } = req.params;
  const isDemo = parseDataSource(req);

  try {
    const { rows } = await db.query(
      `SELECT
         date_trunc('day', e.created_at) AS day,
         v.id AS variant_id,
         v.name AS variant_name,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors,
         COUNT(*) FILTER (WHERE e.event_type = 'convert') AS conversions
       FROM events e
       JOIN variants v ON v.id = e.variant_id
       WHERE e.experiment_id = $1 AND e.is_demo = $2
       GROUP BY day, v.id, v.name
       ORDER BY day`,
      [experimentId, isDemo]
    );

    const series = rows.map((r) => ({
      day: r.day,
      variant_id: r.variant_id,
      variant_name: r.variant_name,
      visitors: Number(r.visitors),
      conversions: Number(r.conversions),
    }));

    res.json({ experiment_id: experimentId, series });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/results/:experimentId/recent?data_source=live|demo
// The most recent 20 raw events, unaggregated — a direct "is anything actually
// arriving?" check, independent of the totals/rate calculations above.
router.get('/:experimentId/recent', async (req, res) => {
  const { experimentId } = req.params;
  const isDemo = parseDataSource(req);
  try {
    const { rows } = await db.query(
      `SELECT e.event_type, e.goal_id, e.created_at, v.name AS variant_name
       FROM events e JOIN variants v ON v.id = e.variant_id
       WHERE e.experiment_id = $1 AND e.is_demo = $2
       ORDER BY e.created_at DESC
       LIMIT 20`,
      [experimentId, isDemo]
    );
    res.json({ events: rows });
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

// GET /api/results/:experimentId/export?data_source=live|demo
// Every raw event for this experiment as a downloadable CSV — one row per event,
// including a computed new/returning label per the same day-based rule used above.
router.get('/:experimentId/export', async (req, res) => {
  const { experimentId } = req.params;
  const isDemo = parseDataSource(req);
  try {
    const { rows } = await db.query(
      `${FIRST_SEEN_CTE}
       SELECT e.created_at, e.event_type, v.name AS variant_name, e.goal_id, e.visitor_id,
         CASE WHEN e.created_at::date = fs.first_day THEN 'new' ELSE 'returning' END AS visitor_type
       FROM events e
       JOIN variants v ON v.id = e.variant_id
       LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
       WHERE e.experiment_id = $1 AND e.is_demo = $2
       ORDER BY e.created_at ASC`,
      [experimentId, isDemo]
    );

    const header = ['created_at', 'event_type', 'variant_name', 'goal_id', 'visitor_id', 'visitor_type'];
    const lines = [header.join(',')];
    rows.forEach((r) => {
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

// GET /api/results/:experimentId/bayesian?data_source=live|demo
// Bayesian read on the same data as the main endpoint: for each variant, the
// posterior mean conversion rate, a 95% credible interval, and the probability
// it's the best-performing variant. See src/bayesian.js for the model itself.
router.get('/:experimentId/bayesian', async (req, res) => {
  const { experimentId } = req.params;
  const isDemo = parseDataSource(req);
  try {
    const { rows } = await db.query(
      `SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors,
         COUNT(*) FILTER (WHERE e.event_type = 'convert') AS conversions
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id AND e.is_demo = $2
       WHERE v.experiment_id = $1
       GROUP BY v.id, v.name
       ORDER BY v.name`,
      [experimentId, isDemo]
    );

    const variantData = rows.map((r) => ({
      variant_id: r.variant_id,
      variant_name: r.variant_name,
      visitors: Number(r.visitors),
      conversions: Number(r.conversions),
    }));

    const stats = computeBayesianStats(variantData);
    const totalVisitors = variantData.reduce((sum, v) => sum + v.visitors, 0);
    const lowSample = variantData.some((v) => v.visitors < 30);

    res.json({ experiment_id: experimentId, data_source: isDemo ? 'demo' : 'live', total_visitors: totalVisitors, low_sample_warning: lowSample, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
