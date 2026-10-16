// When a demo test reaches its fixed sample, store the daily result straight
// away so the verdict, the conclusion PDF and client approval do not wait
// for the 06:00 job. Real visitors are not counted. A result already stored
// is left as it is.

const db = require('./db');
const { isDemo, demoPlan, DEMO_VISITORS_PER_VARIANT } = require('./demo-test');
const { snapshotExperiment } = require('./snapshot');
const { londonDateISO } = require('./clock');

async function variantCounts(experimentId) {
  const { rows } = await db.query(
    `SELECT v.id, v.enabled,
       COUNT(DISTINCT e.visitor_id) FILTER (
         WHERE e.event_type = 'view' AND e.excluded_at IS NULL AND e.is_test = true
       )::int AS visitors
     FROM variants v
     LEFT JOIN events e ON e.variant_id = v.id
     WHERE v.experiment_id = $1
     GROUP BY v.id`,
    [experimentId]
  );
  return rows;
}

async function alreadyConcluded(experimentId) {
  const { rows } = await db.query(
    `SELECT 1
     FROM status_snapshots
     WHERE experiment_id = $1
       AND detail #> '{public,concluded}' IS NOT NULL
     LIMIT 1`,
    [experimentId]
  );
  return rows.length > 0;
}

async function refreshDemoPlan(query, experimentId) {
  const run = query || db.query.bind(db);
  const { rows } = await run(
    `SELECT test_type FROM experiments WHERE id = $1`,
    [experimentId]
  );
  if (!rows[0] || rows[0].test_type !== 'demo') return null;
  const { rows: counts } = await run(
    `SELECT COUNT(*)::int AS n FROM variants WHERE experiment_id = $1 AND enabled`,
    [experimentId]
  );
  const plan = demoPlan({ variantCount: counts[0] ? counts[0].n : 2 });
  await run(
    `UPDATE experiments SET plan = $2::jsonb WHERE id = $1 AND test_type = 'demo'`,
    [experimentId, JSON.stringify(plan)]
  );
  return plan;
}

// Called after a test-traffic event is stored. Quiet when the sample is not
// in yet, and when a conclusion is already stored.
async function captureDemoSample(experimentId) {
  const { rows } = await db.query(
    `SELECT id, account_id, name, status, url_match, url_match_type, allowed_hosts,
            goals, goals_scope, plan, started_at, peeked_at, hypothesis, client_id,
            site_id, test_type
     FROM experiments WHERE id = $1`,
    [experimentId]
  );
  const experiment = rows[0];
  if (!isDemo(experiment)) return 'ignored';
  if (!experiment.plan || !experiment.plan.visitors_per_variant) return 'unplanned';
  if (await alreadyConcluded(experimentId)) return 'stored';
  const target = Number(experiment.plan.visitors_per_variant) || DEMO_VISITORS_PER_VARIANT;
  const counts = await variantCounts(experimentId);
  const gating = counts.filter((row) => row.enabled !== false);
  const sampleMet = target > 0 && gating.length > 0 && gating.every((row) => Number(row.visitors) >= target);
  if (!sampleMet) return 'waiting';
  const now = new Date();
  await snapshotExperiment(experiment, now, londonDateISO(now), { allowReplace: true });
  return 'written';
}

module.exports = {
  captureDemoSample,
  refreshDemoPlan,
  variantCounts,
};
