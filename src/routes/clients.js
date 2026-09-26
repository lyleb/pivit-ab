const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth(['owner'])); // managing client accounts is owner-only

// GET /api/clients — list, with a count of assigned experiments
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.username, c.created_at, COUNT(e.id)::int AS experiment_count
       FROM clients c
       LEFT JOIN experiments e ON e.client_id = c.id
       GROUP BY c.id
       ORDER BY c.name`
    );
    res.json({ clients: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// POST /api/clients { name, username, password }
router.post('/', async (req, res) => {
  try {
    const { name, username, password } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'name, username, and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO clients (name, username, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, username, created_at`,
      [name, username.trim().toLowerCase(), password_hash]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'that username is already taken' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/clients/:id — rename, change username, and/or reset password (all optional)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, username, password } = req.body;
    if (!name && !username && !password) return res.status(400).json({ error: 'nothing to update' });
    if (password && password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const { rows: existingRows } = await db.query(`SELECT * FROM clients WHERE id = $1`, [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'no client found with that id' });
    const existing = existingRows[0];

    const newName = name || existing.name;
    const newUsername = username ? username.trim().toLowerCase() : existing.username;
    const newHash = password ? await bcrypt.hash(password, 10) : existing.password_hash;

    const { rows } = await db.query(
      `UPDATE clients SET name = $1, username = $2, password_hash = $3 WHERE id = $4
       RETURNING id, name, username, created_at`,
      [newName, newUsername, newHash, id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'that username is already taken' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// DELETE /api/clients/:id — their experiments stay, just unassigned (ON DELETE SET NULL)
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`DELETE FROM clients WHERE id = $1 RETURNING id`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'no client found with that id' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
