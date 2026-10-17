// Account scope for queries. Isolation lives here, not in the screen: a route
// asks for req.account.id and another account's id comes back as no rows.
// Public snippet calls resolve an account only from the site key. A tag with
// no key is the legacy install and can see only the legacy account.

const db = require('./db');
const { normaliseHost } = require('./host-scope');
const { newSiteKey, PRIMARY_SITE_HOST } = require('./db/tenancy');
const { guardSiteDomains, isUuid } = require('./site-domain');

const SITE_KEY_RE = /^site_[a-f0-9]{16,80}$/i;

let cachedLegacy = null;

function clearLegacyCache() {
  cachedLegacy = null;
}

function hostKey(hosts) {
  const list = [];
  for (const entry of hosts || []) {
    const host = normaliseHost(entry);
    if (host && !list.includes(host)) list.push(host);
  }
  list.sort();
  return list.join('\n');
}

// '' means no key (legacy tag). null means the value is present but not a key.
function normaliseSiteKey(value) {
  if (value == null || value === '') return '';
  const key = String(Array.isArray(value) ? value[0] : value).trim();
  if (!key) return '';
  if (!SITE_KEY_RE.test(key)) return null;
  return key;
}

async function legacyAccount() {
  if (cachedLegacy) return cachedLegacy;
  const { rows } = await db.query(
    `SELECT a.id, a.name, u.id AS user_id
     FROM accounts a
     LEFT JOIN memberships m ON m.account_id = a.id AND m.role = 'owner'
     LEFT JOIN users u ON u.id = m.user_id AND u.is_superadmin IS TRUE
     WHERE a.legacy IS TRUE
     ORDER BY a.created_at, a.id
     LIMIT 1`
  );
  if (!rows[0]) return null;
  cachedLegacy = rows[0];
  return cachedLegacy;
}

async function sessionActor(req) {
  const session = (req && req.session) || {};
  if (session.userId) {
    const { rows } = await db.query(
      `SELECT id, email, is_superadmin FROM users WHERE id = $1`,
      [session.userId]
    );
    return rows[0] || null;
  }
  if (session.role === 'owner' && !session.accountId) {
    const legacy = await legacyAccount();
    if (!legacy || !legacy.user_id) return null;
    const { rows } = await db.query(
      `SELECT id, email, is_superadmin FROM users WHERE id = $1`,
      [legacy.user_id]
    );
    return rows[0] || null;
  }
  return null;
}

function accountShape(row, extra) {
  return {
    id: row.id,
    name: row.name,
    legacy: row.legacy === true,
    role: 'owner',
    userId: extra.userId || null,
    superadmin: extra.superadmin === true,
    viewAs: extra.viewAs === true,
    readOnly: extra.readOnly === true,
  };
}

async function resolveSessionAccount(req) {
  const session = (req && req.session) || {};
  if (session.role === 'owner') {
    const actor = await sessionActor(req);
    if (session.viewAsAccountId && actor && actor.is_superadmin === true) {
      const { rows } = await db.query(
        `SELECT id, name, legacy FROM accounts WHERE id = $1`,
        [session.viewAsAccountId]
      );
      if (!rows[0]) return null;
      return accountShape(rows[0], { userId: actor.id, superadmin: true, viewAs: true, readOnly: true });
    }
    if (session.accountId) {
      const { rows } = await db.query(
        `SELECT id, name, legacy FROM accounts WHERE id = $1`,
        [session.accountId]
      );
      if (!rows[0]) return null;
      // A removed membership must not keep working on a session that was
      // already open. Sessions with no user id are the legacy password path.
      if (session.userId) {
        const member = await db.query(
          `SELECT m.role
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           WHERE m.account_id = $1 AND m.user_id = $2
             AND m.removed_at IS NULL
             AND u.deleted_at IS NULL`,
          [session.accountId, session.userId]
        );
        if (!member.rows[0]) return null;
      }
      return accountShape(rows[0], {
        userId: session.userId || null,
        superadmin: !!(actor && actor.is_superadmin),
      });
    }
    const legacy = await legacyAccount();
    if (!legacy) return null;
    return accountShape(
      { id: legacy.id, name: legacy.name, legacy: true },
      { userId: legacy.user_id || null, superadmin: !!(actor && actor.is_superadmin) }
    );
  }
  if (session.role === 'client' && session.clientId) {
    const { rows } = await db.query(
      `SELECT c.id, c.account_id, a.name AS account_name, a.legacy
       FROM clients c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.id = $1`,
      [session.clientId]
    );
    const client = rows[0];
    if (!client) return null;
    if (session.accountId && session.accountId !== client.account_id) return null;
    return {
      id: client.account_id,
      name: client.account_name,
      legacy: client.legacy === true,
      role: 'client_viewer',
      clientId: client.id,
    };
  }
  return null;
}

async function ownedExperiment(accountId, experimentId) {
  if (!accountId || !experimentId) return null;
  const { rows } = await db.query(
    `SELECT * FROM experiments WHERE id = $1 AND account_id = $2`,
    [experimentId, accountId]
  );
  return rows[0] || null;
}

async function snippetSiteKey(accountId) {
  const { rows } = await db.query(
    `SELECT s.public_key,
            (s.id = a.active_site_id) AS chosen,
            (SELECT COUNT(*)::int FROM sites WHERE account_id = a.id) AS n
     FROM sites s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.account_id = $1
     ORDER BY chosen DESC, s.created_at, s.id`,
    [accountId]
  );
  if (!rows.length) return null;
  if (rows[0].n === 1) return rows[0].public_key;
  if (rows[0].chosen === true) return rows[0].public_key;
  return null;
}

// ok:false means the caller must not fall back to the legacy account.
async function publicScope(rawKey) {
  const key = normaliseSiteKey(rawKey);
  if (key === null) return { ok: false, reason: 'invalid-key' };
  if (!key) {
    const legacy = await legacyAccount();
    if (!legacy) return { ok: false, reason: 'no-legacy' };
    return { ok: true, legacy: true, accountId: legacy.id, siteId: null };
  }
  const { rows } = await db.query(
    `SELECT id, account_id, public_key FROM sites WHERE public_key = $1`,
    [key]
  );
  if (!rows[0]) return { ok: false, reason: 'unknown-key' };
  return {
    ok: true,
    legacy: false,
    accountId: rows[0].account_id,
    siteId: rows[0].id,
    siteKey: rows[0].public_key,
  };
}

function domainError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function refuseSameAccountDomain(guard) {
  if (guard.ok) return;
  throw domainError(guard.error, 409);
}

// Keeps the site key stable when this experiment is the only one on its site.
// A shared site is left alone so one test cannot widen another test's domains.
async function placeOnSite(query, accountId, experimentId, hosts) {
  if (!hosts.length) return { siteId: null, needsSite: true, warningHost: null };

  let currentSiteId = null;
  if (experimentId) {
    const current = await query(
      `SELECT site_id FROM experiments WHERE id = $1 AND account_id = $2`,
      [experimentId, accountId]
    );
    currentSiteId = current.rows[0] ? current.rows[0].site_id : null;
  }

  if (currentSiteId && experimentId) {
    const siblings = await query(
      `SELECT COUNT(*)::int AS n FROM experiments
       WHERE site_id = $1 AND account_id = $2 AND id <> $3`,
      [currentSiteId, accountId, experimentId]
    );
    if (siblings.rows[0].n === 0) {
      const guard = await guardSiteDomains(query, {
        accountId,
        hosts,
        exceptSiteId: currentSiteId,
      });
      await refuseSameAccountDomain(guard);
      await query(
        `UPDATE sites
         SET domains = $2::text[],
             name = CASE WHEN name = $5 THEN name ELSE $3 END
         WHERE id = $1 AND account_id = $4`,
        [currentSiteId, hosts, hosts[0], accountId, PRIMARY_SITE_HOST]
      );
      return { siteId: currentSiteId, needsSite: false, warningHost: guard.warningHost };
    }
  }

  const { rows: sites } = await query(
    `SELECT id, domains FROM sites WHERE account_id = $1`,
    [accountId]
  );
  const wanted = hostKey(hosts);
  const match = sites.find((site) => hostKey(site.domains) === wanted);
  if (match) return { siteId: match.id, needsSite: false, warningHost: null };

  const guard = await guardSiteDomains(query, { accountId, hosts, exceptSiteId: null });
  await refuseSameAccountDomain(guard);
  const inserted = await query(
    `INSERT INTO sites (account_id, name, domains, public_key)
     VALUES ($1, $2, $3::text[], $4)
     RETURNING id`,
    [accountId, hosts[0], hosts, newSiteKey()]
  );
  return { siteId: inserted.rows[0].id, needsSite: false, warningHost: guard.warningHost };
}

// A named site is used as given. When the caller does not name one, the host
// list is matched to an existing site. The oldest site is not a fallback.
async function resolveExperimentSite(query, accountId, experimentId, hosts, requestedSiteId) {
  const raw = requestedSiteId ? String(requestedSiteId) : '';
  if (!raw) return placeOnSite(query, accountId, experimentId, hosts);
  if (!isUuid(raw)) throw domainError('no site found with that id', 404);
  const owned = await query(
    `SELECT id FROM sites WHERE id = $1 AND account_id = $2`,
    [raw, accountId]
  );
  if (!owned.rows[0]) throw domainError('no site found with that id', 404);
  const guard = await guardSiteDomains(query, {
    accountId,
    hosts,
    exceptSiteId: owned.rows[0].id,
  });
  await refuseSameAccountDomain(guard);
  return {
    siteId: owned.rows[0].id,
    needsSite: hosts.length === 0,
    warningHost: guard.warningHost,
  };
}

module.exports = {
  SITE_KEY_RE,
  clearLegacyCache,
  normaliseSiteKey,
  legacyAccount,
  sessionActor,
  resolveSessionAccount,
  ownedExperiment,
  snippetSiteKey,
  publicScope,
  placeOnSite,
  resolveExperimentSite,
  hostKey,
};
