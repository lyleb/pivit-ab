const express = require('express');
const db = require('../db');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { listAccountAudit } = require('../audit-log');

const router = express.Router();

// Owner only, and only this account. View-as already switches req.account.
// A client session is not an owner, so it gets the same 401 as signed out.
router.get('/', requireAuth(['owner']), async (req, res) => {
  try {
    const result = await listAccountAudit(req.account.id, req.query);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      entries: result.entries,
      page: result.page,
      page_size: result.page_size,
      total: result.total,
      tests: result.tests,
      users: result.users,
      actions: result.actions,
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

const adminRouter = express.Router();

adminRouter.get('/accounts', requireSuperadmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, legacy, created_at FROM accounts ORDER BY created_at, name`
    );
    res.json({
      accounts: rows.map((row) => ({
        id: row.id,
        name: row.name,
        legacy: row.legacy === true,
        created_at: row.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
