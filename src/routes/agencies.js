const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { clearSessionCookie } = require('../session-cookie');
const {
  listAgencies,
  archiveAgency,
  restoreAgency,
  deleteAgency,
} = require('../agency-lifecycle');

const router = express.Router();

// Owner or platform admin. A Member is refused here with 403. View as is
// read-only, so it is refused too. Another agency's id is 404.

router.use(requireAuth(['owner']));

function sendResult(res, result) {
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return null;
}

router.get('/', async (req, res) => {
  try {
    const result = await listAgencies(req.account);
    if (sendResult(res, result)) return;
    res.json({ agencies: result.agencies });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.post('/:id/archive', async (req, res) => {
  try {
    const result = await archiveAgency({ account: req.account, agencyId: req.params.id, ip: req.ip });
    if (sendResult(res, result)) return;
    res.json({ id: result.id, name: result.name, archived: true, changed: result.changed === true });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const result = await restoreAgency({ account: req.account, agencyId: req.params.id, ip: req.ip });
    if (sendResult(res, result)) return;
    res.json({ id: result.id, name: result.name, archived: false, changed: result.changed === true });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteAgency({
      account: req.account,
      agencyId: req.params.id,
      body: req.body,
      ip: req.ip,
    });
    if (sendResult(res, result)) return;
    const body = {
      id: result.id,
      name: result.name,
      deleted: true,
      signed_out: result.signedOut === true,
      summary: result.summary,
    };
    if (result.signedOut && req.session && typeof req.session.destroy === 'function') {
      req.session.destroy(() => {
        clearSessionCookie(res);
        res.json(body);
      });
      return;
    }
    res.json(body);
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
