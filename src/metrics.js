// Shared goal + conversion logic, used by both the owner results routes
// (routes/results.js) and the client results routes (routes/client.js) so the
// two dashboards can never disagree about what a "conversion" is.
//
// Rules:
//  - A conversion is a unique visitor who viewed the variant and hit a goal.
//    Clicking a goal three times is still one converted visitor, so a rate
//    cannot exceed 100%.
//  - If any goal on the experiment is marked "primary", headline conversions
//    (results table, trend chart, Bayesian winner) use only that goal.
//    Otherwise any goal counts — a visitor who hits several goals still
//    counts once. Per-goal figures count that visitor once for each goal.
//  - Raw convert events are available separately as conversion_events. They
//    are not the rate.
//  - summariseConversions / summariseByGoal / assembleTimeseries are the
//    in-memory statement of these rules (and what the tests lock). The SQL
//    below implements the same rules in Postgres.

const db = require('./db');

const GOAL_TYPES = ['click', 'url', 'form', 'custom', 'revenue'];

function goalKey(goal) {
  if (goal.id) return goal.id;
  const type = goal.type || 'click';
  if (type === 'url') return goal.url_match || '';
  if (type === 'custom' || type === 'revenue') return goal.event || '';
  return goal.selector || '';
}

function conversionRate(visitors, conversions) {
  const v = Number(visitors) || 0;
  const c = Number(conversions) || 0;
  if (v <= 0 || c <= 0) return 0;
  return +(Math.min(c, v) / v * 100).toFixed(2);
}

function goalMatches(goalId, primaryGoalKey) {
  if (primaryGoalKey == null) return true;
  return goalId === primaryGoalKey;
}

// Headline numbers from an event list. conversions is unique viewers who
// converted; conversion_events is the raw count, including repeats.
function summariseConversions(events, { primaryGoalKey = null } = {}) {
  const variants = new Map();
  for (const event of events || []) {
    if (!variants.has(event.variant_id)) {
      variants.set(event.variant_id, {
        variant_id: event.variant_id,
        variant_name: event.variant_name,
        viewers: new Set(),
        converters: new Set(),
        conversion_events: 0,
        clicks: 0,
      });
    }
    const bucket = variants.get(event.variant_id);
    if (event.variant_name) bucket.variant_name = event.variant_name;
    if (event.event_type === 'view') bucket.viewers.add(event.visitor_id);
    if (event.event_type === 'click') bucket.clicks += 1;
    if (event.event_type === 'convert' && goalMatches(event.goal_id, primaryGoalKey)) {
      bucket.conversion_events += 1;
      bucket.converters.add(event.visitor_id);
    }
  }

  return [...variants.values()].map((bucket) => {
    const visitors = bucket.viewers.size;
    let conversions = 0;
    for (const visitorId of bucket.converters) {
      if (bucket.viewers.has(visitorId)) conversions += 1;
    }
    return {
      variant_id: bucket.variant_id,
      variant_name: bucket.variant_name,
      visitors,
      conversions,
      conversion_events: bucket.conversion_events,
      clicks: bucket.clicks,
      conversion_rate: conversionRate(visitors, conversions),
    };
  });
}

// One row per goal per variant. A visitor who triggers the same goal twice
// counts once. Goals are not collapsed into each other.
function summariseByGoal(events, goals) {
  const defs = goals || [];
  const viewers = new Map();
  const names = new Map();
  const hits = new Map();

  for (const event of events || []) {
    if (event.variant_name) names.set(event.variant_id, event.variant_name);
    if (!viewers.has(event.variant_id)) viewers.set(event.variant_id, new Set());
    if (event.event_type === 'view') viewers.get(event.variant_id).add(event.visitor_id);
    if (event.event_type !== 'convert' || !event.goal_id) continue;
    const key = `${event.variant_id}|${event.goal_id}`;
    if (!hits.has(key)) hits.set(key, new Map());
    const perVisitor = hits.get(key);
    perVisitor.set(event.visitor_id, (perVisitor.get(event.visitor_id) || 0) + 1);
  }

  return defs.map((goal) => ({
    key: goal.key,
    type: goal.type,
    label: goal.label,
    primary: !!goal.primary,
    variants: [...viewers.keys()].map((variantId) => {
      const viewed = viewers.get(variantId) || new Set();
      const perVisitor = hits.get(`${variantId}|${goal.key}`) || new Map();
      let conversions = 0;
      let conversionEvents = 0;
      for (const [visitorId, count] of perVisitor) {
        if (!viewed.has(visitorId)) continue;
        conversions += 1;
        conversionEvents += count;
      }
      const visitors = viewed.size;
      return {
        variant_id: variantId,
        variant_name: names.get(variantId),
        visitors,
        conversions,
        conversion_events: conversionEvents,
        conversion_rate: conversionRate(visitors, conversions),
      };
    }),
  }));
}

// Daily rows are unique same-day viewers and same-day converters (a repeat
// click that day is one conversion). Cumulative figures are running unique
// visitors, not a sum of the daily rows — summing daily uniques would count
// a returning visitor twice and can push a rate over 100%.
function assembleTimeseries({ daily = [], firstViews = [], firstConverts = [] } = {}) {
  const variants = new Map();

  function dayKey(day) {
    if (day instanceof Date) return day.toISOString().slice(0, 10);
    return String(day).slice(0, 10);
  }

  function ensure(variantId, variantName, day) {
    if (!variants.has(variantId)) {
      variants.set(variantId, { variant_id: variantId, variant_name: variantName, days: new Map() });
    }
    const variant = variants.get(variantId);
    if (variantName) variant.variant_name = variantName;
    const key = dayKey(day);
    if (!variant.days.has(key)) {
      variant.days.set(key, { visitors: 0, conversions: 0, newVisitors: 0, newConverts: 0 });
    }
    return variant.days.get(key);
  }

  for (const row of daily) {
    const cell = ensure(row.variant_id, row.variant_name, row.day);
    cell.visitors += Number(row.visitors) || 0;
    cell.conversions += Number(row.conversions) || 0;
  }
  for (const row of firstViews) {
    const cell = ensure(row.variant_id, row.variant_name, row.day);
    cell.newVisitors += Number(row.count) || 0;
  }
  for (const row of firstConverts) {
    const cell = ensure(row.variant_id, row.variant_name, row.day);
    cell.newConverts += Number(row.count) || 0;
  }

  const series = [];
  for (const variant of variants.values()) {
    const days = [...variant.days.keys()].sort();
    let cumulativeVisitors = 0;
    let cumulativeConversions = 0;
    for (const day of days) {
      const cell = variant.days.get(day);
      cumulativeVisitors += cell.newVisitors;
      cumulativeConversions += cell.newConverts;
      series.push({
        day,
        variant_id: variant.variant_id,
        variant_name: variant.variant_name,
        visitors: cell.visitors,
        conversions: cell.conversions,
        cumulative_visitors: cumulativeVisitors,
        cumulative_conversions: Math.min(cumulativeConversions, cumulativeVisitors),
      });
    }
  }

  series.sort((a, b) => a.day.localeCompare(b.day) || String(a.variant_name).localeCompare(String(b.variant_name)));
  return series;
}

// Rows must be oldest first. unique_conversion is 1 on the first convert for
// that visitor, variant and goal, and 0 on every later one. Blank for views.
function annotateUniqueConversions(rows) {
  const seen = new Set();
  return (rows || []).map((row) => {
    if (row.event_type !== 'convert') return { ...row, unique_conversion: '' };
    const key = `${row.variant_name}\0${row.visitor_id}\0${row.goal_id || ''}`;
    if (seen.has(key)) return { ...row, unique_conversion: '0' };
    seen.add(key);
    return { ...row, unique_conversion: '1' };
  });
}

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

function visitorTypeClause(visitorType) {
  if (visitorType === 'new') return 'AND e.created_at::date = fs.first_day';
  if (visitorType === 'returning') return 'AND e.created_at::date > fs.first_day';
  return '';
}

function mapResultRow(row) {
  const visitors = Number(row.visitors) || 0;
  const conversions = Math.min(Number(row.conversions) || 0, visitors);
  return {
    variant_id: row.variant_id,
    variant_name: row.variant_name,
    visitors,
    new_visitors: Number(row.new_visitors) || 0,
    returning_visitors: Number(row.returning_visitors) || 0,
    clicks: Number(row.clicks) || 0,
    conversions,
    conversion_events: Number(row.conversion_events) || 0,
    conversion_rate: conversionRate(visitors, conversions),
  };
}

// Unique converting visitors per variant. visitorType limits the visitors,
// conversions and click totals to new or returning; the new/returning columns
// themselves stay the full breakdown.
async function getVariantResults(experimentId, visitorType) {
  const primaryKey = await getPrimaryGoalKey(experimentId);
  const filter = visitorTypeClause(visitorType);
  const { rows } = await db.query(
    `WITH first_seen AS (
       SELECT visitor_id, MIN(created_at)::date AS first_day
       FROM events WHERE experiment_id = $1 AND event_type = 'view'
       GROUP BY visitor_id
     ),
     flags AS (
       SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         e.visitor_id,
         bool_or(e.event_type = 'view' ${filter}) AS viewed,
         bool_or(e.event_type = 'view' AND e.created_at::date = fs.first_day) AS new_view,
         bool_or(e.event_type = 'view' AND e.created_at::date > fs.first_day) AS returning_view,
         bool_or(${PRIMARY_CONVERT} ${filter}) AS converted,
         COUNT(*) FILTER (WHERE e.event_type = 'click' ${filter}) AS clicks,
         COUNT(*) FILTER (WHERE ${PRIMARY_CONVERT} ${filter}) AS conversion_events
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id
       LEFT JOIN first_seen fs ON fs.visitor_id = e.visitor_id
       WHERE v.experiment_id = $1
       GROUP BY v.id, v.name, e.visitor_id
     )
     SELECT
       variant_id,
       variant_name,
       COUNT(*) FILTER (WHERE viewed) AS visitors,
       COUNT(*) FILTER (WHERE new_view) AS new_visitors,
       COUNT(*) FILTER (WHERE returning_view) AS returning_visitors,
       COALESCE(SUM(clicks), 0) AS clicks,
       COUNT(*) FILTER (WHERE viewed AND converted) AS conversions,
       COALESCE(SUM(conversion_events), 0) AS conversion_events
     FROM flags
     GROUP BY variant_id, variant_name
     ORDER BY variant_name`,
    [experimentId, primaryKey]
  );
  return {
    primaryKey,
    results: rows.map(mapResultRow),
  };
}

async function getPrimaryVariantData(experimentId) {
  const { primaryKey, results } = await getVariantResults(experimentId);
  return {
    primaryKey,
    variantData: results.map((row) => ({
      variant_id: row.variant_id,
      variant_name: row.variant_name,
      visitors: row.visitors,
      conversions: row.conversions,
    })),
  };
}

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

  // Converters are viewers, so the per-goal rate cannot exceed 100%.
  // conversion_events keeps the raw count, including repeat clicks.
  const { rows: goalRows } = await db.query(
    `WITH viewers AS (
       SELECT variant_id, visitor_id
       FROM events
       WHERE experiment_id = $1 AND event_type = 'view'
       GROUP BY variant_id, visitor_id
     )
     SELECT e.variant_id, e.goal_id,
       COUNT(DISTINCT e.visitor_id) AS converters,
       COUNT(*) AS conversion_events
     FROM events e
     JOIN viewers w ON w.variant_id = e.variant_id AND w.visitor_id = e.visitor_id
     WHERE e.experiment_id = $1 AND e.event_type = 'convert' AND e.goal_id IS NOT NULL
     GROUP BY e.variant_id, e.goal_id`,
    [experimentId]
  );

  const lookup = new Map(goalRows.map((r) => [`${r.variant_id}|${r.goal_id}`, r]));
  const breakdown = goals.map((goal) => ({
    ...goal,
    variants: visitorRows.map((v) => {
      const hit = lookup.get(`${v.variant_id}|${goal.key}`);
      const visitors = Number(v.visitors) || 0;
      const conversions = Math.min(hit ? Number(hit.converters) || 0 : 0, visitors);
      return {
        variant_id: v.variant_id,
        variant_name: v.variant_name,
        visitors,
        conversions,
        conversion_events: hit ? Number(hit.conversion_events) || 0 : 0,
        conversion_rate: conversionRate(visitors, conversions),
      };
    }),
  }));

  return { primary_goal: (goals.find((g) => g.primary) || {}).key || null, goals: breakdown };
}

async function getTimeseries(experimentId) {
  const primaryKey = await getPrimaryGoalKey(experimentId);
  const { rows: daily } = await db.query(
    `WITH ev AS (
       SELECT
         v.id AS variant_id,
         v.name AS variant_name,
         e.visitor_id,
         e.created_at::date AS day,
         bool_or(e.event_type = 'view') AS viewed,
         bool_or(${PRIMARY_CONVERT}) AS converted
       FROM events e
       JOIN variants v ON v.id = e.variant_id
       WHERE e.experiment_id = $1
       GROUP BY v.id, v.name, e.visitor_id, e.created_at::date
     )
     SELECT variant_id, variant_name, day::text AS day,
       COUNT(*) FILTER (WHERE viewed) AS visitors,
       COUNT(*) FILTER (WHERE viewed AND converted) AS conversions
     FROM ev
     GROUP BY variant_id, variant_name, day
     ORDER BY day`,
    [experimentId, primaryKey]
  );

  const { rows: firsts } = await db.query(
    `SELECT
       v.id AS variant_id,
       v.name AS variant_name,
       e.visitor_id,
       (MIN(e.created_at) FILTER (WHERE e.event_type = 'view'))::date::text AS first_view,
       (MIN(e.created_at) FILTER (WHERE ${PRIMARY_CONVERT}))::date::text AS first_convert
     FROM events e
     JOIN variants v ON v.id = e.variant_id
     WHERE e.experiment_id = $1
     GROUP BY v.id, v.name, e.visitor_id`,
    [experimentId, primaryKey]
  );

  const firstViews = [];
  const firstConverts = [];
  const viewCounts = new Map();
  const convertCounts = new Map();
  for (const row of firsts) {
    if (!row.first_view) continue;
    const viewKey = `${row.variant_id}|${row.first_view}`;
    if (!viewCounts.has(viewKey)) {
      viewCounts.set(viewKey, { variant_id: row.variant_id, variant_name: row.variant_name, day: row.first_view, count: 0 });
    }
    viewCounts.get(viewKey).count += 1;
    if (!row.first_convert) continue;
    const convertDay = row.first_convert > row.first_view ? row.first_convert : row.first_view;
    const convertKey = `${row.variant_id}|${convertDay}`;
    if (!convertCounts.has(convertKey)) {
      convertCounts.set(convertKey, { variant_id: row.variant_id, variant_name: row.variant_name, day: convertDay, count: 0 });
    }
    convertCounts.get(convertKey).count += 1;
  }
  firstViews.push(...viewCounts.values());
  firstConverts.push(...convertCounts.values());

  return assembleTimeseries({ daily, firstViews, firstConverts });
}

module.exports = {
  GOAL_TYPES,
  goalKey,
  conversionRate,
  summariseConversions,
  summariseByGoal,
  assembleTimeseries,
  annotateUniqueConversions,
  getGoalDefs,
  getPrimaryGoalKey,
  getVariantResults,
  getPrimaryVariantData,
  getGoalBreakdown,
  getTimeseries,
  PRIMARY_CONVERT,
  visitorTypeClause,
};
