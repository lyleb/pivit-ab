const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { endClientSessions } = require('../audit');
const { requireAuth } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { parseAccessBody, setViewerAccess } = require('../person-state');
const { assertAgencyOwner, recordViewerAudit } = require('../team');
const { refuseViewOnly } = require('../membership-access');
const router = express.Router();

router.use(requireAuth(['owner'])); // dashboard session. Membership Owner is checked on changes.

async function ownerOr404(req, res) {
  const actor = await assertAgencyOwner(req.account.id, req.account.userId);
  if (!actor.ok) {
    res.status(actor.status).json({ error: actor.error });
    return null;
  }
  return actor;
}

// GET /api/clients — list, with a count of assigned experiments
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.username, c.created_at, COUNT(e.id)::int AS experiment_count
       FROM clients c
       LEFT JOIN experiments e ON e.client_id = c.id AND e.account_id = c.account_id
       WHERE c.account_id = $1
         AND c.archived_at IS NULL
         AND c.deleted_at IS NULL
       GROUP BY c.id
       ORDER BY c.name`,
      [req.account.id]
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
    if (refuseViewOnly(req, res)) return;
    const actor = await ownerOr404(req, res);
    if (!actor) return;
    const { name, username, password } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'name, username, and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO clients (name, username, password_hash, account_id) VALUES ($1, $2, $3, $4)
       RETURNING id, name, username, created_at`,
      [name, username.trim().toLowerCase(), password_hash, req.account.id]
    );
    await recordViewerAudit({
      accountId: req.account.id,
      userId: actor.userId,
      actorLabel: actor.email,
      action: 'viewer.created',
      targetType: 'client',
      targetId: rows[0].id,
      detail: { name: rows[0].name, username: rows[0].username, kind: 'viewer' },
      ip: req.ip,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'that username is already taken' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// PATCH /api/clients/:id/access  { suspended, archived }
// This agency's Viewers only. It does not change a user's sign-in.
router.patch('/:id/access', async (req, res) => {
  try {
    const flags = parseAccessBody(req.body);
    if (!flags.ok) return res.status(flags.status).json({ error: flags.error });
    const ownedViewer = await db.query(
      `SELECT id FROM clients WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.account.id]
    );
    if (!ownedViewer.rows[0]) return res.status(404).json({ error: 'not found' });
    if (refuseViewOnly(req, res)) return;
    if (!req.account.userId) return res.status(404).json({ error: 'not found' });
    const result = await setViewerAccess({
      actorUserId: req.account.userId,
      clientId: req.params.id,
      suspended: flags.suspended,
      archived: flags.archived,
      ip: req.ip,
      accountId: req.account.id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({
      id: result.id,
      kind: result.kind,
      suspended: result.suspended,
      archived: result.archived,
      changed: result.changed,
    });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    return res.status(500).json(publicServerError(err));
  }
});

// PATCH /api/clients/:id — rename, change username, and/or reset password (all optional)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: existingRows } = await db.query(
      `SELECT * FROM clients
       WHERE id = $1 AND account_id = $2
         AND archived_at IS NULL
         AND deleted_at IS NULL`,
      [id, req.account.id]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'no viewer found with that id' });
    if (refuseViewOnly(req, res)) return;
    const actor = await ownerOr404(req, res);
    if (!actor) return;
    const { name, username, password } = req.body;
    if (!name && !username && !password) return res.status(400).json({ error: 'nothing to update' });
    if (password && password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const existing = existingRows[0];

    const newName = name || existing.name;
    const newUsername = username ? username.trim().toLowerCase() : existing.username;
    const newHash = password ? await bcrypt.hash(password, 10) : existing.password_hash;

    const { rows } = await db.query(
      `UPDATE clients SET name = $1, username = $2, password_hash = $3
       WHERE id = $4 AND account_id = $5
       RETURNING id, name, username, created_at`,
      [newName, newUsername, newHash, id, req.account.id]
    );
    if (password) await endClientSessions(id);
    const saved = rows[0];
    if (newName !== existing.name || newUsername !== existing.username) {
      await recordViewerAudit({
        accountId: req.account.id,
        userId: actor.userId,
        actorLabel: actor.email,
        action: 'viewer.updated',
        targetType: 'client',
        targetId: saved.id,
        detail: {
          name: saved.name,
          username: saved.username,
          from_name: existing.name,
          from_username: existing.username,
          kind: 'viewer',
        },
        ip: req.ip,
      });
    }
    if (password) {
      await recordViewerAudit({
        accountId: req.account.id,
        userId: actor.userId,
        actorLabel: actor.email,
        action: 'viewer.password_reset',
        targetType: 'client',
        targetId: saved.id,
        detail: { name: saved.name, username: saved.username, kind: 'viewer' },
        ip: req.ip,
      });
    }
    res.json(saved);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(400).json({ error: 'that username is already taken' });
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// DELETE /api/clients/:id — their experiments stay, just unassigned (ON DELETE SET NULL)
router.delete('/:id', async (req, res) => {
  try {
    const present = await db.query(
      `SELECT id FROM clients
       WHERE id = $1 AND account_id = $2
         AND archived_at IS NULL
         AND deleted_at IS NULL`,
      [req.params.id, req.account.id]
    );
    if (!present.rows[0]) return res.status(404).json({ error: 'no viewer found with that id' });
    if (refuseViewOnly(req, res)) return;
    const actor = await ownerOr404(req, res);
    if (!actor) return;
    const { rows } = await db.query(
      `DELETE FROM clients
       WHERE id = $1 AND account_id = $2
         AND archived_at IS NULL
         AND deleted_at IS NULL
       RETURNING id, name, username`,
      [req.params.id, req.account.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no viewer found with that id' });
    await endClientSessions(req.params.id);
    await recordViewerAudit({
      accountId: req.account.id,
      userId: actor.userId,
      actorLabel: actor.email,
      action: 'viewer.deleted',
      targetType: 'client',
      targetId: rows[0].id,
      detail: { name: rows[0].name, username: rows[0].username, kind: 'viewer' },
      ip: req.ip,
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
