const express = require('express');
const db = require('../db');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { publicServerError } = require('../public-error');

const router = express.Router();

router.get('/', requireAuth(['owner']), async (req, res) => {
  try {
    const all = req.account.superadmin === true && !req.account.viewAs;
    const params = [];
    let where = '';
    if (!all) {
      params.push(req.account.id);
      where = 'WHERE account_id = $1';
    }
    const { rows } = await db.query(
      `SELECT id, account_id, actor_user_id, actor_label, action, target_type, target_id, detail, ip, created_at
       FROM audit_log
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      params
    );
    res.json({
      entries: rows.map((row) => ({
        id: Number(row.id),
        account_id: row.account_id,
        actor_user_id: row.actor_user_id,
        actor_label: row.actor_label,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        detail: row.detail || {},
        ip: row.ip,
        created_at: row.created_at,
      })),
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
