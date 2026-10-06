const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { recordGoalUsage } = require('./goals');
const { createEditToken } = require('../edit-token');
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

// GET /api/experiments?url=https://client-site.com/pricing[&preview=1]
// PUBLIC — called by the snippet from any visitor's browser. No auth.
// Normally returns only *running* experiments with only their *enabled* variants.
// With preview=1 (set by the snippet when it sees an ?ab_preview= param), status
// and enabled are ignored so you can preview a draft/paused experiment or a paused variant.
router.get('/', async (req, res) => {
  const { url, preview } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const statusClause = preview ? '' : `AND status = 'running'`;
    const { rows: experiments } = await db.query(
      `SELECT id, name, url_match, allowed_hosts FROM experiments
       WHERE $1 ILIKE '%' || url_match || '%' ${statusClause}`,
      [url]
    );

    const visible = applyHostScope(experiments, req);
    if (visible.length === 0) return res.json({ experiments: [] });

    const experimentIds = visible.map((e) => e.id);
    const enabledClause = preview ? '' : 'AND enabled = true';
    const { rows: variants } = await db.query(
      `SELECT id, experiment_id, name, traffic_split, changes, goals
       FROM variants WHERE experiment_id = ANY($1::uuid[]) ${enabledClause}`,
      [experimentIds]
    );

    const result = visible.map((exp) => ({
      id: exp.id,
      name: exp.name,
      url_match: exp.url_match,
      variants: variants.filter((v) => v.experiment_id === exp.id),
    }));

    res.json({ experiments: result });
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
      `SELECT id, name, allowed_hosts FROM experiments WHERE id = ANY($1::uuid[])`,
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
    res.json({ experiments: rows });
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
      `INSERT INTO experiments (name, url_match, client_id, allowed_hosts) VALUES ($1, $2, $3, $4::text[]) RETURNING *`,
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
  try {
    const { id } = req.params;
    const { name, traffic_split, changes, goals } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!id) return res.status(400).json({ error: 'experiment id is required in the URL' });

    const { rows } = await db.query(
      `INSERT INTO variants (experiment_id, name, traffic_split, changes, goals)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, name, traffic_split ?? 50, JSON.stringify(changes ?? []), JSON.stringify(goals ?? [])]
    );
    await recordGoalUsage(goals);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23503') return res.status(400).json({ error: 'no experiment found with that id' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/experiments/:id/variants/:variantId
// Full edit of an existing variant's name, traffic split, changes, and goals.
// Editing a variant that's currently live changes what visitors see immediately —
// there's no staging/draft step, so treat this like editing the client's page directly.
router.patch('/:id/variants/:variantId', async (req, res) => {
  try {
    const { id, variantId } = req.params;
    const { name, traffic_split, changes, goals } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // `changes` is only written when the request actually includes it. The
    // dashboard form edits name/split/goals only — what a variant *does* is
    // authored in the visual editor — so a save from the form must leave the
    // variant's changes untouched rather than resetting them to [].
    const changesParam = changes === undefined ? null : JSON.stringify(Array.isArray(changes) ? changes : []);

    const { rows } = await db.query(
      `UPDATE variants SET name = $1, traffic_split = $2, changes = COALESCE($3::jsonb, changes), goals = $4
       WHERE id = $5 AND experiment_id = $6 RETURNING *`,
      [name, traffic_split ?? 50, changesParam, JSON.stringify(goals ?? []), variantId, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id on that experiment' });
    await recordGoalUsage(goals);
    res.json(rows[0]);
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
    const sep = page_url.includes('?') ? '&' : '?';
    const editUrl = `${page_url}${sep}ab_edit=${req.params.variantId}&token=${token}`;
    res.json({ edit_url: editUrl });
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

    if (status === 'running') {
      const { rows: existing } = await db.query(
        `SELECT allowed_hosts FROM experiments WHERE id = $1`,
        [id]
      );
      if (existing.length === 0) return res.status(404).json({ error: 'no experiment found with that id' });
      const hosts = existing[0].allowed_hosts || [];
      if (hosts.length === 0) {
        return res.status(400).json({ error: 'Add at least one site domain in Settings before starting this experiment.' });
      }
    }

    const { rows } = await db.query(
      `UPDATE experiments SET status = $1 WHERE id = $2 RETURNING *`,
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
