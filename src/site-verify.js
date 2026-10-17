// The install check. A snippet fetch with a site key, from an Origin on that
// site's domain list, marks the site verified. "Verified" means we saw the
// snippet load, not that the domain was proved by DNS.

const db = require('./db');
const { originHostFromRequest, normaliseHost } = require('./host-scope');
const { recordAudit } = require('./audit');

const INSTALL_PROBLEMS = {
  missing: 'the snippet had no site key',
  invalid: 'the site key was not valid',
  wrong: 'the site key did not match this agency',
};

// Owner-facing copy. Null when there is nothing to report. The public snippet
// response does not include this.
function installCheckPayload(note, host) {
  const reason = Object.prototype.hasOwnProperty.call(INSTALL_PROBLEMS, note) ? note : null;
  if (!reason) return null;
  const safeHost = typeof host === 'string' && /^[a-z0-9.-]+$/.test(host) ? host : '';
  const where = safeHost ? ` from ${safeHost}` : '';
  return {
    reason,
    host: safeHost || null,
    message: `We saw a visit${where}, but ${INSTALL_PROBLEMS[reason]}. Copy the snippet from pivitlab and replace the tag on your site.`,
  };
}

function problemReason(scope) {
  if (!scope || !scope.ok) {
    return scope && scope.reason === 'invalid-key' ? 'invalid' : 'wrong';
  }
  if (scope.legacy) return 'missing';
  return null;
}

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
      `UPDATE sites
       SET verified_at = now(),
           install_note = NULL,
           install_note_host = NULL,
           install_note_at = NULL
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

// Records a visit on unverified sites whose domain list contains the Origin
// host, when that visit did not carry their key. A verified site is never
// updated, so the live cantsaythat tag does not write a note on each hit.
// A real key is excluded: that site is verified by noteSnippetSeen when the
// host matches, and a stranger using the key must not mark its owner.
async function noteInstallCheck(scope, req) {
  try {
    const host = originHostFromRequest(req);
    if (!host) return;
    let reason = problemReason(scope);
    let excludeId = null;
    if (!reason && scope && scope.siteId) {
      reason = 'wrong';
      excludeId = scope.siteId;
    }
    if (!reason) return;
    await db.query(
      `UPDATE sites
       SET install_note = $1,
           install_note_host = $2,
           install_note_at = now()
       WHERE verified_at IS NULL
         AND $2 = ANY(domains)
         AND ($3::uuid IS NULL OR id <> $3)
         AND (install_note IS DISTINCT FROM $1 OR install_note_host IS DISTINCT FROM $2)`,
      [reason, host, excludeId]
    );
  } catch (err) {
    console.error('install check note failed:', err);
  }
}

// Records the first snippet call that carried ?pivit_qa=1 from a host on the
// site's domain list. A verified site can still receive this, because the
// preview step is separate from the install check. A visit with no Origin
// or Referer is ignored, and so is a visit for a different host. The public
// response is unchanged. A missing column (migration 009 not applied yet)
// is logged and does not fail the snippet call.
async function noteQaPreview(scope, req) {
  try {
    if (!scope || !scope.ok || !scope.accountId) return;
    const host = originHostFromRequest(req);
    if (!host) return;
    const { rows } = await db.query(
      `SELECT id, domains FROM sites
       WHERE account_id = $1
         AND qa_seen_at IS NULL
         AND ($2::uuid IS NULL OR id = $2)`,
      [scope.accountId, scope.siteId || null]
    );
    const ids = rows.filter((row) => {
      const domains = (row.domains || []).map((entry) => normaliseHost(entry)).filter(Boolean);
      return domains.includes(host);
    }).map((row) => row.id);
    if (!ids.length) return;
    await db.query(
      `UPDATE sites SET qa_seen_at = now()
       WHERE id = ANY($1::uuid[]) AND qa_seen_at IS NULL`,
      [ids]
    );
  } catch (err) {
    console.error('qa preview note failed:', err);
  }
}

module.exports = { noteSnippetSeen, noteInstallCheck, noteQaPreview, installCheckPayload };
