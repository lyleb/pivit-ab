// Archive hides an agency and stops its snippet. The experiments stay in
// whatever state they were in, so Restore puts the same states back.
// Pausing them on archive would overwrite running and paused, and Restore
// could not tell those apart. The snippet gate is what stops customer sites.
//
// Delete is only for an agency that is already archived. It removes the
// agency's rows in one transaction. People (users) stay. Their membership
// of this agency does not. A Viewer login belongs to the agency and goes.

const db = require('./db');
const { isUuid } = require('./site-domain');
const { VIEW_ONLY_MESSAGE } = require('./membership-access');
const { recordAudit } = require('./audit');

const NOT_FOUND = 'not found';
const VIEW_AS = 'View as is read-only.';
const ARCHIVE_FIRST = 'Archive this agency first. Delete is only for an archived agency.';
const NAME_REQUIRED = 'Type the agency name to confirm.';
const NAME_MISMATCH = 'Type the agency name exactly.';
const ORIGINAL_AGENCY = 'This is the original agency. It stays so snippets that were installed before site keys keep working.';
const SIGN_OUT_WARNING = 'You are signed in to this agency. Deleting it signs you out.';

function deleteSummary(sites, experiments) {
  const siteText = Number(sites) === 1 ? '1 site' : `${Number(sites) || 0} sites`;
  const experimentText = Number(experiments) === 1 ? '1 experiment' : `${Number(experiments) || 0} experiments`;
  return `This deletes ${siteText}, ${experimentText} and all their results. This can't be undone.`;
}

function authorise(account) {
  if (!account) return { ok: false, status: 401, error: 'not authenticated' };
  if (account.readOnly || account.viewAs) return { ok: false, status: 403, error: VIEW_AS };
  if (account.role === 'member') return { ok: false, status: 403, error: VIEW_ONLY_MESSAGE };
  if (account.role !== 'owner' && account.superadmin !== true) {
    return { ok: false, status: 403, error: VIEW_ONLY_MESSAGE };
  }
  return { ok: true };
}

function shapeAgency(row, sessionAccountId) {
  const sites = Number(row.sites) || 0;
  const experiments = Number(row.experiments) || 0;
  const current = !!sessionAccountId && String(row.id) === String(sessionAccountId);
  return {
    id: row.id,
    name: row.name,
    legacy: row.legacy === true,
    archived: row.archived_at != null,
    archived_at: row.archived_at || null,
    created_at: row.created_at,
    sites,
    experiments,
    current,
    summary: deleteSummary(sites, experiments),
    sign_out_warning: current ? SIGN_OUT_WARNING : '',
  };
}

const AGENCY_SELECT = `
  SELECT a.id, a.name, a.legacy, a.archived_at, a.created_at,
         (SELECT COUNT(*)::int FROM sites s WHERE s.account_id = a.id) AS sites,
         (SELECT COUNT(*)::int FROM experiments e WHERE e.account_id = a.id) AS experiments
  FROM accounts a
`;

async function listAgencies(account) {
  const allowed = authorise(account);
  if (!allowed.ok) return allowed;
  let rows;
  if (account.superadmin === true) {
    const listed = await db.query(`${AGENCY_SELECT} ORDER BY a.archived_at IS NOT NULL, lower(a.name), a.id`);
    rows = listed.rows;
  } else if (!account.userId) {
    const listed = await db.query(`${AGENCY_SELECT} WHERE a.id = $1`, [account.id]);
    rows = listed.rows;
  } else {
    const listed = await db.query(
      `${AGENCY_SELECT}
       JOIN memberships m ON m.account_id = a.id AND m.user_id = $1 AND m.removed_at IS NULL AND m.role = 'owner'
       ORDER BY a.archived_at IS NOT NULL, lower(a.name), a.id`,
      [account.userId]
    );
    rows = listed.rows;
  }
  return {
    ok: true,
    agencies: rows.map((row) => shapeAgency(row, account.id)),
  };
}

async function withTransaction(fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    if (result && result.ok === false) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }
}

async function lockAgency(client, account, agencyId) {
  if (!isUuid(agencyId)) return { ok: false, status: 404, error: NOT_FOUND };
  const { rows } = await client.query(
    `SELECT id, name, legacy, archived_at, created_at FROM accounts WHERE id = $1 FOR UPDATE`,
    [agencyId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: NOT_FOUND };
  if (account.superadmin === true) return { ok: true, agency: row };
  if (!account.userId) {
    if (String(account.id) !== String(row.id)) return { ok: false, status: 404, error: NOT_FOUND };
    return { ok: true, agency: row };
  }
  const member = await client.query(
    `SELECT role FROM memberships
     WHERE account_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [row.id, account.userId]
  );
  const role = member.rows[0] && member.rows[0].role;
  if (role === 'owner') return { ok: true, agency: row };
  if (role === 'member') return { ok: false, status: 403, error: VIEW_ONLY_MESSAGE };
  return { ok: false, status: 404, error: NOT_FOUND };
}

function actorLabel(account) {
  return account && account.superadmin === true ? 'superadmin' : 'owner';
}

async function archiveAgency({ account, agencyId, ip }) {
  const allowed = authorise(account);
  if (!allowed.ok) return allowed;
  return withTransaction(async (client) => {
    const locked = await lockAgency(client, account, agencyId);
    if (!locked.ok) return locked;
    if (locked.agency.legacy === true) return { ok: false, status: 400, error: ORIGINAL_AGENCY };
    if (locked.agency.archived_at) {
      return { ok: true, id: locked.agency.id, name: locked.agency.name, archived: true, changed: false };
    }
    await client.query(`UPDATE accounts SET archived_at = now() WHERE id = $1`, [locked.agency.id]);
    await recordAudit(client, {
      accountId: locked.agency.id,
      userId: account.userId,
      actorLabel: actorLabel(account),
      action: 'agency_archive',
      targetType: 'account',
      targetId: locked.agency.id,
      detail: { name: locked.agency.name },
      ip,
    });
    return { ok: true, id: locked.agency.id, name: locked.agency.name, archived: true, changed: true };
  });
}

async function restoreAgency({ account, agencyId, ip }) {
  const allowed = authorise(account);
  if (!allowed.ok) return allowed;
  return withTransaction(async (client) => {
    const locked = await lockAgency(client, account, agencyId);
    if (!locked.ok) return locked;
    if (!locked.agency.archived_at) {
      return { ok: true, id: locked.agency.id, name: locked.agency.name, archived: false, changed: false };
    }
    await client.query(`UPDATE accounts SET archived_at = NULL WHERE id = $1`, [locked.agency.id]);
    await recordAudit(client, {
      accountId: locked.agency.id,
      userId: account.userId,
      actorLabel: actorLabel(account),
      action: 'agency_restore',
      targetType: 'account',
      targetId: locked.agency.id,
      detail: { name: locked.agency.name },
      ip,
    });
    return { ok: true, id: locked.agency.id, name: locked.agency.name, archived: false, changed: true };
  });
}

function readConfirm(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: NAME_REQUIRED };
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'confirm') || typeof body.confirm !== 'string') {
    return { ok: false, status: 400, error: NAME_REQUIRED };
  }
  const confirm = body.confirm.trim();
  if (!confirm || confirm.length > 500) return { ok: false, status: 400, error: NAME_REQUIRED };
  return { ok: true, confirm };
}

// Child tables that reference accounts have no ON DELETE CASCADE.
// Experiments do cascade to variants, events, revisions, drops, snapshots,
// reviews and conclusions. Everything else is deleted explicitly, in an
// order that does not leave a foreign key pointing at a removed row.
async function purgeAgency(client, accountId) {
  await client.query(`DELETE FROM "session" WHERE sess->>'accountId' = $1`, [accountId]);
  await client.query(
    `UPDATE "session"
     SET sess = (sess::jsonb - 'viewAsAccountId')::json
     WHERE sess->>'viewAsAccountId' = $1`,
    [accountId]
  );
  await client.query(
    `DELETE FROM login_tokens
     WHERE invite_id IN (SELECT id FROM invite_codes WHERE account_id = $1)`,
    [accountId]
  );
  await client.query(`DELETE FROM invite_codes WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM account_invites WHERE account_id = $1`, [accountId]);
  await client.query(`UPDATE accounts SET active_site_id = NULL WHERE id = $1`, [accountId]);
  await client.query(`DELETE FROM experiments WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM owner_notices WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM goal_templates WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM clients WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM host_hits WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM audit_log WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM sites WHERE account_id = $1`, [accountId]);
  await client.query(`DELETE FROM memberships WHERE account_id = $1`, [accountId]);
  const removed = await client.query(`DELETE FROM accounts WHERE id = $1 RETURNING id`, [accountId]);
  return removed.rows.length === 1;
}

async function deleteAgency({ account, agencyId, body, ip }) {
  const allowed = authorise(account);
  if (!allowed.ok) return allowed;
  const typed = readConfirm(body);
  if (!typed.ok) return typed;
  const outcome = await withTransaction(async (client) => {
    const locked = await lockAgency(client, account, agencyId);
    if (!locked.ok) return locked;
    if (locked.agency.legacy === true) return { ok: false, status: 400, error: ORIGINAL_AGENCY };
    if (!locked.agency.archived_at) return { ok: false, status: 400, error: ARCHIVE_FIRST };
    if (typed.confirm !== String(locked.agency.name || '').trim()) {
      return { ok: false, status: 400, error: NAME_MISMATCH };
    }
    const counts = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM sites WHERE account_id = $1) AS sites,
         (SELECT COUNT(*)::int FROM experiments WHERE account_id = $1) AS experiments`,
      [locked.agency.id]
    );
    const sites = Number(counts.rows[0].sites) || 0;
    const experiments = Number(counts.rows[0].experiments) || 0;
    const removed = await purgeAgency(client, locked.agency.id);
    if (!removed) return { ok: false, status: 404, error: NOT_FOUND };
    return {
      ok: true,
      id: locked.agency.id,
      name: locked.agency.name,
      sites,
      experiments,
      summary: deleteSummary(sites, experiments),
      signedOut: String(account.id) === String(locked.agency.id),
      homeAccountId: String(account.id) === String(locked.agency.id) ? null : account.id,
    };
  });
  if (!outcome.ok) return outcome;
  await recordAudit(db, {
    accountId: outcome.homeAccountId,
    userId: account.userId,
    actorLabel: actorLabel(account),
    action: 'agency_delete',
    targetType: 'account',
    targetId: outcome.id,
    detail: { name: outcome.name, sites: outcome.sites, experiments: outcome.experiments },
    ip,
  });
  return {
    ok: true,
    id: outcome.id,
    name: outcome.name,
    deleted: true,
    signedOut: outcome.signedOut === true,
    summary: outcome.summary,
  };
}

module.exports = {
  VIEW_ONLY_MESSAGE,
  NOT_FOUND,
  VIEW_AS,
  ARCHIVE_FIRST,
  NAME_REQUIRED,
  NAME_MISMATCH,
  ORIGINAL_AGENCY,
  SIGN_OUT_WARNING,
  deleteSummary,
  authorise,
  listAgencies,
  archiveAgency,
  restoreAgency,
  deleteAgency,
  purgeAgency,
};
