const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { recordGoalUsage } = require('./goals');
const {
  variantAdditionAllowed,
  variantCapError,
  validateGoals,
  persistGoals,
} = require('../goals');
const { detectSRM } = require('../srm');
const { buildHealth } = require('../health');
const { flagIsOn, summariseTestTraffic } = require('../test-traffic');
const { ensurePlanOnStart, recordReveal, loadReading, readingPayload, srmFor } = require('../experiment-plan');
const { planProgress, describeReading, listSignal } = require('../reading');
const { visibleEventSql } = require('../metrics');
const { utcDay, windowStartDay } = require('../host-hits');
const { createEditToken } = require('../edit-token');
const { authorisePreview, buildPublicExperimentList, createPreviewToken, previewUrl, editUrl, cacheControlForExperimentsQuery } = require('../preview-access');
const {
  checkHost,
  pageHostFromRequest,
  recordSeen,
  seenReport,
  parseHostList,
  hostScopingMode,
} = require('../host-scope');
const { publicScope, ownedExperiment, placeOnSite } = require('../tenant');
const { matchPageUrl, resolvePageMatch } = require('../../public/url-match');
const { noteSnippetSeen } = require('../site-verify');
const { normaliseStatusChange } = require('../experiment-status');
const router = express.Router();

function publicScopeSql(accountParam, siteParam) {
  return `($${siteParam}::uuid IS NULL AND account_id = $${accountParam}) OR ($${siteParam}::uuid IS NOT NULL AND site_id = $${siteParam})`;
}

// A stored "contains" match stays the historical SQL ILIKE, including its
// case folding. Exact, starts-with and regex are filtered in JS so a homepage
// stored as exact does not run on /shop. Existing rows default to contains,
// so a test saved before this column keeps its old pages. Domain rules depend
// on HOST_SCOPING and are applied after the URL check. allowed_hosts is never
// copied onto the public payload.
function sqlPageMatch(urlParam, prefix) {
  const col = prefix ? `${prefix}.` : '';
  return `(
    (COALESCE(${col}url_match_type, 'contains') NOT IN ('exact', 'starts_with', 'regex')
      AND $${urlParam} ILIKE '%' || ${col}url_match || '%')
    OR ${col}url_match_type IN ('exact', 'starts_with', 'regex')
  )`;
}

function keepPageMatches(rows, url) {
  return rows.filter((row) => {
    const type = row.url_match_type;
    if (type !== 'exact' && type !== 'starts_with' && type !== 'regex') return true;
    return matchPageUrl(row.url_match, url, type);
  });
}
const unscopedLogged = new Set();

function applyHostScope(rows, req) {
  const pageHost = pageHostFromRequest(req);
  const mode = hostScopingMode();
  const kept = [];
  for (const exp of rows) {
    if (pageHost) recordSeen(exp.id, pageHost);
    const decision = checkHost(exp.allowed_hosts, pageHost, mode);
    if (decision.reason === 'unscoped-transition') {
      const key = `${exp.id}|${pageHost || ''}`;
      if (!unscopedLogged.has(key)) {
        unscopedLogged.add(key);
        console.warn(`[host-scope] serving ${exp.id} with no site domain (HOST_SCOPING=transition)${pageHost ? ` host=${pageHost}` : ''}`);
      }
    }
    if (decision.serve) kept.push(exp);
  }
  return kept;
}

// GET /api/experiments?url=https://client-site.com/pricing
// PUBLIC — called by the snippet from any visitor's browser. No auth.
// Returns only running experiments, and only their enabled variants.
// Draft and paused experiments are added only when preview=1 is accompanied
// by a signed preview_token for preview_variant. Host scoping still applies.
// A bare preview=1 (no token) is ignored, so it cannot leak drafts.
router.get('/', async (req, res) => {
  const { url } = req.query;
  // Preview JSON is per variant and must not be stored. A normal snippet fetch
  // (no preview=1) keeps the previous cache behaviour — no Cache-Control here.
  const cacheControl = cacheControlForExperimentsQuery(req.query);
  if (cacheControl) res.set('Cache-Control', cacheControl);
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  const previewAuth = authorisePreview({
    preview: req.query.preview,
    previewVariant: req.query.preview_variant,
    previewToken: req.query.preview_token,
  });

  try {
    const scope = await publicScope(req.query.site);
    if (!scope.ok) return res.json({ experiments: [] });
    await noteSnippetSeen(scope, req);

    const { rows: experiments } = await db.query(
      `SELECT id, name, url_match, url_match_type, allowed_hosts, goals FROM experiments
       WHERE ${sqlPageMatch(1)} AND status = 'running'
         AND (${publicScopeSql(2, 3)})`,
      [url, scope.accountId, scope.siteId]
    );

    const visible = applyHostScope(keepPageMatches(experiments, url), req);

    let previewExperiment = null;
    if (previewAuth.ok) {
      const { rows: previewRows } = await db.query(
        `SELECT e.id, e.name, e.url_match, e.url_match_type, e.allowed_hosts, e.status, e.goals, e.account_id, e.site_id
         FROM variants v
         JOIN experiments e ON e.id = v.experiment_id
         WHERE v.id = $1
           AND ${sqlPageMatch(2, 'e')}
           AND (( $4::uuid IS NULL AND e.account_id = $3) OR ($4::uuid IS NOT NULL AND e.site_id = $4))`,
        [previewAuth.variantId, url, scope.accountId, scope.siteId]
      );
      if (previewAuth.accountId) {
        for (let i = previewRows.length - 1; i >= 0; i -= 1) {
          if (previewRows[i].account_id !== previewAuth.accountId) previewRows.splice(i, 1);
        }
      }
      const matchedPreview = keepPageMatches(previewRows, url);
      if (matchedPreview[0]) {
        const already = visible.find((exp) => exp.id === matchedPreview[0].id);
        previewExperiment = already || applyHostScope(matchedPreview, req)[0] || null;
      }
    }

    const experimentIds = visible.map((exp) => exp.id);
    if (previewExperiment && !experimentIds.includes(previewExperiment.id)) {
      experimentIds.push(previewExperiment.id);
    }
    if (experimentIds.length === 0) return res.json({ experiments: [] });

    const { rows: variants } = await db.query(
      `SELECT id, experiment_id, name, traffic_split, changes, goals, enabled
       FROM variants WHERE experiment_id = ANY($1::uuid[])`,
      [experimentIds]
    );

    const payload = buildPublicExperimentList({
      running: visible,
      variants,
      previewExperiment,
      previewVariantId: previewAuth.ok ? previewAuth.variantId : null,
    });

    if (payload.preview) return res.json({ experiments: payload.experiments, preview: payload.preview });
    res.json({ experiments: payload.experiments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/experiments/by-ids?ids=id1,id2
// PUBLIC — used by the snippet to check "visited a URL" goals on pages other than
// the one an experiment's changes run on (e.g. a /thank-you page after a /pricing
// test). Looks up by exact id for whatever this visitor was already assigned to,
// regardless of the experiment's current status, so a goal still counts even if
// you've since paused/archived the test.
router.get('/by-ids', async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.json({ experiments: [] });
  const idList = ids.split(',').map((s) => s.trim()).filter(Boolean);
  if (idList.length === 0) return res.json({ experiments: [] });

  try {
    const scope = await publicScope(req.query.site);
    if (!scope.ok) return res.json({ experiments: [] });
    const { rows: experiments } = await db.query(
      `SELECT id, name, allowed_hosts, goals FROM experiments
       WHERE id = ANY($1::uuid[])
         AND (${publicScopeSql(2, 3)})`,
      [idList, scope.accountId, scope.siteId]
    );
    const visible = applyHostScope(experiments, req);
    if (visible.length === 0) return res.json({ experiments: [] });

    const visibleIds = visible.map((e) => e.id);
    const { rows: variants } = await db.query(
      `SELECT id, experiment_id, name, goals FROM variants WHERE experiment_id = ANY($1::uuid[])`,
      [visibleIds]
    );

    const result = visible.map((exp) => ({
      id: exp.id,
      name: exp.name,
      goals: Array.isArray(exp.goals) ? exp.goals : [],
      variants: variants.filter((v) => v.experiment_id === exp.id),
    }));

    res.json({ experiments: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// Everything below is admin-only, requires x-api-key.
router.use(requireAuth(['owner']));

// Owner-only. Not mounted on the client portal.
router.use('/:id/test-traffic', require('./test-traffic'));
router.use('/:id/plan', require('./plan'));

function actorIp(req) {
  const ip = req && req.ip ? String(req.ip) : '';
  return ip ? ip.slice(0, 64) : null;
}

// POST /api/experiments/:id/reveal
// Owner only. Logs the look and marks the result as peeked. Does not change events.
router.post('/:id/reveal', async (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'Confirm the early look before it is shown.' });
  }
  try {
    const result = await recordReveal({
      experimentId: req.params.id,
      actor: 'owner',
      actorIp: actorIp(req),
      accountId: req.account.id,
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    const loaded = await loadReading(req.params.id, { includeTest: false, accountId: req.account.id });
    res.json({
      peeked_at: result.peeked_at,
      audit_id: result.audit_id,
      created_at: result.created_at,
      reading: readingPayload(loaded),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// Hosts the snippet has asked about since this process started. In-memory, so
// it resets on deploy — that is what Settings calls "since last deploy".
// Registered before /:id so "host-report" is not captured as an id.
router.get('/host-report', async (req, res) => {
  try {
    const report = seenReport();
    const { rows } = await db.query(
      `SELECT id FROM experiments WHERE account_id = $1`,
      [req.account.id]
    );
    const allowed = new Set(rows.map((row) => row.id));
    const experiments = {};
    Object.keys(report.experiments).forEach((id) => {
      if (allowed.has(id)) experiments[id] = report.experiments[id];
    });
    res.json({ since: report.since, experiments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/experiments/all — every experiment regardless of status, with a variant
// count, for the dashboard's "Your Experiments" list. Must be registered before
// GET /:id below, or Express will try to match "all" as an :id value.
router.get('/all', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT e.*, COUNT(v.id)::int AS variant_count, c.name AS client_name
       FROM experiments e
       LEFT JOIN variants v ON v.experiment_id = e.id
       LEFT JOIN clients c ON c.id = e.client_id AND c.account_id = e.account_id
       WHERE e.account_id = $1
       GROUP BY e.id, c.name
       ORDER BY e.created_at DESC`,
      [req.account.id]
    );
    const ids = rows.map((row) => row.id);
    let variantRows = [];
    if (ids.length) {
      const counted = await db.query(
        `SELECT v.experiment_id, v.id, v.name, v.traffic_split, v.enabled,
           COUNT(DISTINCT e.visitor_id) FILTER (
             WHERE e.event_type = 'view' AND e.excluded_at IS NULL AND e.is_test = false
           )::int AS visitors
         FROM variants v
         LEFT JOIN events e ON e.variant_id = v.id
         WHERE v.experiment_id = ANY($1::uuid[])
         GROUP BY v.experiment_id, v.id`,
        [ids]
      );
      variantRows = counted.rows;
    }
    const byExperiment = new Map();
    variantRows.forEach((row) => {
      if (!byExperiment.has(row.experiment_id)) byExperiment.set(row.experiment_id, []);
      byExperiment.get(row.experiment_id).push({
        id: row.id,
        variant_id: row.id,
        name: row.name,
        variant_name: row.name,
        traffic_split: row.traffic_split,
        enabled: row.enabled !== false,
        visitors: Number(row.visitors) || 0,
      });
    });
    const experiments = rows.map((row) => {
      const variants = byExperiment.get(row.id) || [];
      const progress = planProgress({
        plan: row.plan,
        startedAt: row.started_at,
        variants,
      });
      const srm = srmFor(variants);
      const described = describeReading({
        status: row.status,
        plan: row.plan,
        peekedAt: row.peeked_at,
        progress,
        srmDetected: !!(srm && srm.srm_detected),
      });
      const reading = {
        mode: described.mode,
        outcome_visible: described.outcome_visible,
        peeked: described.peeked,
        has_plan: described.has_plan,
        plan_met: described.plan_met,
        days_elapsed: progress.days_elapsed,
        min_runtime_days: progress.min_runtime_days,
        total_visitors: progress.variants.reduce((sum, item) => sum + item.visitors, 0),
      };
      return Object.assign({}, row, {
        reading,
        signal: listSignal(row.status, reading),
      });
    });
    res.set('Cache-Control', 'no-store');
    res.json({ experiments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/experiments/:id — full experiment + ALL its variants (including paused
// ones and their enabled state), for the dashboard's manage/preview view.
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const experiment = await ownedExperiment(req.account.id, id);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });
    const expRows = [experiment];

    const { rows: variants } = await db.query(
      `SELECT * FROM variants WHERE experiment_id = $1 ORDER BY created_at`,
      [id]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ ...expRows[0], variants });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/experiments/:id/health
// Owner-only. Shown on the experiment page while the test is running.
// The test-traffic card counts flagged visitors and says whether they are
// excluded. It does not delete them. include_test=1 matches the results toggle.
router.get('/:id/health', async (req, res) => {
  try {
    const { id } = req.params;
    const includeTest = flagIsOn(req.query.include_test);
    const owned = await ownedExperiment(req.account.id, id);
    if (!owned) return res.status(404).json({ error: 'no experiment found with that id' });
    const expRows = [owned];
    const exp = expRows[0];

    const { rows: splitRows } = await db.query(
      `SELECT v.name AS variant_name, v.traffic_split,
         COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view') AS visitors
       FROM variants v
       LEFT JOIN events e ON e.variant_id = v.id AND ${visibleEventSql('e', 2)}
       WHERE v.experiment_id = $1 AND v.enabled = true
       GROUP BY v.id, v.name, v.traffic_split
       ORDER BY v.name`,
      [id, includeTest]
    );
    const split = splitRows.map((row) => ({
      name: row.variant_name,
      visitors: Number(row.visitors) || 0,
      traffic_split: row.traffic_split,
    }));
    const srm = detectSRM(split);
    const totalVisitors = split.reduce((sum, row) => sum + row.visitors, 0);

    const { start } = windowStartDay(7);
    const { rows: dropRows } = await db.query(
      `SELECT day::text AS day, reason, drop_count
       FROM event_drops
       WHERE experiment_id = $1 AND day >= $2::date`,
      [id, start]
    );
    const testTraffic = await summariseTestTraffic(id);

    const goalCount = exp.goals_scope === 'divergent'
      ? null
      : (Array.isArray(exp.goals) ? exp.goals.length : 0);
    let scope = exp.goals_scope || 'shared';
    let count = goalCount;
    if (scope === 'divergent') {
      count = 0;
    }

    res.json(buildHealth({
      status: exp.status,
      srm,
      totalVisitors,
      scope,
      goalCount: count,
      drops: dropRows,
      today: utcDay(),
      syntheticVisitors: testTraffic.visitors,
      testExcluded: !includeTest,
      removedVisitors: testTraffic.removed_visitors,
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// Creating an experiment also creates a "Control" variant automatically — no
// changes, 50% traffic — so every new experiment starts with an unmodified
// baseline to compare against. You only ever need to add the variant(s) you're
// actually testing; Control already exists, and can be edited/paused/deleted
// afterward like any other variant if a given test genuinely doesn't need one
// (e.g. a 100%-rollout). Both inserts happen in one transaction, so a failure
// partway through never leaves an experiment with no Control at all.
router.post('/', async (req, res) => {
  const { name, url_match, client_id, allowed_hosts } = req.body;
  if (!name || !url_match) return res.status(400).json({ error: 'name and url_match are required' });
  const pageMatch = resolvePageMatch(url_match, req.body.url_match_type);
  if (!pageMatch.ok) return res.status(400).json({ error: pageMatch.error });

  let hosts = [];
  if (allowed_hosts !== undefined) {
    const parsed = parseHostList(allowed_hosts);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    hosts = parsed.hosts;
  }

  const accountId = req.account.id;
  if (client_id) {
    const ownedClient = await db.query(
      `SELECT id FROM clients WHERE id = $1 AND account_id = $2`,
      [client_id, accountId]
    );
    if (ownedClient.rows.length === 0) return res.status(404).json({ error: 'no client found with that id' });
  }

  let client;
  try {
    client = await db.pool.connect(); // inside the try too — a connection failure must produce a clean error, not an unhandled rejection
    await client.query('BEGIN');
    const placed = await placeOnSite(client.query.bind(client), accountId, null, hosts);

    const { rows: expRows } = await client.query(
      `INSERT INTO experiments (name, url_match, url_match_type, client_id, allowed_hosts, goals, goals_scope, goals_migrated, account_id, site_id, needs_site)
       VALUES ($1, $2, $3, $4, $5::text[], '[]'::jsonb, 'shared', true, $6, $7, $8) RETURNING *`,
      [name, url_match, pageMatch.type, client_id || null, hosts, accountId, placed.siteId, placed.needsSite]
    );
    const experiment = expRows[0];

    const { rows: variantRows } = await client.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes, goals)
       VALUES ($1, 'Control', 50, '[]', '[]') RETURNING *`,
      [experiment.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ ...experiment, control_variant: variantRows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch((rollbackErr) => console.error('Rollback failed:', rollbackErr));
    console.error(err);
    if (err.code === '23503') return res.status(400).json({ error: 'no client found with that id' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  } finally {
    if (client) client.release();
  }
});

// PATCH /api/experiments/:id/client  { client_id: <uuid> | null }
// Reassigns (or un-assigns, with null) which client can see this experiment.
router.patch('/:id/client', async (req, res) => {
  try {
    const { id } = req.params;
    const { client_id } = req.body;
    if (client_id) {
      const ownedClient = await db.query(
        `SELECT id FROM clients WHERE id = $1 AND account_id = $2`,
        [client_id, req.account.id]
      );
      if (ownedClient.rows.length === 0) return res.status(404).json({ error: 'no client found with that id' });
    }
    const { rows } = await db.query(
      `UPDATE experiments SET client_id = $1 WHERE id = $2 AND account_id = $3 RETURNING *`,
      [client_id || null, id, req.account.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23503') return res.status(400).json({ error: 'no client found with that id' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

router.post('/:id/variants', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const { name, traffic_split, changes, goals } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!id) return res.status(400).json({ error: 'experiment id is required in the URL' });

    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT goals, goals_scope, account_id FROM experiments WHERE id = $1 AND account_id = $2 FOR UPDATE`,
      [id, req.account.id]
    );
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no experiment found with that id' });
    }
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM variants WHERE experiment_id = $1`,
      [id]
    );
    if (!variantAdditionAllowed(countRows[0].n)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: variantCapError() });
    }

    // A shared test copies the experiment goals onto the new variant. A
    // divergent test keeps whatever list was sent (the editor still works).
    const scope = locked.rows[0].goals_scope || 'shared';
    let goalList = scope === 'divergent' ? (goals ?? []) : (locked.rows[0].goals || []);
    if (scope === 'divergent' && goalList.length) {
      const problem = validateGoals(goalList);
      if (problem) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: problem });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes, goals)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, name, traffic_split ?? 50, JSON.stringify(changes ?? []), JSON.stringify(goalList)]
    );
    await client.query('COMMIT');
    if (scope === 'divergent') await recordGoalUsage(goalList, req.account.id);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('Rollback failed:', rollbackErr));
    console.error(err);
    if (err.code === '23503') return res.status(400).json({ error: 'no experiment found with that id' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/experiments/:id/variants/:variantId
// Full edit of an existing variant's name, traffic split, changes, and goals.
// Editing a variant that's currently live changes what visitors see immediately —
// there's no staging/draft step, so treat this like editing the client's page directly.
router.patch('/:id/variants/:variantId', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id, variantId } = req.params;
    const { name, traffic_split, changes, goals } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // `changes` is only written when the request actually includes it. The
    // dashboard form edits name/split — what a variant *does* is authored in
    // the visual editor — so a save from the form must leave changes untouched.
    // Goals are the same: omitted means "leave them", so a rename cannot wipe
    // the list. An empty list is also ignored when the experiment already has
    // shared goals, so a stale tab cannot clear them by accident.
    const changesParam = changes === undefined ? null : JSON.stringify(Array.isArray(changes) ? changes : []);

    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT id FROM experiments WHERE id = $1 AND account_id = $2`,
      [id, req.account.id]
    );
    if (owned.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no experiment found with that id' });
    }
    const { rows } = await client.query(
      `UPDATE variants SET name = $1, traffic_split = $2, changes = COALESCE($3::jsonb, changes)
       WHERE id = $4 AND experiment_id = $5 RETURNING *`,
      [name, traffic_split ?? 50, changesParam, variantId, id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no variant found with that id on that experiment' });
    }

    if (goals !== undefined) {
      const problem = validateGoals(goals);
      if (problem) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: problem });
      }
      const { rows: expRows } = await client.query(
        `SELECT goals, goals_scope FROM experiments WHERE id = $1 AND account_id = $2`,
        [id, req.account.id]
      );
      const shared = expRows[0] && expRows[0].goals_scope !== 'divergent';
      const wipingShared = shared && goals.length === 0 && (expRows[0].goals || []).length > 0;
      if (!wipingShared) {
        const saved = await persistGoals(client.query.bind(client), {
          experimentId: id,
          variantId,
          goals,
          unify: false,
        });
        rows[0].goals = saved.goals;
        await recordGoalUsage(saved.goals, req.account.id);
      }
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('Rollback failed:', rollbackErr));
    console.error(err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'internal error', detail: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/experiments/:id/goals  { goals: [...], unify?: true }
// One list for every variant. unify is required when the variants were saved
// with different goals, so a normal save cannot flatten that history.
router.put('/:id/goals', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const goals = req.body && req.body.goals;
    const problem = validateGoals(goals);
    if (problem) return res.status(400).json({ error: problem });

    await client.query('BEGIN');
    const saved = await persistGoals(client.query.bind(client), {
      experimentId: req.params.id,
      goals,
      unify: !!(req.body && req.body.unify),
      accountId: req.account.id,
    });
    await client.query('COMMIT');
    await recordGoalUsage(saved.goals, req.account.id);
    res.json(saved);
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => console.error('Rollback failed:', rollbackErr));
    console.error(err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'internal error', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /api/experiments/:id/variants/:variantId/preview-link  { page_url }
// Owner-only. Mints a signed preview URL the snippet will accept on the
// customer's origin, where the session cookie is not sent.
router.post('/:id/variants/:variantId/preview-link', async (req, res) => {
  try {
    const { page_url } = req.body || {};
    if (!page_url) return res.status(400).json({ error: 'page_url is required' });

    const { rows } = await db.query(
      `SELECT v.id, e.account_id, e.site_id
       FROM variants v
       JOIN experiments e ON e.id = v.experiment_id
       WHERE v.id = $1 AND v.experiment_id = $2 AND e.account_id = $3`,
      [req.params.variantId, req.params.id, req.account.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id on that experiment' });

    const token = createPreviewToken(req.params.variantId, undefined, undefined, {
      accountId: rows[0].account_id,
      siteId: rows[0].site_id,
    });
    res.json({ preview_url: previewUrl(page_url, req.params.variantId, token) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/experiments/:id/variants/:variantId/enabled  { enabled: true|false }
// POST /api/experiments/:id/variants/:variantId/edit-link  { page_url }
// Generates a scoped, time-limited link that opens the visual editor directly
// on the live page — see src/edit-token.js for why this can't just be the
// owner's normal session. page_url is the actual page to open (the same input
// already used for Preview). url_match may be a substring, an exact page, or
// a pattern, so it is not used as the address to open.
router.post('/:id/variants/:variantId/edit-link', async (req, res) => {
  try {
    const { page_url } = req.body;
    if (!page_url) return res.status(400).json({ error: 'page_url is required' });

    const { rows } = await db.query(
      `SELECT v.id, e.account_id, e.site_id
       FROM variants v
       JOIN experiments e ON e.id = v.experiment_id
       WHERE v.id = $1 AND v.experiment_id = $2 AND e.account_id = $3`,
      [req.params.variantId, req.params.id, req.account.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id on that experiment' });

    const token = createEditToken(req.params.variantId, undefined, {
      accountId: rows[0].account_id,
      siteId: rows[0].site_id,
    });
    res.json({ edit_url: editUrl(page_url, req.params.variantId, token) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// "Stop" a variant without losing its history — it's excluded from new visitor
// traffic (and re-included from disk) but past events stay in the results table.
router.patch('/:id/variants/:variantId/enabled', async (req, res) => {
  try {
    const { id, variantId } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });

    const owned = await ownedExperiment(req.account.id, id);
    if (!owned) return res.status(404).json({ error: 'no experiment found with that id' });
    const { rows } = await db.query(
      `UPDATE variants SET enabled = $1 WHERE id = $2 AND experiment_id = $3 RETURNING *`,
      [enabled, variantId, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id on that experiment' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// DELETE /api/experiments/:id/variants/:variantId
// Permanent — also removes that variant's events (ON DELETE CASCADE), so its
// history is gone too. Pausing (above) is the safer option if you just want to
// stop traffic while keeping results to look back on.
router.delete('/:id/variants/:variantId', async (req, res) => {
  try {
    const { id, variantId } = req.params;
    const owned = await ownedExperiment(req.account.id, id);
    if (!owned) return res.status(404).json({ error: 'no experiment found with that id' });
    const { rows } = await db.query(
      `DELETE FROM variants WHERE id = $1 AND experiment_id = $2 RETURNING id`,
      [variantId, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id on that experiment' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// DELETE /api/experiments/:id
// Permanent — cascades to its variants and all their events. Only allowed once the
// experiment is archived, as a guard rail against deleting a live/paused test by
// mistake; export the CSV first if you want to keep the data.
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const expRows = [await ownedExperiment(req.account.id, id)].filter(Boolean);
    if (expRows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    if (expRows[0].status !== 'archived') {
      return res.status(400).json({ error: 'only archived experiments can be deleted — archive it first, and export the CSV if you want to keep the data' });
    }
    await db.query(`DELETE FROM experiments WHERE id = $1 AND account_id = $2`, [id, req.account.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/experiments/:id/url-match  { url_match_type }
// Owner-only. Does not change url_match text, and does not guess a new type
// when the field is omitted, so saving other settings cannot turn a stored
// contains homepage into exact.
router.patch('/:id/url-match', async (req, res) => {
  try {
    const experiment = await ownedExperiment(req.account.id, req.params.id);
    if (!experiment) return res.status(404).json({ error: 'no experiment found with that id' });
    if (!req.body || req.body.url_match_type == null || req.body.url_match_type === '') {
      return res.status(400).json({ error: 'url_match_type is required' });
    }
    const pageMatch = resolvePageMatch(experiment.url_match, req.body.url_match_type);
    if (!pageMatch.ok) return res.status(400).json({ error: pageMatch.error });
    const { rows } = await db.query(
      `UPDATE experiments SET url_match_type = $1
       WHERE id = $2 AND account_id = $3
       RETURNING id, url_match, url_match_type`,
      [pageMatch.type, req.params.id, req.account.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/experiments/:id/hosts  { allowed_hosts: ["example.com"] | "example.com, shop.example.com" }
// Owner-only. An empty list is allowed on a draft; starting still requires one domain.
router.patch('/:id/hosts', async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.body || req.body.allowed_hosts === undefined) {
      return res.status(400).json({ error: 'allowed_hosts is required' });
    }
    const parsed = parseHostList(req.body.allowed_hosts);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const placed = await placeOnSite(client.query.bind(client), req.account.id, id, parsed.hosts);
      const { rows } = await client.query(
        `UPDATE experiments
         SET allowed_hosts = $1::text[], site_id = $2, needs_site = $3
         WHERE id = $4 AND account_id = $5
         RETURNING *`,
        [parsed.hosts, placed.siteId, placed.needsSite, id, req.account.id]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'no experiment found with that id' });
      }
      await client.query('COMMIT');
      return res.json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr) => console.error('Rollback failed:', rollbackErr));
      console.error(err);
      return res.status(500).json({ error: 'internal error', detail: err.message });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'experiment id is required in the URL' });

    const existing = await ownedExperiment(req.account.id, id);
    if (!existing) return res.status(404).json({ error: 'no experiment found with that id' });
    const change = normaliseStatusChange(existing.status, req.body);
    if (!change.ok) return res.status(change.statusCode || 400).json({ error: change.error });
    if (change.unchanged) {
      res.set('Cache-Control', 'no-store');
      return res.json(existing);
    }
    const { status } = change;
    if (status === 'running') {
      const hosts = existing.allowed_hosts || [];
      if (hosts.length === 0) {
        return res.status(400).json({ error: 'Add at least one site domain in Settings before starting this experiment.' });
      }
      if (existing.site_id) {
        const site = await db.query(
          `SELECT verified_at FROM sites WHERE id = $1 AND account_id = $2`,
          [existing.site_id, req.account.id]
        );
        if (site.rows[0] && !site.rows[0].verified_at) {
          return res.status(400).json({
            error: 'Add the snippet to your site before starting a test. We have not seen it load there yet.',
          });
        }
      }
      if (existing.status === 'draft') await ensurePlanOnStart(existing);
    }

    const { rows } = await db.query(
      status === 'running'
        ? `UPDATE experiments SET status = $1, started_at = COALESCE(started_at, now()) WHERE id = $2 AND account_id = $3 RETURNING *`
        : `UPDATE experiments SET status = $1 WHERE id = $2 AND account_id = $3 RETURNING *`,
      [status, id, req.account.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    res.set('Cache-Control', 'no-store');
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
