// Account-scoped audit log. The account id always comes from the session.
// A filter cannot widen the query to another account.

const db = require('./db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_RE = /^[a-z0-9_]{1,80}$/i;
const DEFAULT_PAGE_SIZE = 25;
const LEGACY_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 100000;

function first(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function blank(value) {
  return value == null || String(value).trim() === '';
}

function parseWholeNumber(value, name, max) {
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    return { ok: false, status: 400, error: `${name} must be a whole number.` };
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { ok: false, status: 400, error: `${name} must be a whole number.` };
  }
  return { ok: true, value: Math.min(n, max) };
}

function parseAuditQuery(query) {
  const source = query || {};
  const test = first(source.test);
  const user = first(source.user);
  const action = first(source.action);
  const pageRaw = first(source.page);
  const sizeRaw = first(source.page_size);
  const paged = !blank(pageRaw) || !blank(sizeRaw) || !blank(test) || !blank(user) || !blank(action);

  let testId = null;
  if (!blank(test)) {
    testId = String(test).trim();
    if (!UUID_RE.test(testId)) {
      return { ok: false, status: 400, error: 'Choose a test from the list.' };
    }
  }

  let userId = null;
  let userLabel = null;
  if (!blank(user)) {
    const text = String(user).trim();
    if (text.length > 200) {
      return { ok: false, status: 400, error: 'That user is not recognised.' };
    }
    if (UUID_RE.test(text)) userId = text;
    else userLabel = text;
  }

  let actionName = null;
  if (!blank(action)) {
    actionName = String(action).trim();
    if (!ACTION_RE.test(actionName)) {
      return { ok: false, status: 400, error: 'That action is not recognised.' };
    }
  }

  const pageParsed = blank(pageRaw)
    ? { ok: true, value: 1 }
    : parseWholeNumber(pageRaw, 'Page', MAX_PAGE);
  if (!pageParsed.ok) return pageParsed;
  const sizeParsed = blank(sizeRaw)
    ? { ok: true, value: paged ? DEFAULT_PAGE_SIZE : LEGACY_PAGE_SIZE }
    : parseWholeNumber(sizeRaw, 'Page size', MAX_PAGE_SIZE);
  if (!sizeParsed.ok) return sizeParsed;

  return {
    ok: true,
    page: pageParsed.value,
    pageSize: sizeParsed.value,
    testId,
    userId,
    userLabel,
    action: actionName,
  };
}

function compileFilters(accountId, parsed) {
  const params = [accountId];
  const clauses = ['l.account_id = $1'];
  if (parsed.testId) {
    params.push(parsed.testId);
    clauses.push(`l.target_type = 'experiment' AND l.target_id = $${params.length}`);
  }
  if (parsed.userId) {
    params.push(parsed.userId);
    clauses.push(`l.actor_user_id = $${params.length}`);
  } else if (parsed.userLabel) {
    params.push(parsed.userLabel);
    clauses.push(`l.actor_label = $${params.length}`);
  }
  if (parsed.action) {
    params.push(parsed.action);
    clauses.push(`l.action = $${params.length}`);
  }
  return { where: clauses.join(' AND '), params };
}

function mapEntry(row) {
  return {
    id: Number(row.id),
    account_id: row.account_id,
    actor_user_id: row.actor_user_id,
    actor_label: row.actor_label,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: row.detail || {},
    ip: row.ip,
    created_at: row.created_at,
    experiment_name: row.experiment_name || null,
  };
}

async function listAccountAudit(accountId, query) {
  if (!accountId) return { ok: false, status: 401, error: 'not authenticated' };
  const parsed = parseAuditQuery(query);
  if (!parsed.ok) return parsed;
  const { where, params } = compileFilters(accountId, parsed);
  const listParams = params.concat([parsed.pageSize, (parsed.page - 1) * parsed.pageSize]);
  const limit = params.length + 1;
  const offset = params.length + 2;
  const [rows, total, tests, members, labels, actions] = await Promise.all([
    db.query(
      `SELECT l.id, l.account_id, l.actor_user_id, l.actor_label, l.action,
              l.target_type, l.target_id, l.detail, l.ip, l.created_at,
              e.name AS experiment_name
       FROM audit_log l
       LEFT JOIN experiments e
         ON l.target_type = 'experiment'
        AND e.account_id = l.account_id
        AND e.id::text = l.target_id
       WHERE ${where}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $${limit} OFFSET $${offset}`,
      listParams
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM audit_log l WHERE ${where}`, params),
    db.query(
      `SELECT id, name FROM experiments WHERE account_id = $1 ORDER BY name, id`,
      [accountId]
    ),
    db.query(
      `SELECT u.id, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.account_id = $1
       ORDER BY u.email, u.id`,
      [accountId]
    ),
    db.query(
      `SELECT DISTINCT actor_label
       FROM audit_log
       WHERE account_id = $1
         AND actor_user_id IS NULL
         AND actor_label IS NOT NULL
         AND btrim(actor_label) <> ''
       ORDER BY actor_label`,
      [accountId]
    ),
    db.query(
      `SELECT DISTINCT action FROM audit_log WHERE account_id = $1 ORDER BY action`,
      [accountId]
    ),
  ]);

  const users = members.rows.map((row) => ({ value: row.id, label: row.email }));
  const seen = new Set(users.map((user) => user.value));
  labels.rows.forEach((row) => {
    if (seen.has(row.actor_label)) return;
    users.push({ value: row.actor_label, label: row.actor_label });
  });
  users.sort((a, b) => String(a.label).localeCompare(String(b.label), 'en-GB'));

  return {
    ok: true,
    entries: rows.rows.map(mapEntry),
    page: parsed.page,
    page_size: parsed.pageSize,
    total: total.rows[0].n,
    tests: tests.rows.map((row) => ({ id: row.id, name: row.name })),
    users,
    actions: actions.rows.map((row) => row.action),
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  LEGACY_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseAuditQuery,
  listAccountAudit,
};
