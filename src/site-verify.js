// The install check. A snippet fetch with a site key, from an Origin on that
// site's domain list, marks the site verified. "Verified" means we saw the
// snippet load, not that the domain was proved by DNS.

const db = require('./db');
const { originHostFromRequest, normaliseHost } = require('./host-scope');
const { recordAudit } = require('./audit');

async function noteSnippetSeen(scope, req) {
  try {
    if (!scope || !scope.siteId) return;
    const host = originHostFromRequest(req);
    if (!host) return;
    const { rows } = await db.query(
      `SELECT id, account_id, domains, verified_at FROM sites WHERE id = $1`,
      [scope.siteId]
    );
    const site = rows[0];
    if (!site || site.verified_at) return;
    const domains = (site.domains || []).map((entry) => normaliseHost(entry)).filter(Boolean);
    if (!domains.includes(host)) return;
    const updated = await db.query(
      `UPDATE sites SET verified_at = now()
       WHERE id = $1 AND verified_at IS NULL
       RETURNING id`,
      [site.id]
    );
    if (!updated.rows[0]) return;
    await recordAudit(db, {
      accountId: site.account_id,
      action: 'site_verified',
      actorLabel: 'snippet',
      targetType: 'site',
      targetId: site.id,
      detail: { host },
      ip: req && req.ip,
    });
  } catch (err) {
    console.error('site verify failed:', err);
  }
}

module.exports = { noteSnippetSeen };
