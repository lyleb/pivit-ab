const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { customerHost } = require('../auth-flow');
const { newSiteKey } = require('../db/tenancy');
const { recordAudit } = require('../audit');
const { installCheckPayload } = require('../site-verify');
const { checklistFromFacts } = require('../checklist');

const setupRouter = express.Router();
const sitesRouter = express.Router();

function sitePayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    domains: row.domains || [],
    public_key: row.public_key,
    verified: row.verified_at != null,
    verified_at: row.verified_at,
    conflict: row.conflict === true,
    install_check: row.verified_at ? null : installCheckPayload(row.install_note, row.install_note_host),
  };
}

async function primarySite(accountId) {
  const { rows } = await db.query(
    `SELECT id, name, domains, public_key, verified_at, conflict, install_note, install_note_host
     FROM sites
     WHERE account_id = $1
     ORDER BY created_at
     LIMIT 1`,
    [accountId]
  );
  return rows[0] || null;
}

async function checklistFacts(accountId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT checklist_dismissed_at IS NOT NULL FROM accounts WHERE id = $1) AS dismissed,
       (SELECT COUNT(*)::int FROM experiments WHERE account_id = $1) AS experiments,
       EXISTS (
         SELECT 1 FROM sites WHERE account_id = $1 AND qa_seen_at IS NOT NULL
       ) AS qa_seen,
       EXISTS (
         SELECT 1 FROM events e
         JOIN experiments x ON x.id = e.experiment_id
         WHERE x.account_id = $1 AND e.is_test
       ) AS test_events,
       EXISTS (
         SELECT 1 FROM experiments
         WHERE account_id = $1
           AND (started_at IS NOT NULL OR status IN ('running', 'paused'))
       ) AS started`,
    [accountId]
  );
  return rows[0] || {};
}

async function setupPayload(accountId) {
  const facts = await checklistFacts(accountId);
  const site = await primarySite(accountId);
  const experiments = Number(facts.experiments) || 0;
  return {
    needs_setup: experiments === 0,
    checklist: checklistFromFacts({
      hasSite: !!site,
      snippetSeen: !!(site && site.verified_at),
      hasTest: experiments > 0,
      previewSeen: facts.qa_seen === true || facts.test_events === true,
      started: facts.started === true,
      dismissed: facts.dismissed === true,
    }),
    site: sitePayload(site),
  };
}

setupRouter.get('/', requireAuth(['owner']), async (req, res) => {
  try {
    res.json(await setupPayload(req.account.id));
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

setupRouter.post('/dismiss', requireAuth(['owner']), async (req, res) => {
  try {
    await db.query(
      `UPDATE accounts
       SET checklist_dismissed_at = COALESCE(checklist_dismissed_at, now())
       WHERE id = $1`,
      [req.account.id]
    );
    res.json(await setupPayload(req.account.id));
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

sitesRouter.post('/', requireAuth(['owner']), async (req, res) => {
  try {
    const existing = await primarySite(req.account.id);
    if (existing) return res.status(409).json({ error: 'This account already has a site.' });
    const host = customerHost(req.body && req.body.website);
    if (!host) return res.status(400).json({ error: 'Enter your website, such as example.co.uk.' });
    const inserted = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key)
       VALUES ($1, $2, $3::text[], $4)
       RETURNING id, name, domains, public_key, verified_at, conflict, install_note, install_note_host`,
      [req.account.id, host, [host], newSiteKey()]
    );
    const others = await db.query(
      `SELECT id FROM sites WHERE account_id <> $1 AND $2 = ANY(domains)`,
      [req.account.id, host]
    );
    if (others.rows.length) {
      const ids = others.rows.map((row) => row.id).concat([inserted.rows[0].id]);
      await db.query(`UPDATE sites SET conflict = true WHERE id = ANY($1::uuid[])`, [ids]);
      inserted.rows[0].conflict = true;
      await recordAudit(db, {
        accountId: req.account.id,
        userId: req.account.userId,
        action: 'domain_conflict',
        targetType: 'site',
        targetId: inserted.rows[0].id,
        detail: { host },
        ip: req.ip,
      });
    }
    await recordAudit(db, {
      accountId: req.account.id,
      userId: req.account.userId,
      actorLabel: 'owner',
      action: 'site_added',
      targetType: 'site',
      targetId: inserted.rows[0].id,
      detail: { host },
      ip: req.ip,
    });
    res.status(201).json({ site: sitePayload(inserted.rows[0]) });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = { setupRouter, sitesRouter };
