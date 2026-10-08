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
const router = express.Router();

// url_match stays in SQL. Domain rules depend on HOST_SCOPING and on whether
// the experiment has a list yet, so they are applied in JS. allowed_hosts is
// never copied onto the public payload.
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
    const { rows: experiments } = await db.query(
      `SELECT id, name, url_match, allowed_hosts, goals FROM experiments
       WHERE $1 ILIKE '%' || url_match || '%' AND status = 'running'`,
      [url]
    );

    const visible = applyHostScope(experiments, req);

    let previewExperiment = null;
    if (previewAuth.ok) {
      const { rows: previewRows } = await db.query(
        `SELECT e.id, e.name, e.url_match, e.allowed_hosts, e.status, e.goals
         FROM variants v
         JOIN experiments e ON e.id = v.experiment_id
         WHERE v.id = $1
           AND $2 ILIKE '%' || e.url_match || '%'`,
        [previewAuth.variantId, url]
      );
      if (previewRows[0]) {
        const already = visible.find((exp) => exp.id === previewRows[0].id);
        previewExperiment = already || applyHostScope(previewRows, req)[0] || null;
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
    const { rows: experiments } = await db.query(
      `SELECT id, name, allowed_hosts, goals FROM experiments WHERE id = ANY($1::uuid[])`,
      [idList]
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
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    const loaded = await loadReading(req.params.id, { includeTest: false });
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
router.get('/host-report', (req, res) => {
  res.json(seenReport());
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
       LEFT JOIN clients c ON c.id = e.client_id
       GROUP BY e.id, c.name
       ORDER BY e.created_at DESC`
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
    const { rows: expRows } = await db.query(`SELECT * FROM experiments WHERE id = $1`, [id]);
    if (expRows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });

    const { rows: variants } = await db.query(
      `SELECT * FROM variants WHERE experiment_id = $1 ORDER BY created_at`,
      [id]
    );
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
    const { rows: expRows } = await db.query(
      `SELECT status, goals, goals_scope FROM experiments WHERE id = $1`,
      [id]
    );
    if (expRows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
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

  let hosts = [];
  if (allowed_hosts !== undefined) {
    const parsed = parseHostList(allowed_hosts);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    hosts = parsed.hosts;
  }

  let client;
  try {
    client = await db.pool.connect(); // inside the try too — a connection failure must produce a clean error, not an unhandled rejection
    await client.query('BEGIN');

    const { rows: expRows } = await client.query(
      `INSERT INTO experiments (name, url_match, client_id, allowed_hosts, goals, goals_scope, goals_migrated)
       VALUES ($1, $2, $3, $4::text[], '[]'::jsonb, 'shared', true) RETURNING *`,
      [name, url_match, client_id || null, hosts]
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
    const { rows } = await db.query(
      `UPDATE experiments SET client_id = $1 WHERE id = $2 RETURNING *`,
      [client_id || null, id]
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
      `SELECT goals, goals_scope FROM experiments WHERE id = $1 FOR UPDATE`,
      [id]
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
    if (scope === 'divergent') await recordGoalUsage(goalList);
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
      const { rows: expRows } = await client.query(`SELECT goals, goals_scope FROM experiments WHERE id = $1`, [id]);
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
        await recordGoalUsage(saved.goals);
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
    });
    await client.query('COMMIT');
    await recordGoalUsage(saved.goals);
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
      `SELECT id FROM variants WHERE id = $1 AND experiment_id = $2`,
      [req.params.variantId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id on that experiment' });

    const token = createPreviewToken(req.params.variantId);
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
// already used for Preview), since url_match is only ever a substring.
router.post('/:id/variants/:variantId/edit-link', async (req, res) => {
  try {
    const { page_url } = req.body;
    if (!page_url) return res.status(400).json({ error: 'page_url is required' });

    const { rows } = await db.query(
      `SELECT id FROM variants WHERE id = $1 AND experiment_id = $2`,
      [req.params.variantId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id on that experiment' });

    const token = createEditToken(req.params.variantId);
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
    const { rows: expRows } = await db.query(`SELECT status FROM experiments WHERE id = $1`, [id]);
    if (expRows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    if (expRows[0].status !== 'archived') {
      return res.status(400).json({ error: 'only archived experiments can be deleted — archive it first, and export the CSV if you want to keep the data' });
    }
    await db.query(`DELETE FROM experiments WHERE id = $1`, [id]);
    res.status(204).end();
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

    const { rows } = await db.query(
      `UPDATE experiments SET allowed_hosts = $1::text[] WHERE id = $2 RETURNING *`,
      [parsed.hosts, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!id) return res.status(400).json({ error: 'experiment id is required in the URL' });
    const allowed = ['draft', 'running', 'paused', 'archived'];
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });

    const { rows: existingRows } = await db.query(`SELECT * FROM experiments WHERE id = $1`, [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    const existing = existingRows[0];
    if (status === 'running') {
      const hosts = existing.allowed_hosts || [];
      if (hosts.length === 0) {
        return res.status(400).json({ error: 'Add at least one site domain in Settings before starting this experiment.' });
      }
      if (existing.status === 'draft') await ensurePlanOnStart(existing);
    }

    const { rows } = await db.query(
      status === 'running'
        ? `UPDATE experiments SET status = $1, started_at = COALESCE(started_at, now()) WHERE id = $2 RETURNING *`
        : `UPDATE experiments SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
