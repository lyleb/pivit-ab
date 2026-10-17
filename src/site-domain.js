// Site domains are compared in one normalised form: lower case, no scheme,
// no leading www, no port, no path, no query and no trailing slash. The same
// rules apply when a site is added and when it is edited.

const { normaliseHost } = require('./host-scope');

const DOMAIN_IN_USE_WARNING = 'This domain is already in use. A test runs only where this site\'s snippet is installed.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normaliseSiteDomain(raw) {
  let text = String(raw || '').trim();
  if (!text || text.length > 300) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  let hostname = '';
  try {
    hostname = new URL(text).hostname;
  } catch (err) {
    return '';
  }
  const host = normaliseHost(hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return '';
  if (/^\d+(\.\d+){3}$/.test(host)) return '';
  const labels = host.split('.');
  if (labels.length < 2) return '';
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
  return host;
}

function sameAccountDomainMessage(host) {
  return `This agency already has a site for ${host}.`;
}

function isUuid(value) {
  return UUID_RE.test(String(value || ''));
}

// The stored text is reduced the same way as a website the owner types.
function normalisedDomainExpr(column) {
  return `regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(btrim(${column})), '^https?://', ''),
          '[/?#].*$',
          ''
        ),
        ':[0-9]+$',
        ''
      ),
      '\\.$',
      ''
    ),
    '^www\\.',
    ''
  )`;
}

// One site is that site. Several sites use the remembered id only.
// Nothing here falls back to the oldest site.
function chosenSite(sites, activeId) {
  const list = Array.isArray(sites) ? sites : [];
  if (list.length === 1) return list[0];
  if (!activeId) return null;
  return list.find((site) => site && site.id === activeId) || null;
}

function siteChoiceRequired(sites, activeId) {
  const list = Array.isArray(sites) ? sites : [];
  return list.length > 1 && !chosenSite(list, activeId);
}

// Two booleans only. The query does not return another account's id, name
// or site id, so a caller cannot put them in a response by accident.
async function domainClash(query, accountId, host, exceptSiteId) {
  const normalised = normaliseSiteDomain(host) || normaliseHost(host);
  if (!normalised) return { sameAccount: false, otherAccount: false };
  const { rows } = await query(
    `SELECT
       COALESCE(BOOL_OR(account_id = $1), false) AS same_account,
       COALESCE(BOOL_OR(account_id <> $1), false) AS other_account
     FROM sites
     WHERE ($3::uuid IS NULL OR id <> $3)
       AND EXISTS (
         SELECT 1
         FROM unnest(domains) AS raw
         WHERE ${normalisedDomainExpr('raw')} = $2
       )`,
    [accountId, normalised, exceptSiteId || null]
  );
  const row = rows[0] || {};
  return {
    sameAccount: row.same_account === true,
    otherAccount: row.other_account === true,
  };
}

async function guardSiteDomains(query, { accountId, hosts, exceptSiteId }) {
  let warningHost = null;
  for (const host of hosts || []) {
    const clash = await domainClash(query, accountId, host, exceptSiteId);
    if (clash.sameAccount) {
      return { ok: false, error: sameAccountDomainMessage(host), warningHost: null };
    }
    if (clash.otherAccount && !warningHost) warningHost = host;
  }
  return { ok: true, error: null, warningHost };
}

function routeStatus(err) {
  const code = err && err.statusCode;
  if (code === 400 || code === 404 || code === 409) return code;
  return 0;
}

module.exports = {
  DOMAIN_IN_USE_WARNING,
  normaliseSiteDomain,
  sameAccountDomainMessage,
  isUuid,
  chosenSite,
  siteChoiceRequired,
  domainClash,
  guardSiteDomains,
  routeStatus,
  normalisedDomainExpr,
};
