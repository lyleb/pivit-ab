const express = require('express');
const db = require('../db');
const { requireSuperadmin } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { ga4Uptake, parsePaidPlan } = require('../ga4');
const { recordAudit } = require('../audit');
const { isUuid } = require('../site-domain');

const router = express.Router();

// Platform admin only. Anyone else gets 404. View as cannot change the flag.
router.get('/ga4', requireSuperadmin, async (req, res) => {
  try {
    res.json(await ga4Uptake(db));
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

router.patch('/accounts/:id/paid-plan', requireSuperadmin, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsed = parsePaidPlan(req.body);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const current = await db.query(
      `SELECT id, name, paid_plan FROM accounts WHERE id = $1`,
      [req.params.id]
    );
    if (!current.rows[0]) return res.status(404).json({ error: 'not found' });
    const before = current.rows[0].paid_plan === true;
    if (before !== parsed.paid_plan) {
      await db.query(
        `UPDATE accounts SET paid_plan = $2 WHERE id = $1`,
        [req.params.id, parsed.paid_plan]
      );
      await recordAudit(db, {
        accountId: current.rows[0].id,
        userId: req.superadmin.id,
        actorLabel: 'superadmin',
        action: 'paid_plan',
        targetType: 'account',
        targetId: current.rows[0].id,
        detail: { paid_plan: parsed.paid_plan, name: current.rows[0].name },
        ip: req.ip,
      });
    }
    const uptake = await ga4Uptake(db);
    res.json({
      id: current.rows[0].id,
      name: current.rows[0].name,
      paid_plan: parsed.paid_plan,
      sites_on: uptake.sites_on,
      agencies: uptake.agencies,
    });
  } catch (err) {
    if (err && err.code === '22P02') return res.status(404).json({ error: 'not found' });
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
