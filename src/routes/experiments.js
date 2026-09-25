const express = require('express');
const db = require('../db');
const { requireApiKey } = require('../middleware/auth');
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

// Everything below is admin-only, requires x-api-key.
router.use(requireApiKey);

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
    const { name, url_match } = req.body;
    if (!name || !url_match) return res.status(400).json({ error: 'name and url_match are required' });

    const { rows } = await db.query(
      `INSERT INTO experiments (name, url_match) VALUES ($1, $2) RETURNING *`,
      [name, url_match]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
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
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23503') return res.status(400).json({ error: 'no experiment found with that id' });
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
