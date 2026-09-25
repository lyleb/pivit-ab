const express = require('express');
const db = require('../db');
const { requireApiKey } = require('../middleware/auth');
const router = express.Router();

// GET /api/experiments?url=https://client-site.com/pricing
// PUBLIC — called by the snippet from any visitor's browser. No auth.
// Returns all *running* experiments whose url_match is found in the given URL,
// each with its variants, DOM-change instructions, and goals.
router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param is required' });

  try {
    const { rows: experiments } = await db.query(
      `SELECT id, name, url_match FROM experiments
       WHERE status = 'running' AND $1 ILIKE '%' || url_match || '%'`,
      [url]
    );

    if (experiments.length === 0) return res.json({ experiments: [] });

    const experimentIds = experiments.map((e) => e.id);
    const { rows: variants } = await db.query(
      `SELECT id, experiment_id, name, traffic_split, changes, goals
       FROM variants WHERE experiment_id = ANY($1::uuid[])`,
      [experimentIds]
    );

    const result = experiments.map((exp) => ({
      ...exp,
      variants: variants.filter((v) => v.experiment_id === exp.id),
    }));

    res.json({ experiments: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Everything below creates/edits experiments — admin-only, requires x-api-key.
router.use(requireApiKey);

router.post('/', async (req, res) => {
  const { name, url_match } = req.body;
  if (!name || !url_match) return res.status(400).json({ error: 'name and url_match are required' });

  const { rows } = await db.query(
    `INSERT INTO experiments (name, url_match) VALUES ($1, $2) RETURNING *`,
    [name, url_match]
  );
  res.status(201).json(rows[0]);
});

router.post('/:id/variants', async (req, res) => {
  const { id } = req.params;
  const { name, traffic_split, changes, goals } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await db.query(
    `INSERT INTO variants (experiment_id, name, traffic_split, changes, goals)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, name, traffic_split ?? 50, JSON.stringify(changes ?? []), JSON.stringify(goals ?? [])]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ['draft', 'running', 'paused', 'archived'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });

  const { rows } = await db.query(
    `UPDATE experiments SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  );
  res.json(rows[0]);
});

module.exports = router;
