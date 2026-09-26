const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { recordGoalUsage } = require('./goals');
const router = express.Router();

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
      `SELECT id, name, url_match FROM experiments
       WHERE $1 ILIKE '%' || url_match || '%' ${statusClause}`,
      [url]
    );

    if (experiments.length === 0) return res.json({ experiments: [] });

    const experimentIds = experiments.map((e) => e.id);
    const enabledClause = preview ? '' : 'AND enabled = true';
    const { rows: variants } = await db.query(
      `SELECT id, experiment_id, name, traffic_split, changes, goals
       FROM variants WHERE experiment_id = ANY($1::uuid[]) ${enabledClause}`,
      [experimentIds]
    );

    const result = experiments.map((exp) => ({
      ...exp,
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
      `SELECT id, name FROM experiments WHERE id = ANY($1::uuid[])`,
      [idList]
    );
    if (experiments.length === 0) return res.json({ experiments: [] });

    const { rows: variants } = await db.query(
      `SELECT id, experiment_id, name, goals FROM variants WHERE experiment_id = ANY($1::uuid[])`,
      [idList]
    );

    const result = experiments.map((exp) => ({
      ...exp,
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

router.post('/', async (req, res) => {
  try {
    const { name, url_match, client_id } = req.body;
    if (!name || !url_match) return res.status(400).json({ error: 'name and url_match are required' });

    const { rows } = await db.query(
      `INSERT INTO experiments (name, url_match, client_id) VALUES ($1, $2, $3) RETURNING *`,
      [name, url_match, client_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23503') return res.status(400).json({ error: 'no client found with that id' });
    res.status(500).json({ error: 'internal error', detail: err.message });
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

    const { rows } = await db.query(
      `UPDATE variants SET name = $1, traffic_split = $2, changes = $3, goals = $4
       WHERE id = $5 AND experiment_id = $6 RETURNING *`,
      [name, traffic_split ?? 50, JSON.stringify(changes ?? []), JSON.stringify(goals ?? []), variantId, id]
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

router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!id) return res.status(400).json({ error: 'experiment id is required in the URL' });
    const allowed = ['draft', 'running', 'paused', 'archived'];
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });

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
