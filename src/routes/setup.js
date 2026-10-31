const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { refuseViewOnly } = require('../membership-access');
const { publicServerError } = require('../public-error');
const { markDomainConflict } = require('../auth-flow');
const { newSiteKey } = require('../db/tenancy');
const { recordAudit } = require('../audit');
const { accountPaidPlan, parseGa4Update } = require('../ga4');
const { parseDatalayerEventsUpdate } = require('../datalayer-events');
const { buildGtmContainer } = require('../ga4-container');
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

const SITE_COLUMNS = `id, name, domains, public_key, verified_at, conflict, install_note, install_note_host, qa_seen_at, ga4_measurement_id, ga4_enabled, datalayer_events`;

function sitePayload(row, paidPlan) {
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
    ga4_measurement_id: row.ga4_measurement_id || '',
    ga4_enabled: row.ga4_enabled === true,
    ga4_available: paidPlan === true,
    datalayer_events: row.datalayer_events === true,
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
  const paid = await accountPaidPlan(db, accountId);
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
    sites: sites.map((row) => sitePayload(row, paid)),
    site: sitePayload(site, paid),
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
    if (refuseViewOnly(req, res)) return;
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
    if (refuseViewOnly(req, res)) return;
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
    const paid = await accountPaidPlan(db, req.account.id);
    res.json({ sites: sites.map((row) => sitePayload(row, paid)) });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

sitesRouter.post('/', requireAuth(['owner']), async (req, res) => {
  try {
    if (refuseViewOnly(req, res)) return;
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
    const paid = await accountPaidPlan(db, req.account.id);
    res.status(201).json({ site: sitePayload(inserted.rows[0], paid), domain_warning: warning });
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
    if (refuseViewOnly(req, res)) return;
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
    const paid = await accountPaidPlan(db, req.account.id);
    res.json({ site: sitePayload(updated.rows[0], paid), domain_warning: warning });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

sitesRouter.get('/:id/ga4/container.json', requireAuth(['owner']), async (req, res) => {
  try {
    const existing = await loadOwnedSite(req.account.id, req.params.id);
    if (!existing) return res.status(404).json({ error: 'no site found with that id' });
    const body = buildGtmContainer(existing.ga4_measurement_id);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pivitlab-ga4.json"');
    res.send(`${JSON.stringify(body, null, 2)}\n`);
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

sitesRouter.patch('/:id/datalayer', requireAuth(['owner']), async (req, res) => {
  try {
    const existing = await loadOwnedSite(req.account.id, req.params.id);
    if (!existing) return res.status(404).json({ error: 'no site found with that id' });
    if (refuseViewOnly(req, res)) return;
    const parsed = parseDatalayerEventsUpdate(req.body);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const updated = await db.query(
      `UPDATE sites
       SET datalayer_events = $2
       WHERE id = $1 AND account_id = $3
       RETURNING ${SITE_COLUMNS}`,
      [existing.id, parsed.datalayer_events, req.account.id]
    );
    const beforeOn = existing.datalayer_events === true;
    if (beforeOn !== parsed.datalayer_events) {
      await recordAudit(db, {
        accountId: req.account.id,
        userId: req.account.userId,
        actorLabel: 'owner',
        action: 'datalayer_events',
        targetType: 'site',
        targetId: existing.id,
        detail: {
          datalayer_events: parsed.datalayer_events,
          host: (existing.domains || [])[0] || existing.name,
        },
        ip: req.ip,
      });
    }
    const paid = await accountPaidPlan(db, req.account.id);
    res.json({ site: sitePayload(updated.rows[0], paid) });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

sitesRouter.patch('/:id/ga4', requireAuth(['owner']), async (req, res) => {
  try {
    const existing = await loadOwnedSite(req.account.id, req.params.id);
    if (!existing) return res.status(404).json({ error: 'no site found with that id' });
    if (refuseViewOnly(req, res)) return;
    const paid = await accountPaidPlan(db, req.account.id);
    const parsed = parseGa4Update(req.body, existing, paid);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const updated = await db.query(
      `UPDATE sites
       SET ga4_measurement_id = $2,
           ga4_enabled = $3
       WHERE id = $1 AND account_id = $4
       RETURNING ${SITE_COLUMNS}`,
      [existing.id, parsed.measurement_id, parsed.enabled, req.account.id]
    );
    const beforeId = existing.ga4_measurement_id || '';
    const afterId = parsed.measurement_id || '';
    const beforeOn = existing.ga4_enabled === true;
    if (beforeOn !== parsed.enabled || beforeId !== afterId) {
      await recordAudit(db, {
        accountId: req.account.id,
        userId: req.account.userId,
        actorLabel: 'owner',
        action: 'ga4_settings',
        targetType: 'site',
        targetId: existing.id,
        detail: {
          enabled: parsed.enabled,
          measurement_id: afterId,
          host: (existing.domains || [])[0] || existing.name,
        },
        ip: req.ip,
      });
    }
    res.json({ site: sitePayload(updated.rows[0], paid) });
  } catch (err) {
    res.status(500).json(publicServerError(err));
  }
});

module.exports = { setupRouter, sitesRouter };
