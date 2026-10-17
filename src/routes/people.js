const express = require('express');
const { requireSuperadmin } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const {
  parseAccessBody,
  setUserAccess,
  setViewerAccess,
  deleteUser,
  deleteViewer,
  listPeople,
} = require('../person-state');

const router = express.Router();

// Platform admin only. Anyone else gets 404. View as cannot change people.
// Archived people stay on this list so they can be restored. Ordinary lists
// and dropdowns leave them out. Delete is only for someone already suspended
// or archived, and the caller has to type their email or username.

router.get('/users', requireSuperadmin, async (req, res) => {
  try {
    const people = await listPeople();
    res.json({ people });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.patch('/users/:id', requireSuperadmin, async (req, res) => {
  try {
    const flags = parseAccessBody(req.body);
    if (!flags.ok) return res.status(flags.status).json({ error: flags.error });
    const result = await setUserAccess({
      actorUserId: req.superadmin.id,
      actorEmail: req.superadmin.email,
      userId: req.params.id,
      suspended: flags.suspended,
      archived: flags.archived,
      ip: req.ip,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      id: result.id,
      kind: result.kind,
      suspended: result.suspended,
      archived: result.archived,
      changed: result.changed,
    });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

router.delete('/users/:id', requireSuperadmin, async (req, res) => {
  try {
    const result = await deleteUser({
      actorUserId: req.superadmin.id,
      actorEmail: req.superadmin.email,
      userId: req.params.id,
      body: req.body,
      ip: req.ip,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ id: result.id, kind: result.kind, deleted: true });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

// Viewers live in the clients table. The path keeps that name.
router.patch('/clients/:id', requireSuperadmin, async (req, res) => {
  try {
    const flags = parseAccessBody(req.body);
    if (!flags.ok) return res.status(flags.status).json({ error: flags.error });
    const result = await setViewerAccess({
      actorUserId: req.superadmin.id,
      actorEmail: req.superadmin.email,
      clientId: req.params.id,
      suspended: flags.suspended,
      archived: flags.archived,
      ip: req.ip,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      id: result.id,
      kind: result.kind,
      suspended: result.suspended,
      archived: result.archived,
      changed: result.changed,
    });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

router.delete('/clients/:id', requireSuperadmin, async (req, res) => {
  try {
    const result = await deleteViewer({
      actorUserId: req.superadmin.id,
      actorEmail: req.superadmin.email,
      clientId: req.params.id,
      body: req.body,
      ip: req.ip,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ id: result.id, kind: result.kind, deleted: true });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
