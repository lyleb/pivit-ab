// Daily status snapshot. This is the only place that estimates futility or
// reads live counts for the client portal. Page loads read the stored row.
//
// A second run on the same London date does nothing (the primary key is
// experiment_id + snapshot_date). One experiment failing does not stop the rest.

const db = require('./db');
const { getPrimaryVariantData } = require('./metrics');
const { visitorRows, srmFor, primaryGoalId } = require('./experiment-plan');
const { planProgress, daysElapsed } = require('./reading');
const { buildVerdict } = require('./verdict');
const { assessFutility } = require('./futility');
const {
  londonParts,
  londonDateISO,
  previousLondonDate,
  formatLondonStamp,
} = require('./clock');
const {
  clientHeadlineCode,
  buildClientHealth,
  statusNote,
  readyLabel,
  ownerNote,
  findForbiddenKey,
} = require('./headlines');
const { goalName, concludedPayload, blindPublic } = require('./portal-view');

async function busiestUntestedPage(accountId, experimentId) {
  const { rows } = await db.query(
    `SELECT e.url_match,
        COUNT(DISTINCT ev.visitor_id)::int AS visitors
     FROM experiments e
     JOIN events ev ON ev.experiment_id = e.id
     WHERE e.account_id = $1
       AND e.id <> $2
       AND ev.event_type = 'view'
       AND ev.excluded_at IS NULL
       AND ev.is_test = false
       AND ev.created_at >= now() - interval '28 days'
       AND NOT EXISTS (
         SELECT 1 FROM experiments running
         WHERE running.account_id = e.account_id
           AND running.url_match = e.url_match
           AND running.status IN ('running', 'paused')
       )
     GROUP BY e.url_match
     ORDER BY visitors DESC
     LIMIT 1`,
    [accountId, experimentId]
  );
  if (!rows[0] || !rows[0].url_match) return null;
  const visitors = Number(rows[0].visitors) || 0;
  if (visitors <= 0) return null;
  return {
    label: rows[0].url_match,
    weekly: Math.max(1, Math.round(visitors / 28 * 7)),
  };
}

async function rateAndSnippet(experimentId, now, startedAt) {
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const elapsed = startedAt
    ? Math.max(0, (now.getTime() - new Date(startedAt).getTime()) / (24 * 60 * 60 * 1000))
    : 14;
  const windowDays = Math.min(14, Math.max(1, elapsed));
  const [rate, seen] = await Promise.all([
    db.query(
      `SELECT COUNT(DISTINCT visitor_id)::int AS visitors
       FROM events
       WHERE experiment_id = $1
         AND event_type = 'view'
         AND excluded_at IS NULL
         AND is_test = false
         AND created_at >= $2`,
      [experimentId, since]
    ),
    db.query(
      `SELECT MAX(created_at) AS last_view
       FROM events
       WHERE experiment_id = $1
         AND event_type = 'view'
         AND excluded_at IS NULL
         AND is_test = false`,
      [experimentId]
    ),
  ]);
  const visitors = Number(rate.rows[0] && rate.rows[0].visitors) || 0;
  const lastView = seen.rows[0] && seen.rows[0].last_view ? new Date(seen.rows[0].last_view) : null;
  const silentDays = lastView ? (now.getTime() - lastView.getTime()) / (24 * 60 * 60 * 1000) : Infinity;
  return {
    dailyRate: visitors / windowDays,
    // "Today" is the last 24 hours. The job runs at 06:00, when the London
    // calendar day has barely started, so a midnight cutoff would call a
    // healthy shop a tracking failure every morning.
    snippetSeenToday: silentDays <= 1,
    snippetSilent: silentDays >= 3,
  };
}

async function snapshotExperiment(experiment, now, date, options) {
  if (!options.force) {
    const existing = await db.query(
      `SELECT 1 FROM status_snapshots WHERE experiment_id = $1 AND snapshot_date = $2::date`,
      [experiment.id, date]
    );
    if (existing.rows.length) return 'skipped';
  }

  const plan = experiment.plan || {};
  const [{ variantData }, splits, traffic] = await Promise.all([
    getPrimaryVariantData(experiment.id),
    visitorRows(experiment.id, false),
    rateAndSnippet(experiment.id, now, experiment.started_at),
  ]);
  const counts = new Map(variantData.map((row) => [row.variant_id, row]));
  const variants = splits.map((row) => {
    const counted = counts.get(row.variant_id) || {};
    return {
      variant_id: row.variant_id,
      variant_name: row.variant_name,
      name: row.name,
      traffic_split: row.traffic_split,
      enabled: row.enabled !== false,
      visitors: counted.visitors != null ? Number(counted.visitors) : row.visitors,
      conversions: Number(counted.conversions) || 0,
    };
  });
  const progress = planProgress({
    plan,
    startedAt: experiment.started_at,
    now,
    variants,
  });
  const srm = srmFor(variants);
  const conversions = variants.reduce((sum, row) => sum + (Number(row.conversions) || 0), 0);
  const visitors = variants.reduce((sum, row) => sum + (Number(row.visitors) || 0), 0);
  const goals = Array.isArray(experiment.goals) ? experiment.goals : [];
  const goalCount = experiment.goals_scope === 'divergent' ? 0 : goals.filter((goal) => goal && (goal.id || goal.name)).length;
  const elapsed = daysElapsed(experiment.started_at, now);
  const health = buildClientHealth({
    variants: variants.filter((row) => row.enabled),
    srmDetected: !!(srm && srm.srm_detected),
    totalVisitors: visitors,
    snippetSeenToday: traffic.snippetSeenToday,
    snippetSilent: traffic.snippetSilent && elapsed >= 3,
    conversions,
    goalCount,
    daysElapsed: elapsed,
  });

  const assessment = assessFutility({
    variants: variants.filter((row) => row.enabled),
    visitorsPerVariant: Number(plan.visitors_per_variant) || 0,
    dailyRate: traffic.dailyRate,
    startedAt: experiment.started_at || now,
    estimatedDays: Number(plan.estimated_days) || 0,
    now,
    plan,
    skipSimulation: !!progress.plan_met,
    runs: options.runs,
    innerDraws: options.innerDraws,
    seed: `${experiment.id}:${date}`,
  });

  const prevDate = previousLondonDate(now);
  const previous = await db.query(
    `SELECT futility_band, detail
     FROM status_snapshots
     WHERE experiment_id = $1 AND snapshot_date = $2::date`,
    [experiment.id, prevDate]
  );
  const previousFutilityBand = previous.rows[0] ? previous.rows[0].futility_band : null;
  const headlineCode = clientHeadlineCode({
    planMet: progress.plan_met,
    healthProblem: health.blocking,
    trafficLow: assessment.trafficLow,
    futilityBand: assessment.band,
    previousFutilityBand,
  });
  assessment.readyLabel = readyLabel(assessment.projectedEnd, now, { unlikely: headlineCode === 'unlikely' });

  const note = statusNote({
    blocking: health.blocking,
    trafficLow: assessment.trafficLow,
    futilityBand: assessment.band,
  });
  const detailPublic = blindPublic({
    assessment,
    headlineCode,
    health: health.checks,
    daysElapsed: elapsed,
    minRuntimeDays: progress.min_runtime_days,
    statusNoteText: note,
  });

  if (progress.plan_met) {
    const verdict = buildVerdict({
      variants: variantData,
      plan,
      srmDetected: !!(srm && srm.srm_detected),
    });
    let pageSuggestion = null;
    try {
      pageSuggestion = await busiestUntestedPage(experiment.account_id, experiment.id);
    } catch (err) {
      console.error('Busiest-page lookup failed:', err.message);
    }
    const previousConcluded = previous.rows[0]
      && previous.rows[0].detail
      && previous.rows[0].detail.public
      && previous.rows[0].detail.public.concluded;
    const finishedOn = (previousConcluded && previousConcluded.finished_on) || date;
    detailPublic.concluded = concludedPayload({
      verdict,
      goalLabel: goalName(experiment),
      rows: variantData,
      visitors,
      days: elapsed,
      finishedOn,
      pageSuggestion,
    });
    detailPublic.headline_code = 'ready';
    detailPublic.headline = 'Result ready';
    detailPublic.icon = 'tick';
    detailPublic.recommendation = 'The planned sample and the minimum runtime are both in. This is the result.';
  } else {
    const leaked = findForbiddenKey(detailPublic, false);
    if (leaked) throw new Error(`refusing to store a blind snapshot that contains ${leaked}`);
  }

  const detailPrivate = {
    p_decisive: assessment.pDecisive,
    futility_band: assessment.band,
    traffic_only: assessment.trafficOnly,
    shortfall: assessment.shortfall,
    past_cap: assessment.pastCap,
    raw_headline: headlineCode,
    owner_note: ownerNote({
      futilityBand: assessment.band,
      trafficOnly: assessment.trafficOnly,
      clientHeadline: headlineCode,
    }),
    primary_goal_id: primaryGoalId(experiment.goals),
  };

  const projected = assessment.projectedEnd ? londonDateISO(assessment.projectedEnd) : null;
  const written = await db.query(
    `INSERT INTO status_snapshots
       (experiment_id, account_id, snapshot_date, headline_code, progress_pct_band, projected_end, futility_band, detail)
     VALUES ($1, $2, $3::date, $4, $5, $6::date, $7, $8::jsonb)
     ON CONFLICT (experiment_id, snapshot_date) DO NOTHING`,
    [
      experiment.id,
      experiment.account_id,
      date,
      detailPublic.headline_code,
      assessment.progressPctBand,
      projected,
      assessment.band,
      JSON.stringify({ public: detailPublic, private: detailPrivate }),
    ]
  );
  return written.rowCount ? 'written' : 'skipped';
}

async function runDailySnapshots(now = new Date(), options = {}) {
  const when = now instanceof Date ? now : new Date(now);
  const parts = londonParts(when);
  if (parts.hour < 6 && !options.force) {
    return { date: londonDateISO(when), skippedClock: true, written: 0, skipped: 0, failed: 0 };
  }
  const date = londonDateISO(when);
  const { rows } = await db.query(
    `SELECT id, account_id, name, status, url_match, url_match_type, allowed_hosts,
            goals, goals_scope, plan, started_at, peeked_at, hypothesis, client_id, site_id
     FROM experiments
     WHERE status IN ('running', 'paused', 'archived')
       AND plan IS NOT NULL
       AND (plan->>'visitors_per_variant') IS NOT NULL`
  );
  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const experiment of rows) {
    try {
      const outcome = await snapshotExperiment(experiment, when, date, options);
      if (outcome === 'written') written += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error('Status snapshot failed', experiment.id, err.message);
    }
  }
  console.log(
    `Status snapshots for ${date} (${formatLondonStamp(when)}): ${written} written, ${skipped} already stored, ${failed} failed.`
  );
  return { date, skippedClock: false, written, skipped, failed };
}

module.exports = {
  runDailySnapshots,
  snapshotExperiment,
  busiestUntestedPage,
};
