const express = require('express');
const { requireSuperadmin } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { turnstileOk } = require('../turnstile');
const { accessRequestsEnabled } = require('../access-flag');
const {
  submitAccessRequest,
  listAccessRequests,
  createInviteForRequest,
} = require('../access-requests');

const publicRouter = express.Router();

publicRouter.post('/', async (req, res) => {
  try {
    if (!accessRequestsEnabled()) return res.status(404).json({ error: 'not found' });
    if (!(await turnstileOk(req))) return res.status(400).json({ error: 'Please try again.' });
    const result = await submitAccessRequest(req);
    if (!result.ok) {
      if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
      return res.status(result.status).json({ error: result.error });
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

const adminRouter = express.Router();
adminRouter.use(requireSuperadmin);

adminRouter.get('/', async (req, res) => {
  try {
    const requests = await listAccessRequests();
    res.json({ enabled: accessRequestsEnabled(), requests });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

adminRouter.post('/:id/invite', async (req, res) => {
  try {
    const result = await createInviteForRequest({
      id: req.params.id,
      userId: req.superadmin.id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.already) return res.json({ already: true, request: result.request });
    res.status(201).json({
      code: result.code,
      request: result.request,
      invite: {
        id: result.invite.id,
        hint: result.invite.hint,
        note: result.invite.note,
        expires_at: result.invite.expires_at,
        created_at: result.invite.created_at,
      },
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = publicRouter;
module.exports.adminRouter = adminRouter;
