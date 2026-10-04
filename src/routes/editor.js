const express = require('express');
const db = require('../db');
const { verifyEditToken } = require('../edit-token');
const router = express.Router();

// Every route here is token-scoped to one specific variant — not session-based —
// since the visual editor runs on the client's own domain. See src/edit-token.js.
function requireValidEditToken(req, res, next) {
  const { variantId } = req.params;
  const { token } = req.query;
  if (!verifyEditToken(token, variantId)) {
    return res.status(401).json({ error: 'invalid or expired edit link — generate a new one from the dashboard' });
  }
  next();
}

// GET /api/editor/variants/:variantId?token=...
// Returns the variant plus its parent experiment's basic info, so the in-page
// editor has context (name, existing changes) without needing a session.
router.get('/variants/:variantId', requireValidEditToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT v.*, e.name AS experiment_name, e.url_match
       FROM variants v JOIN experiments e ON e.id = v.experiment_id
       WHERE v.id = $1`,
      [req.params.variantId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/editor/variants/:variantId?token=...  { changes: [...] }
// Deliberately narrow — only touches the changes array, nothing else (name,
// traffic split, goals stay untouched), matching what the visual editor
// actually does.
router.patch('/variants/:variantId', requireValidEditToken, async (req, res) => {
  try {
    const { changes } = req.body;
    if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });

    const { rows } = await db.query(
      `UPDATE variants SET changes = $1 WHERE id = $2 RETURNING *`,
      [JSON.stringify(changes), req.params.variantId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
