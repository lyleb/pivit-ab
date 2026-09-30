const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth(['owner'])); // admin-only — this is a dashboard convenience, not used by the snippet

// GET /api/goals/popular?limit=5
router.get('/popular', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    const { rows } = await db.query(
      `SELECT type, value, label, usage_count FROM goal_templates
       ORDER BY usage_count DESC, updated_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ goals: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// Called internally (not a route) whenever a variant is created/edited with goals,
// so popularity stays accurate. One upsert per distinct goal, run inside the same
// try/catch as the caller — a failure here shouldn't fail the variant save itself.
async function recordGoalUsage(goals) {
  for (const goal of goals || []) {
    const type = goal.type || 'click';
    const value = type === 'url' ? (goal.url_match || '') : (goal.selector || '');
    const label = goal.id || '';
    if (!value) continue;
    try {
      await db.query(
        `INSERT INTO goal_templates (type, value, label, usage_count, updated_at)
         VALUES ($1, $2, $3, 1, now())
         ON CONFLICT (type, value, label)
         DO UPDATE SET usage_count = goal_templates.usage_count + 1, updated_at = now()`,
        [type, value, label]
      );
    } catch (err) {
      console.error('Failed to record goal usage (non-fatal):', err);
    }
  }
}

module.exports = { router, recordGoalUsage };
