const express = require('express');
const { requireSuperadmin } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { createInvite, listInvites, revokeInvite } = require('../auth-flow');

const router = express.Router();

router.use(requireSuperadmin);

router.get('/', async (req, res) => {
  try {
    const invites = await listInvites();
    res.json({
      invites: invites.map((row) => ({
        id: row.id,
        hint: row.hint,
        note: row.note,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
        used_at: row.used_at,
        created_at: row.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await createInvite({
      userId: req.superadmin.id,
      note: req.body && req.body.note,
    });
    res.status(201).json({
      code: created.code,
      invite: {
        id: created.invite.id,
        hint: created.invite.hint,
        note: created.invite.note,
        expires_at: created.invite.expires_at,
        created_at: created.invite.created_at,
      },
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/:id/revoke', async (req, res) => {
  try {
    const row = await revokeInvite(req.params.id, req.superadmin.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ id: row.id, hint: row.hint, revoked_at: row.revoked_at, used_at: row.used_at });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
