const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicServerError } = require('../public-error');
const { markDomainConflict } = require('../auth-flow');
const { newSiteKey } = require('../db/tenancy');
const { recordAudit } = require('../audit');
const { installCheckPayload } = require('../site-verify');
const { checklistFromFacts } = require('../checklist');
const {
  DOMAIN_IN_USE_WARNING,
  normaliseSiteDomain,
  sameAccountDomainMessage,
  chosenSite,
  siteChoiceRequired,
  guardSiteDomains,
  isUuid,
} = require('../site-domain');

const setupRouter = express.Router();
const sitesRouter = express.Router();
const sql = (text, params) => db.query(text, params);

const SITE_COLUMNS = `id, name, domains, public_key, verified_at, conflict, install_note, install_note_host, qa_seen_at`;

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

async function accountSites(accountId) {
  const { rows } = await db.query(
    `SELECT ${SITE_COLUMNS}
     FROM sites
     WHERE account_id = $1
     ORDER BY created_at, id`,
    [accountId]
  );
  return rows;
}

async function rememberedSiteId(accountId) {
  const { rows } = await db.query(
    `SELECT active_site_id FROM accounts WHERE id = $1`,
    [accountId]
  );
  return rows[0] ? rows[0].active_site_id : null;
}

async function checklistFacts(accountId, siteId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT checklist_dismissed_at IS NOT NULL FROM accounts WHERE id = $1) AS dismissed,
       (SELECT COUNT(*)::int FROM experiments WHERE account_id = $1 AND test_type <> 'demo') AS experiments,
       EXISTS (
         SELECT 1 FROM sites
         WHERE account_id = $1 AND id = $2 AND qa_seen_at IS NOT NULL
       ) AS qa_seen,
       EXISTS (
         SELECT 1 FROM events e
         JOIN experiments x ON x.id = e.experiment_id
         WHERE x.account_id = $1 AND x.site_id = $2 AND x.test_type <> 'demo' AND e.is_test
       ) AS test_events,
       EXISTS (
         SELECT 1 FROM experiments
         WHERE account_id = $1
           AND test_type <> 'demo'
           AND (started_at IS NOT NULL OR status IN ('running', 'paused'))
       ) AS started`,
    [accountId, siteId]
  );
  return rows[0] || {};
}

async function setupPayload(accountId) {
  const sites = await accountSites(accountId);
  const activeId = await rememberedSiteId(accountId);
  const site = chosenSite(sites, activeId);
  const facts = await checklistFacts(accountId, site ? site.id : null);
  const experiments = Number(facts.experiments) || 0;
  return {
    needs_setup: experiments === 0,
    site_choice_required: siteChoiceRequired(sites, activeId),
    checklist: checklistFromFacts({
      hasSite: sites.length > 0,
      snippetSeen: !!(site && site.verified_at),
      hasTest: experiments > 0,
      previewSeen: facts.qa_seen === true || facts.test_events === true,
      started: facts.started === true,
      dismissed: facts.dismissed === true,
    }),
    sites: sites.map(sitePayload),
    site: sitePayload(site),
  };
}

function websiteHost(body) {
  const raw = body && (body.website != null ? body.website : body.domain);
  return normaliseSiteDomain(raw);
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

setupRouter.post('/site', requireAuth(['owner']), async (req, res) => {
  try {
    const siteId = req.body && req.body.site_id;
    if (!isUuid(siteId)) return res.status(404).json({ error: 'no site found with that id' });
    const owned = await db.query(
      `SELECT id FROM sites WHERE id = $1 AND account_id = $2`,
      [siteId, req.account.id]
    );
    if (!owned.rows[0]) return res.status(404).json({ error: 'no site found with that id' });
    await db.query(
      `UPDATE accounts SET active_site_id = $2 WHERE id = $1`,
      [req.account.id, siteId]
    );
    res.json(await setupPayload(req.account.id));
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

async function loadOwnedSite(accountId, siteId) {
  if (!isUuid(siteId)) return null;
  const { rows } = await db.query(
    `SELECT ${SITE_COLUMNS} FROM sites WHERE id = $1 AND account_id = $2`,
    [siteId, accountId]
  );
  return rows[0] || null;
}

sitesRouter.get('/', requireAuth(['owner']), async (req, res) => {
  try {
    const sites = await accountSites(req.account.id);
    res.json({ sites: sites.map(sitePayload) });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

sitesRouter.post('/', requireAuth(['owner']), async (req, res) => {
  try {
    const host = websiteHost(req.body);
    if (!host) return res.status(400).json({ error: 'Enter your website, such as example.co.uk.' });
    const guard = await guardSiteDomains(sql, {
      accountId: req.account.id,
      hosts: [host],
      exceptSiteId: null,
    });
    if (!guard.ok) return res.status(409).json({ error: guard.error || sameAccountDomainMessage(host) });
    const inserted = await db.query(
      `INSERT INTO sites (account_id, name, domains, public_key)
       VALUES ($1, $2, $3::text[], $4)
       RETURNING ${SITE_COLUMNS}`,
      [req.account.id, host, [host], newSiteKey()]
    );
    let warning = null;
    if (guard.warningHost) {
      await markDomainConflict(db, req.account.id, host, inserted.rows[0].id);
      inserted.rows[0].conflict = true;
      warning = DOMAIN_IN_USE_WARNING;
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
    res.status(201).json({ site: sitePayload(inserted.rows[0]), domain_warning: warning });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

sitesRouter.patch('/:id', requireAuth(['owner']), async (req, res) => {
  try {
    const host = websiteHost(req.body);
    if (!host) return res.status(400).json({ error: 'Enter your website, such as example.co.uk.' });
    const existing = await loadOwnedSite(req.account.id, req.params.id);
    if (!existing) return res.status(404).json({ error: 'no site found with that id' });
    const guard = await guardSiteDomains(sql, {
      accountId: req.account.id,
      hosts: [host],
      exceptSiteId: existing.id,
    });
    if (!guard.ok) return res.status(409).json({ error: guard.error || sameAccountDomainMessage(host) });
    const current = (existing.domains || []).map((domain) => normaliseSiteDomain(domain)).filter(Boolean).sort();
    const domainChanged = current.length !== 1 || current[0] !== host;
    const updated = await db.query(
      `UPDATE sites
       SET name = $2,
           domains = $3::text[],
           conflict = $4,
           verified_at = CASE WHEN $5 THEN NULL ELSE verified_at END,
           install_note = CASE WHEN $5 THEN NULL ELSE install_note END,
           install_note_host = CASE WHEN $5 THEN NULL ELSE install_note_host END,
           qa_seen_at = CASE WHEN $5 THEN NULL ELSE qa_seen_at END
       WHERE id = $1 AND account_id = $6
       RETURNING ${SITE_COLUMNS}`,
      [existing.id, host, [host], guard.warningHost != null, domainChanged, req.account.id]
    );
    let warning = null;
    if (guard.warningHost) {
      await markDomainConflict(db, req.account.id, host, existing.id);
      updated.rows[0].conflict = true;
      warning = DOMAIN_IN_USE_WARNING;
    }
    await recordAudit(db, {
      accountId: req.account.id,
      userId: req.account.userId,
      actorLabel: 'owner',
      action: 'site_edited',
      targetType: 'site',
      targetId: existing.id,
      detail: { host },
      ip: req.ip,
    });
    res.json({ site: sitePayload(updated.rows[0]), domain_warning: warning });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = { setupRouter, sitesRouter };
