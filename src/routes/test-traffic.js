const express = require('express');
const {
  parseCriteria,
  parseDirection,
  isConfirmed,
  previewTestTraffic,
  applyTestTraffic,
  listTestTrafficAudit,
} = require('../test-traffic');

const router = express.Router({ mergeParams: true });

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
    sendResult(res, await previewTestTraffic(req.params.id, criteria, direction));
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
  try {
    sendResult(res, await applyTestTraffic({
      experimentId: req.params.id,
      criteria,
      direction: 'remove',
      actor: 'owner',
      actorIp: actorIp(req),
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
    sendResult(res, await applyTestTraffic({
      experimentId: req.params.id,
      criteria,
      direction: 'restore',
      actor: 'owner',
      actorIp: actorIp(req),
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /api/experiments/:id/test-traffic/audit
router.get('/audit', async (req, res) => {
  try {
    sendResult(res, await listTestTrafficAudit(req.params.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

module.exports = router;
