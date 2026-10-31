// Checks a click-goal selector against the preview page. Read-only: a Member
// can run it, and a miss does not stop the goal from being saved.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { isUuid } = require('../site-domain');
const { checkClickSelector } = require('../selector-check');

const router = express.Router();

async function hostsForAccount(accountId, experimentId) {
  const sites = await db.query(
    `SELECT domains FROM sites WHERE account_id = $1`,
    [accountId]
  );
  const experiments = await db.query(
    `SELECT allowed_hosts FROM experiments
     WHERE account_id = $1 AND ($2::uuid IS NULL OR id = $2)`,
    [accountId, experimentId || null]
  );
  const hosts = [];
  sites.rows.forEach((row) => {
    (row.domains || []).forEach((host) => hosts.push(host));
  });
  experiments.rows.forEach((row) => {
    (row.allowed_hosts || []).forEach((host) => hosts.push(host));
  });
  return hosts;
}

router.post('/', requireAuth(['owner']), async (req, res) => {
  try {
    const body = req.body || {};
    const experimentId = typeof body.experiment_id === 'string' ? body.experiment_id.trim() : '';
    if (experimentId && !isUuid(experimentId)) {
      return res.status(404).json({ error: 'no experiment found with that id' });
    }
    if (experimentId) {
      const owned = await db.query(
        `SELECT id FROM experiments WHERE id = $1 AND account_id = $2`,
        [experimentId, req.account.id]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'no experiment found with that id' });
    }
    const allowedHosts = await hostsForAccount(req.account.id, experimentId);
    const result = await checkClickSelector({
      pageUrl: body.page_url,
      selector: body.selector,
      allowedHosts,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = router;
