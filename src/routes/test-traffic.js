const express = require('express');
const { assertAgencyOwner } = require('../team');
const { ownedExperiment } = require('../tenant');
const { refuseViewOnly } = require('../membership-access');
const {
  parseCriteria,
  parseDirection,
  isConfirmed,
  previewTestTraffic,
  applyTestTraffic,
  listTestTrafficAudit,
} = require('../test-traffic');

const router = express.Router({ mergeParams: true });

// Agency Owners and a platform admin. A Member is missing, the same answer as
// another agency's test. View as never reaches a POST: it is read-only first.
async function clearActor(account) {
  if (!account || !account.id) return { ok: false, status: 404, error: 'not found' };
  if (account.superadmin === true) {
    return { ok: true, userId: account.userId || null, actor: 'superadmin' };
  }
  const owner = await assertAgencyOwner(account.id, account.userId);
  if (!owner.ok) return { ok: false, status: owner.status || 404, error: owner.error || 'not found' };
  return { ok: true, userId: owner.userId, actor: owner.email || 'owner' };
}

async function ownedThenWriter(req, res) {
  const row = await ownedExperiment(req.account.id, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'no experiment found with that id' });
    return false;
  }
  if (refuseViewOnly(req, res)) return false;
  return true;
}

function actorIp(req) {
  const ip = req && req.ip ? String(req.ip) : '';
  return ip ? ip.slice(0, 64) : null;
}

function sendResult(res, result) {
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  const body = { ...result };
  delete body.ok;
  delete body.status;
  res.json(body);
}

// POST /api/experiments/:id/test-traffic/preview
// Owner only. Counts visitors and events per variant. Writes nothing.
router.post('/preview', async (req, res) => {
  const criteria = parseCriteria(req.body);
  if (!criteria.ok) return res.status(400).json({ error: criteria.error });
  const direction = parseDirection(req.body && req.body.direction);
  if (!direction) return res.status(400).json({ error: 'direction must be remove or restore' });
  try {
    sendResult(res, await previewTestTraffic(req.params.id, criteria, direction, undefined, req.account.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// POST /api/experiments/:id/test-traffic/remove
// Soft-exclude. confirm: true is required. Rows stay in the database.
router.post('/remove', async (req, res) => {
  if (!isConfirmed(req.body)) {
    return res.status(400).json({ error: 'Confirm the removal before it is applied.' });
  }
  const criteria = parseCriteria(req.body);
  if (!criteria.ok) return res.status(400).json({ error: criteria.error });
  if (criteria.mode === 'all') {
    return res.status(400).json({ error: 'Use clear test traffic for every pivit_qa, is_test and v_pt visitor.' });
  }
  try {
    if (!(await ownedThenWriter(req, res))) return;
    sendResult(res, await applyTestTraffic({
      experimentId: req.params.id,
      criteria,
      direction: 'remove',
      actor: 'owner',
      actorIp: actorIp(req),
      accountId: req.account.id,
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// POST /api/experiments/:id/test-traffic/restore
// Clears excluded_at for the same kind of match. confirm: true is required.
router.post('/restore', async (req, res) => {
  if (!isConfirmed(req.body)) {
    return res.status(400).json({ error: 'Confirm the restore before it is applied.' });
  }
  const criteria = parseCriteria(req.body);
  if (!criteria.ok) return res.status(400).json({ error: criteria.error });
  try {
    if (!(await ownedThenWriter(req, res))) return;
    let actorName = 'owner';
    let userId = null;
    if (criteria.mode === 'all') {
      const actor = await clearActor(req.account);
      if (!actor.ok) return res.status(actor.status || 404).json({ error: actor.error || 'not found' });
      actorName = actor.actor;
      userId = actor.userId;
    }
    sendResult(res, await applyTestTraffic({
      experimentId: req.params.id,
      criteria,
      direction: 'restore',
      actor: actorName,
      actorIp: actorIp(req),
      accountId: req.account.id,
      userId,
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// POST /api/experiments/:id/test-traffic/clear
// One click, after confirm. Soft-excludes every pivit_qa, is_test and v_pt row.
// Nothing is deleted. Undo is restore with mode all.
router.post('/clear', async (req, res) => {
  if (!isConfirmed(req.body)) {
    return res.status(400).json({ error: 'Confirm clearing test traffic before it is applied.' });
  }
  try {
    if (!(await ownedThenWriter(req, res))) return;
    const actor = await clearActor(req.account);
    if (!actor.ok) return res.status(actor.status || 404).json({ error: actor.error || 'not found' });
    sendResult(res, await applyTestTraffic({
      experimentId: req.params.id,
      criteria: { mode: 'all', prefix: null },
      direction: 'remove',
      actor: actor.actor,
      actorIp: actorIp(req),
      accountId: req.account.id,
      userId: actor.userId,
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/experiments/:id/test-traffic/audit
router.get('/audit', async (req, res) => {
  try {
    sendResult(res, await listTestTrafficAudit(req.params.id, undefined, req.account.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
