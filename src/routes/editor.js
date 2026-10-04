const express = require('express');
const db = require('../db');
const { verifyEditToken } = require('../edit-token');
const { recordGoalUsage } = require('./goals');
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

// A goal as the snippet understands it: { type: 'click', selector, id } or
// { type: 'url', url_match, id }. Validated here (not on the owner-session
// dashboard route) because this endpoint is reachable cross-origin with just a
// bearer token, so it shouldn't accept arbitrary junk into a column the live
// snippet reads on every page load.
function validateGoals(goals) {
  if (!Array.isArray(goals)) return 'goals must be an array';
  for (const g of goals) {
    if (!g || typeof g !== 'object') return 'each goal must be an object';
    const type = g.type || 'click';
    if (type === 'click') {
      if (typeof g.selector !== 'string' || !g.selector.trim()) return 'a click goal needs a selector';
    } else if (type === 'url') {
      if (typeof g.url_match !== 'string' || !g.url_match.trim()) return 'a url goal needs a url_match';
    } else {
      return `unknown goal type "${type}"`;
    }
    if (g.id !== undefined && (typeof g.id !== 'string' || g.id.length > 100)) return 'a goal id must be a string of 100 characters or fewer';
  }
  return null;
}

// PATCH /api/editor/variants/:variantId?token=...  { changes?: [...], goals?: [...] }
// Deliberately narrow — only touches what the visual editor authors (changes
// and goals), nothing else (name, traffic split stay untouched). Each field is
// only written when it's present in the request, so saving one never resets
// the other.
router.patch('/variants/:variantId', requireValidEditToken, async (req, res) => {
  try {
    const { changes, goals } = req.body;
    if (changes === undefined && goals === undefined) return res.status(400).json({ error: 'send changes and/or goals' });
    if (changes !== undefined && !Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
    if (goals !== undefined) {
      const problem = validateGoals(goals);
      if (problem) return res.status(400).json({ error: problem });
    }

    const { rows } = await db.query(
      `UPDATE variants
       SET changes = COALESCE($1::jsonb, changes), goals = COALESCE($2::jsonb, goals)
       WHERE id = $3 RETURNING *`,
      [
        changes === undefined ? null : JSON.stringify(changes),
        goals === undefined ? null : JSON.stringify(goals),
        req.params.variantId,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no variant found with that id' });
    if (goals !== undefined) await recordGoalUsage(goals); // keeps the dashboard's "popular goals" chips in step
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
