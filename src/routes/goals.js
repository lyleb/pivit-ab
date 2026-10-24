const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isUuid } = require('../site-domain');
const router = express.Router();

router.use(requireAuth(['owner'])); // admin-only — this is a dashboard convenience, not used by the snippet

async function popularForSite(accountId, siteId, limit) {
  const { rows } = await db.query(
    `SELECT type, value, label, COUNT(*)::int AS usage_count
     FROM (
       SELECT
         COALESCE(NULLIF(g->>'type', ''), 'click') AS type,
         CASE
           WHEN COALESCE(NULLIF(g->>'type', ''), 'click') = 'url' THEN COALESCE(g->>'url_match', '')
           WHEN COALESCE(NULLIF(g->>'type', ''), 'click') = 'custom' THEN COALESCE(g->>'event', '')
           ELSE COALESCE(g->>'selector', '')
         END AS value,
         COALESCE(NULLIF(g->>'name', ''), NULLIF(g->>'id', ''), '') AS label
       FROM experiments e
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(e.goals) = 'array' THEN e.goals ELSE '[]'::jsonb END
       ) AS g
       WHERE e.account_id = $1
         AND e.site_id = $2
         AND COALESCE(e.goals_scope, 'shared') <> 'divergent'
       UNION ALL
       SELECT
         COALESCE(NULLIF(g->>'type', ''), 'click') AS type,
         CASE
           WHEN COALESCE(NULLIF(g->>'type', ''), 'click') = 'url' THEN COALESCE(g->>'url_match', '')
           WHEN COALESCE(NULLIF(g->>'type', ''), 'click') = 'custom' THEN COALESCE(g->>'event', '')
           ELSE COALESCE(g->>'selector', '')
         END AS value,
         COALESCE(NULLIF(g->>'name', ''), NULLIF(g->>'id', ''), '') AS label
       FROM variants v
       JOIN experiments e ON e.id = v.experiment_id
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(v.goals) = 'array' THEN v.goals ELSE '[]'::jsonb END
       ) AS g
       WHERE e.account_id = $1
         AND e.site_id = $2
         AND e.goals_scope = 'divergent'
     ) AS goals
     WHERE value <> ''
     GROUP BY type, value, label
     ORDER BY usage_count DESC, label
     LIMIT $3`,
    [accountId, siteId, limit]
  );
  return rows;
}

// GET /api/goals/popular?limit=5&site_id=
// One site keeps the account-wide list. Several sites need the site, and the
// list is that site's goals only. Omitting the site does not use the oldest.
router.get('/popular', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    const accountId = req.account.id;
    const requested = typeof req.query.site_id === 'string' ? req.query.site_id.trim() : '';
    if (requested) {
      if (!isUuid(requested)) return res.status(404).json({ error: 'no site found with that id' });
      const owned = await db.query(
        `SELECT id FROM sites WHERE id = $1 AND account_id = $2`,
        [requested, accountId]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'no site found with that id' });
    }
    const counted = await db.query(
      `SELECT COUNT(*)::int AS n FROM sites WHERE account_id = $1`,
      [accountId]
    );
    if (counted.rows[0].n > 1) {
      if (!requested) return res.json({ goals: [], site_choice_required: true });
      const goals = await popularForSite(accountId, requested, limit);
      return res.json({ goals, site_choice_required: false });
    }
    const { rows } = await db.query(
      `SELECT type, value, label, usage_count FROM goal_templates
       WHERE account_id = $2
       ORDER BY usage_count DESC, updated_at DESC LIMIT $1`,
      [limit, accountId]
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
async function recordGoalUsage(goals, accountId) {
  if (!accountId) return;
  for (const goal of goals || []) {
    const type = goal.type || 'click';
    const value = type === 'url' ? (goal.url_match || '') : (type === 'custom' ? (goal.event || '') : (goal.selector || ''));
    const label = goal.name || goal.id || '';
    if (!value) continue;
    try {
      await db.query(
        `INSERT INTO goal_templates (account_id, type, value, label, usage_count, updated_at)
         VALUES ($1, $2, $3, $4, 1, now())
         ON CONFLICT (account_id, type, value, label)
         DO UPDATE SET usage_count = goal_templates.usage_count + 1, updated_at = now()`,
        [accountId, type, value, label]
      );
    } catch (err) {
      console.error('Failed to record goal usage (non-fatal):', err);
    }
  }
}

module.exports = { router, recordGoalUsage };
