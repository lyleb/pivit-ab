// Shared goal + conversion logic, used by both the owner results routes
// (routes/results.js) and the client results routes (routes/client.js) so the
// two dashboards can never disagree about what a "conversion" is.
//
// Rules:
//  - A conversion is a unique VISITOR who hit a goal, not a raw event. Clicking
//    a goal button three times is still one converted visitor. (Before this,
//    raw events were counted, which could push a rate over 100% and skewed
//    the Bayesian numbers.)
//  - If any goal on the experiment is marked "primary", headline conversions
//    (results table, trend chart, Bayesian winner) use only that goal.
//    Otherwise any goal counts — the same behaviour experiments had before
//    primary goals existed.
//  - Revenue is summed from every convert event that carries a value, so two
//    purchases by the same visitor both count towards revenue.

const db = require('./db');
const { computeBayesianStats } = require('./bayesian');

const GOAL_TYPES = ['click', 'url', 'form', 'custom', 'revenue'];

// The string stored in events.goal_id for a goal. MUST match goalKey() in
// snippet/ab.js — that's how an event is tied back to its goal definition.
function goalKey(goal) {
  if (goal.id) return goal.id;
  const type = goal.type || 'click';
  if (type === 'url') return goal.url_match || '';
  if (type === 'custom' || type === 'revenue') return goal.event || '';
  return goal.selector || '';
}

// Every distinct goal across an experiment's variants (variants usually share
// the same goals, but they're stored per variant, so de-duplicate by key).
async function getGoalDefs(experimentId) {
  const { rows } = await db.query(`SELECT goals FROM variants WHERE experiment_id = $1 ORDER BY created_at`, [experimentId]);
  const byKey = new Map();
  rows.forEach((r) => {
    (r.goals || []).forEach((g) => {
      const key = goalKey(g);
      if (!key) return;
      const existing = byKey.get(key);
      if (existing) {
        existing.primary = existing.primary || !!g.primary;
      } else {
        byKey.set(key, { key, type: g.type || 'click', label: g.id || key, primary: !!g.primary });
      }
    });
  });
  return Array.from(byKey.values());
}

async function getPrimaryGoalKey(experimentId) {
  const goals = await getGoalDefs(experimentId);
  const primary = goals.find((g) => g.primary);
  return primary ? primary.key : null;
}

// SQL fragment: counts as a conversion for the headline numbers. Expects the
// primary goal key (or null for "any goal") as parameter $2.
const PRIMARY_CONVERT = `e.event_type = 'convert' AND ($2::text IS NULL OR e.goal_id = $2::text)`;

// Visitors + converted visitors per variant on the primary goal — the input
// the Bayesian model needs.
async function getPrimaryVariantData(experimentId) {
  const primaryKey = await getPrimaryGoalKey(experimentId);
  const { rows } = await db.query(
    `SELECT
       v.id AS variant_id,
       v.name AS variant_name,
       COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors,
       COUNT(DISTINCT e.visitor_id) FILTER (WHERE ${PRIMARY_CONVERT}) AS conversions
     FROM variants v
     LEFT JOIN events e ON e.variant_id = v.id
     WHERE v.experiment_id = $1
     GROUP BY v.id, v.name
     ORDER BY v.name`,
    [experimentId, primaryKey]
  );
  return {
    primaryKey,
    variantData: rows.map((r) => ({
      variant_id: r.variant_id,
      variant_name: r.variant_name,
      visitors: Number(r.visitors),
      conversions: Number(r.conversions),
    })),
  };
}

// Per-goal breakdown: for every goal, each variant's converted visitors, rate,
// revenue, and probability of being best on THAT goal.
async function getGoalBreakdown(experimentId) {
  const goals = await getGoalDefs(experimentId);

  const { rows: visitorRows } = await db.query(
    `SELECT v.id AS variant_id, v.name AS variant_name,
       COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors
     FROM variants v LEFT JOIN events e ON e.variant_id = v.id
     WHERE v.experiment_id = $1
     GROUP BY v.id, v.name ORDER BY v.name`,
    [experimentId]
  );

  const { rows: goalRows } = await db.query(
    `SELECT variant_id, goal_id,
       COUNT(DISTINCT visitor_id) AS converters,
       COALESCE(SUM(value), 0) AS revenue,
       COUNT(*) FILTER (WHERE value IS NOT NULL) AS orders
     FROM events
     WHERE experiment_id = $1 AND event_type = 'convert' AND goal_id IS NOT NULL
     GROUP BY variant_id, goal_id`,
    [experimentId]
  );

  const lookup = new Map(goalRows.map((r) => [`${r.variant_id}|${r.goal_id}`, r]));

  const breakdown = goals.map((goal) => {
    const variants = visitorRows.map((v) => {
      const hit = lookup.get(`${v.variant_id}|${goal.key}`);
      const visitors = Number(v.visitors);
      const converters = hit ? Number(hit.converters) : 0;
      const revenue = hit ? Number(hit.revenue) : 0;
      const orders = hit ? Number(hit.orders) : 0;
      return {
        variant_id: v.variant_id,
        variant_name: v.variant_name,
        visitors,
        conversions: converters,
        conversion_rate: visitors > 0 ? +(converters / visitors * 100).toFixed(2) : 0,
        revenue: +revenue.toFixed(2),
        revenue_per_visitor: visitors > 0 ? +(revenue / visitors).toFixed(2) : 0,
        average_order_value: orders > 0 ? +(revenue / orders).toFixed(2) : 0,
      };
    });

    const stats = variants.length >= 2 ? computeBayesianStats(variants, 10000) : [];
    variants.forEach((v, i) => { v.probability_best = stats[i] ? stats[i].probability_best : null; });

    return { ...goal, variants };
  });

  return { primary_goal: (goals.find((g) => g.primary) || {}).key || null, goals: breakdown };
}

module.exports = { GOAL_TYPES, goalKey, getGoalDefs, getPrimaryGoalKey, getPrimaryVariantData, getGoalBreakdown, PRIMARY_CONVERT };
