const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { tooMany } = require('../rate-limit');
const { setMembershipRole } = require('../membership-role');
const { listTeam, removeMembership } = require('../team');
const {
  createAccountInvite,
  listAccountInvites,
  revokeAccountInvite,
  resendAccountInvite,
} = require('../account-invite');

const router = express.Router();

router.use(requireAuth(['owner']));

function sendInviteResult(res, result) {
  if (!result || result.ok === false) {
    if (result && result.status === 429) return tooMany(res, result.retryAfter);
    const status = result && result.status ? result.status : 400;
    const error = result && result.error ? result.error : 'not found';
    return res.status(status).json({ error });
  }
  res.set('Cache-Control', 'no-store');
  const body = {};
  if (result.invites) body.invites = result.invites;
  if (result.invite) body.invite = result.invite;
  if (result.link) body.link = result.link;
  if (result.emailed != null) body.emailed = result.emailed === true;
  if (result.emailError) body.email_error = result.emailError;
  if (result.resent) body.resent = true;
  return res.status(result.status || 200).json(body);
}

// Owners and Members. Another agency's people are not in this list.
router.get('/', async (req, res) => {
  try {
    const result = await listTeam({
      accountId: req.account.id,
      actorUserId: req.account.userId,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.set('Cache-Control', 'no-store');
    return res.json({ people: result.people });
  } catch (err) {
    return res.status(500).json(publicServerError(err));
  }
});

// The account is the session account. Another agency's invite id is missing.
router.get('/invites', async (req, res) => {
  try {
    const result = await listAccountInvites({
      accountId: req.account.id,
      actorUserId: req.account.userId,
    });
    return sendInviteResult(res, result);
  } catch (err) {
    return res.status(500).json(publicServerError(err));
  }
});

router.post('/invites', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await createAccountInvite({
      accountId: req.account.id,
      actorUserId: req.account.userId,
      email: body.email,
      role: body.role,
      send: body.send === true,
      ip: req.ip,
    });
    return sendInviteResult(res, result);
  } catch (err) {
    return res.status(500).json(publicServerError(err));
  }
});

router.post('/invites/:id/revoke', async (req, res) => {
  try {
    const result = await revokeAccountInvite({
      accountId: req.account.id,
      actorUserId: req.account.userId,
      inviteId: req.params.id,
      ip: req.ip,
    });
    return sendInviteResult(res, result);
  } catch (err) {
    return res.status(500).json(publicServerError(err));
  }
});

router.post('/invites/:id/resend', async (req, res) => {
  try {
    const result = await resendAccountInvite({
      accountId: req.account.id,
      actorUserId: req.account.userId,
      inviteId: req.params.id,
      ip: req.ip,
    });
    return sendInviteResult(res, result);
  } catch (err) {
    return res.status(500).json(publicServerError(err));
  }
});

// DELETE /api/account/members/:userId
// Drops the membership for this agency only. The user account stays.
router.delete('/:userId', async (req, res) => {
  try {
    const result = await removeMembership({
      accountId: req.account.id,
      actorUserId: req.account.userId,
      targetUserId: req.params.userId,
      ip: req.ip,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ user_id: result.id, removed: true });
  } catch (err) {
    return res.status(500).json(publicServerError(err));
  }
});

// PATCH /api/account/members/:userId  { role }
// The account is the session account. A user id from another account is missing.
router.patch('/:userId', async (req, res) => {
  try {
    const result = await setMembershipRole({
      accountId: req.account.id,
      actorUserId: req.account.userId,
      targetUserId: req.params.userId,
      role: req.body && req.body.role,
      ip: req.ip,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      user_id: req.params.userId,
      role: result.role,
      changed: result.changed === true,
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
