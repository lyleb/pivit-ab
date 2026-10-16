const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { setMembershipRole } = require('../membership-role');

const router = express.Router();

router.use(requireAuth(['owner']));

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
