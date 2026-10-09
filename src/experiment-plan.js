// Load, suggest and store an experiment plan. Never writes to events.

const db = require('./db');
const { detectSRM } = require('./srm');
const { normaliseHost } = require('./host-scope');
const {
  DEFAULT_BASELINE,
  MIN_BASELINE_VISITORS,
  buildPlan,
  autoPlanInput,
} = require('./plan');
const { planProgress, describeReading, publicPlan } = require('./reading');

const TRAFFIC_DAYS = 28;
const MIN_TRAFFIC_VISITORS = 30;

function primaryGoalId(goals) {
  const list = Array.isArray(goals) ? goals : [];
  const primary = list.find((goal) => goal && goal.primary && goal.id);
  if (primary) return String(primary.id);
  if (list.length === 1 && list[0] && list[0].id) return String(list[0].id);
  return null;
}

function percentText(rate) {
  const pct = rate * 100;
  const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

async function loadExperiment(experimentId, query = db.query.bind(db), accountId) {
  const params = [experimentId];
  let accountSql = '';
  if (accountId) {
    params.push(accountId);
    accountSql = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT id, name, status, url_match, allowed_hosts, goals, plan, started_at, peeked_at, created_at, client_id, account_id, site_id
     FROM experiments WHERE id = $1${accountSql}`,
    params
  );
  return rows[0] || null;
}

async function visitorRows(experimentId, includeTest, query = db.query.bind(db)) {
  const { rows } = await query(
    `SELECT v.id, v.name, v.traffic_split, v.enabled, v.created_at,
       COUNT(DISTINCT e.visitor_id) FILTER (
         WHERE e.event_type = 'view'
           AND e.excluded_at IS NULL
           AND ($2::boolean OR e.is_test = false)
       )::int AS visitors
     FROM variants v
     LEFT JOIN events e ON e.variant_id = v.id
     WHERE v.experiment_id = $1
     GROUP BY v.id
     ORDER BY v.created_at`,
    [experimentId, !!includeTest]
  );
  return rows.map((row) => ({
    id: row.id,
    variant_id: row.id,
    name: row.name,
    variant_name: row.name,
    traffic_split: row.traffic_split,
    enabled: row.enabled !== false,
    created_at: row.created_at,
    visitors: Number(row.visitors) || 0,
  }));
}

async function rateFor(experimentIds, goalId, query) {
  if (!experimentIds.length) return { visitors: 0, conversions: 0 };
  const { rows } = await query(
    `SELECT
       COUNT(DISTINCT visitor_id) FILTER (WHERE event_type = 'view')::int AS visitors,
       COUNT(DISTINCT visitor_id) FILTER (
         WHERE event_type = 'convert' AND ($2::text IS NULL OR goal_id = $2::text)
       )::int AS conversions
     FROM events
     WHERE experiment_id = ANY($1::uuid[])
       AND excluded_at IS NULL
       AND is_test = false`,
    [experimentIds, goalId]
  );
  return {
    visitors: Number(rows[0] && rows[0].visitors) || 0,
    conversions: Number(rows[0] && rows[0].conversions) || 0,
  };
}

async function relatedIds(experiment, query) {
  const hosts = Array.isArray(experiment.allowed_hosts) ? experiment.allowed_hosts : [];
  const params = [experiment.id, experiment.url_match || '', hosts];
  let accountSql = '';
  if (experiment.account_id) {
    params.push(experiment.account_id);
    accountSql = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT id FROM experiments
     WHERE id <> $1
       AND (
         ($2 <> '' AND url_match = $2)
         OR (cardinality($3::text[]) > 0 AND allowed_hosts && $3::text[])
       )${accountSql}`,
    params
  );
  return rows.map((row) => row.id);
}

function baselineFromRate(rate, sourceLabel) {
  if (!rate || rate.visitors < MIN_BASELINE_VISITORS || !(rate.conversions > 0)) return null;
  const value = rate.conversions / rate.visitors;
  if (!(value > 0 && value < 1)) return null;
  return {
    baseline_rate: value,
    baseline_source: 'history',
    baseline_label: `${sourceLabel}: ${percentText(value)}% over ${rate.visitors.toLocaleString('en-GB')} visitors. You can change it.`,
  };
}

async function recentWeeklyVisitors(experimentIds, query) {
  if (!experimentIds.length) return null;
  const { rows } = await query(
    `SELECT COUNT(DISTINCT visitor_id)::int AS visitors
     FROM events
     WHERE experiment_id = ANY($1::uuid[])
       AND event_type = 'view'
       AND excluded_at IS NULL
       AND is_test = false
       AND created_at >= now() - interval '28 days'`,
    [experimentIds]
  );
  const visitors = Number(rows[0] && rows[0].visitors) || 0;
  if (visitors < MIN_TRAFFIC_VISITORS) return null;
  return {
    weekly_traffic: Math.max(1, Math.round(visitors / TRAFFIC_DAYS * 7)),
    traffic_source: 'visitors',
    traffic_label: 'Estimated from visitors over the last 28 days. You can change it.',
  };
}

async function weeklyFromHostHits(experiment, query) {
  const hosts = new Set(
    (experiment.allowed_hosts || []).map((host) => normaliseHost(host)).filter(Boolean)
  );
  if (hosts.size === 0) {
    const fromUrl = normaliseHost(experiment.url_match);
    if (fromUrl) hosts.add(fromUrl);
  }
  if (hosts.size === 0) return null;
  const params = [TRAFFIC_DAYS];
  let accountSql = '';
  if (experiment.account_id) {
    params.push(experiment.account_id);
    accountSql = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT referrer_origin, SUM(hit_count)::int AS hits
     FROM host_hits
     WHERE day >= (CURRENT_DATE - $1::int)
       AND referrer_origin <> ''${accountSql}
     GROUP BY referrer_origin`,
    params
  );
  let hits = 0;
  rows.forEach((row) => {
    const host = normaliseHost(row.referrer_origin);
    if (host && hosts.has(host)) hits += Number(row.hits) || 0;
  });
  if (hits < MIN_TRAFFIC_VISITORS) return null;
  return {
    weekly_traffic: Math.max(1, Math.round(hits / TRAFFIC_DAYS * 7)),
    traffic_source: 'host_hits',
    traffic_label: 'Estimated from snippet traffic over the last 28 days (page loads, not unique visitors). You can change it.',
  };
}

async function suggest(experimentId, query = db.query.bind(db), accountId) {
  const experiment = await loadExperiment(experimentId, query, accountId);
  if (!experiment) return null;
  const goalId = primaryGoalId(experiment.goals);
  const related = await relatedIds(experiment, query);
  const own = await rateFor([experimentId], goalId, query);
  const page = await rateFor(related, goalId, query);
  const fromOwn = baselineFromRate(own, 'From this test so far');
  const fromPage = baselineFromRate(page, 'From past results on this page');
  const baseline = fromOwn || fromPage || {
    baseline_rate: DEFAULT_BASELINE,
    baseline_source: 'default',
    baseline_label: 'Estimate: 3%, because there is not enough past data yet. You can change it.',
  };
  const traffic = await recentWeeklyVisitors([experimentId, ...related], query)
    || await weeklyFromHostHits(experiment, query)
    || {
      weekly_traffic: null,
      traffic_source: 'unknown',
      traffic_label: 'No recent traffic yet. Add the visitors you expect in a week.',
    };
  const variants = await visitorRows(experimentId, false, query);
  return {
    ...baseline,
    ...traffic,
    goal_id: goalId,
    variant_count: variants.filter((variant) => variant.enabled).length,
    variants,
  };
}

function srmFor(variants) {
  const enabled = (variants || []).filter((variant) => variant.enabled !== false);
  return detectSRM(enabled.map((variant) => ({
    name: variant.variant_name || variant.name,
    visitors: Number(variant.visitors) || 0,
    traffic_split: variant.traffic_split,
  })));
}

async function loadReading(experimentId, { includeTest = false, now = new Date(), query = db.query.bind(db), accountId } = {}) {
  const experiment = await loadExperiment(experimentId, query, accountId);
  if (!experiment) return null;
  const variants = await visitorRows(experimentId, includeTest, query);
  const progress = planProgress({
    plan: experiment.plan,
    startedAt: experiment.started_at,
    now,
    variants,
  });
  const srm = srmFor(variants);
  const reading = describeReading({
    status: experiment.status,
    plan: experiment.plan,
    peekedAt: experiment.peeked_at,
    progress,
    srmDetected: !!(srm && srm.srm_detected),
  });
  return { experiment, variants, progress, srm, reading };
}

function readingPayload(loaded) {
  if (!loaded) return null;
  const { experiment, progress, reading } = loaded;
  return {
    mode: reading.mode,
    outcome_visible: reading.outcome_visible,
    peeked: reading.peeked,
    has_plan: reading.has_plan,
    plan_met: reading.plan_met,
    plan: publicPlan(experiment.plan),
    started_at: experiment.started_at,
    peeked_at: experiment.peeked_at,
    days_elapsed: progress.days_elapsed,
    min_runtime_days: progress.min_runtime_days,
    runtime_met: progress.runtime_met,
    sample_met: progress.sample_met,
    variants: progress.variants,
    total_visitors: progress.variants.reduce((sum, row) => sum + (Number(row.visitors) || 0), 0),
  };
}

async function outcomeGate(experimentId, includeTest, accountId) {
  const loaded = await loadReading(experimentId, { includeTest: !!includeTest, accountId });
  const reading = loaded ? readingPayload(loaded) : null;
  return { loaded, reading, visible: !reading || reading.outcome_visible };
}

async function savePlan(experimentId, input, query = db.query.bind(db), accountId) {
  const experiment = await loadExperiment(experimentId, query, accountId);
  if (!experiment) return { ok: false, status: 404, error: 'no experiment found with that id' };
  const variants = await visitorRows(experimentId, false, query);
  const enabled = variants.filter((variant) => variant.enabled);
  const built = buildPlan(Object.assign({}, input, {
    variant_count: input.variant_count || enabled.length || variants.length || 2,
    weights: input.weights || (enabled.length >= 2 ? enabled.map((variant) => variant.traffic_split) : null),
  }));
  if (!built.ok) return { ok: false, status: 400, error: built.error };
  const { rows } = await query(
    `UPDATE experiments SET plan = $2::jsonb
     WHERE id = $1 AND ($3::uuid IS NULL OR account_id = $3)
     RETURNING plan`,
    [experimentId, JSON.stringify(built.plan), accountId || null]
  );
  if (rows.length === 0) return { ok: false, status: 404, error: 'no experiment found with that id' };
  return { ok: true, plan: rows[0].plan };
}

async function ensurePlanOnStart(experiment, query = db.query.bind(db)) {
  if (experiment.plan && experiment.plan.visitors_per_variant) return experiment.plan;
  const suggestion = await suggest(experiment.id, query, experiment.account_id);
  const variants = suggestion ? suggestion.variants : [];
  const built = buildPlan(autoPlanInput(suggestion, variants));
  if (!built.ok) return null;
  await query(
    `UPDATE experiments SET plan = $2::jsonb
     WHERE id = $1 AND plan IS NULL AND ($3::uuid IS NULL OR account_id = $3)`,
    [experiment.id, JSON.stringify(built.plan), experiment.account_id || null]
  );
  return built.plan;
}

async function recordReveal({ experimentId, actor, actorIp, query = db.query.bind(db), accountId } = {}) {
  const experiment = await loadExperiment(experimentId, query, accountId);
  if (!experiment) return { ok: false, status: 404, error: 'no experiment found with that id' };
  if (!experiment.plan) {
    return { ok: false, status: 400, error: 'Set a plan before revealing early. There is nothing to peek yet.' };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE experiments
       SET peeked_at = COALESCE(peeked_at, now())
       WHERE id = $1 AND ($2::uuid IS NULL OR account_id = $2)
       RETURNING peeked_at`,
      [experimentId, accountId || null]
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'no experiment found with that id' };
    }
    const audit = await client.query(
      `INSERT INTO test_traffic_audit
         (experiment_id, action, actor, actor_ip, criteria, visitor_count, event_count, variant_counts)
       VALUES ($1, 'reveal', $2, $3, $4::jsonb, 0, 0, '[]'::jsonb)
       RETURNING id, created_at`,
      [
        experimentId,
        actor || 'owner',
        actorIp || null,
        JSON.stringify({ kind: 'peek', warning: 'Looked before the planned sample.' }),
      ]
    );
    await client.query('COMMIT');
    return {
      ok: true,
      peeked_at: updated.rows[0].peeked_at,
      audit_id: audit.rows[0].id,
      created_at: audit.rows[0].created_at,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  primaryGoalId,
  loadExperiment,
  visitorRows,
  suggest,
  loadReading,
  readingPayload,
  outcomeGate,
  savePlan,
  ensurePlanOnStart,
  recordReveal,
  srmFor,
};
