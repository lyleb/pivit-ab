const express = require('express');
const db = require('../db');
const { inspectEditToken } = require('../edit-token');
const { createPreviewToken } = require('../preview-access');
const { recordGoalUsage } = require('./goals');
const { validateGoals, persistGoals } = require('../goals');
const {
  archivedBody,
  archivedEditMessage,
  archivedPreviewMessage,
  editorFields,
  expiredEditMessage,
} = require('../editor-context');
const { validateChanges } = require('../changes');
const router = express.Router();

// The editor reads one variant at a time. A cached GET would keep showing the
// previous test after the owner switches experiments.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Every route here is token-scoped to one specific variant — not session-based —
// since the visual editor runs on the client's own domain. See src/edit-token.js.
function requireValidEditToken(req, res, next) {
  const { variantId } = req.params;
  const { token } = req.query;
  const claims = inspectEditToken(token, variantId);
  if (!claims) {
    return res.status(401).json({ error: 'invalid or expired edit link — generate a new one from the dashboard' });
  }
  req.editClaims = claims;
  next();
}

function claimsMatch(claims, accountId) {
  return !claims || !claims.accountId || claims.accountId === accountId;
}

const VARIANT_SQL = `
  SELECT v.*, e.name AS experiment_name, e.status AS experiment_status,
         e.site_id AS experiment_site_id,
         e.url_match, e.goals AS experiment_goals, e.goals_scope
  FROM variants v
  JOIN experiments e ON e.id = v.experiment_id
  WHERE v.id = $1
`;

function archivedFromRow(req, row, message) {
  return archivedBody(req, {
    id: row.experiment_id,
    name: row.experiment_name,
    variantId: row.id,
    variantName: row.name,
  }, message);
}

// 404 when the variant is gone, 401 when the token is for another account,
// 409 when the test is archived. The 409 body names the test and links to it,
// and it does not include the variant's changes.
function rejectEditorRow(req, res, row, archivedMessage) {
  if (!row) {
    res.status(404).json({ error: 'no variant found with that id' });
    return true;
  }
  if (!claimsMatch(req.editClaims, row.account_id)) {
    res.status(401).json({ error: 'invalid or expired edit link — generate a new one from the dashboard' });
    return true;
  }
  if (row.experiment_status === 'archived') {
    res.status(409).json(archivedFromRow(req, row, archivedMessage(row.experiment_name)));
    return true;
  }
  return false;
}

// GET /api/editor/variants/:variantId?token=...
// Returns the variant plus its parent experiment's basic info, so the in-page
// editor has context (name, existing changes) without needing a session.
router.get('/variants/:variantId', requireValidEditToken, async (req, res) => {
  try {
    const { rows } = await db.query(VARIANT_SQL, [req.params.variantId]);
    const row = rows[0];
    if (rejectEditorRow(req, res, row, expiredEditMessage)) return;
    // Shared goals are the ones every variant is measured on. The editor
    // still receives them as `goals` so a save writes the same list back.
    if (row.goals_scope !== 'divergent' && Array.isArray(row.experiment_goals) && row.experiment_goals.length) {
      row.goals = row.experiment_goals;
    }
    Object.assign(row, editorFields(row.experiment_status));
    delete row.experiment_site_id;
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/editor/variants/:variantId/preview-token?token=...
// The editor runs on the customer origin. Exchange the edit token for a
// preview token so Desktop/Tablet/Mobile can open a preview that does not
// carry the more powerful edit token in the URL.
router.get('/variants/:variantId/preview-token', requireValidEditToken, async (req, res) => {
  try {
    const { rows } = await db.query(VARIANT_SQL, [req.params.variantId]);
    const row = rows[0];
    if (rejectEditorRow(req, res, row, archivedPreviewMessage)) return;
    res.json({
      preview_token: createPreviewToken(req.params.variantId, undefined, undefined, {
        accountId: row.account_id,
        siteId: row.experiment_site_id,
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/editor/variants/:variantId?token=...  { changes?: [...], goals?: [...] }
// Deliberately narrow — only touches what the visual editor authors (changes
// and goals), nothing else (name, traffic split stay untouched). Each field is
// only written when it's present in the request, so saving one never resets
// the other. On a shared experiment, goals are saved once and copied to every
// variant. On a divergent experiment they stay on this variant.
router.patch('/variants/:variantId', requireValidEditToken, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { changes, goals } = req.body;
    if (changes === undefined && goals === undefined) return res.status(400).json({ error: 'send changes and/or goals' });
    if (changes !== undefined) {
      const problem = validateChanges(changes);
      if (problem) return res.status(400).json({ error: problem });
      if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
    }
    if (goals !== undefined) {
      const problem = validateGoals(goals);
      if (problem) return res.status(400).json({ error: problem });
    }

    await client.query('BEGIN');
    const locked = await client.query(`${VARIANT_SQL} FOR UPDATE OF e`, [req.params.variantId]);
    const current = locked.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no variant found with that id' });
    }
    if (!claimsMatch(req.editClaims, current.account_id)) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'invalid or expired edit link — generate a new one from the dashboard' });
    }
    if (current.experiment_status === 'archived') {
      await client.query('ROLLBACK');
      return res.status(409).json(archivedFromRow(req, current, archivedEditMessage(current.experiment_name)));
    }
    const { rows } = await client.query(
      `UPDATE variants
       SET changes = COALESCE($1::jsonb, changes)
       WHERE id = $2 RETURNING *`,
      [
        changes === undefined ? null : JSON.stringify(changes),
        req.params.variantId,
      ]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no variant found with that id' });
    }
    if (goals !== undefined) {
      const saved = await persistGoals(client.query.bind(client), {
        experimentId: rows[0].experiment_id,
        variantId: req.params.variantId,
        goals,
        unify: false,
        accountId: rows[0].account_id,
      });
      rows[0].goals = saved.goals;
      rows[0].goals_scope = saved.goals_scope;
      await recordGoalUsage(saved.goals, rows[0].account_id);
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

module.exports = router;
