// Test traffic: flagged, left out of results unless the owner asks, and
// removable without a hard delete.
//
// A visitor or event is test traffic when any of these is true:
//   - visitor_id starts with v_pt (the existing fake-traffic prefix)
//   - the customer page had pivit_qa=1, which the snippet stores and sends
//     back as JSON is_test: true, or as ?pivit_qa=1 on its own API calls
//   - the request header X-Pivit-Test is 1, true, or yes
//
// The live snippet uses sendBeacon, which cannot set a request header.
// Today's beacons already use Content-Type: application/json, so browsers
// preflight them; the cors middleware reflects Access-Control-Request-Headers,
// and a beacon that does not send X-Pivit-Test is unchanged. The snippet
// therefore sends the JSON field and does not add the header. Direct clients
// (curl, the box tester) may send the header instead.

const db = require('./db');
const { recordAudit } = require('./audit');

const TEST_VISITOR_PREFIX = 'v_pt';
const MIN_PREFIX_LENGTH = 4;
const MAX_PREFIX_LENGTH = 64;

function flagIsOn(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function visitorIsTest(visitorId) {
  return typeof visitorId === 'string' && visitorId.startsWith(TEST_VISITOR_PREFIX);
}

function headerOf(req, name) {
  if (req && typeof req.get === 'function') {
    const value = req.get(name);
    if (value) return Array.isArray(value) ? value[0] : value;
  }
  const headers = req && req.headers;
  if (!headers) return '';
  const raw = headers[String(name).toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || '';
  return raw || '';
}

function refererHasQaFlag(value) {
  if (!value) return false;
  try {
    return flagIsOn(new URL(String(value)).searchParams.get('pivit_qa'));
  } catch (err) {
    return false;
  }
}

// True when this request should be stored as test traffic and left out of
// the host-hit counter. Missing fields are not test traffic.
function requestIsTestTraffic(req) {
  if (!req) return false;
  if (flagIsOn(headerOf(req, 'x-pivit-test'))) return true;
  const query = req.query || {};
  if (flagIsOn(query.pivit_qa)) return true;
  if (refererHasQaFlag(headerOf(req, 'referer') || headerOf(req, 'referrer'))) return true;
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (flagIsOn(body.is_test) || flagIsOn(body.pivit_qa)) return true;
    if (visitorIsTest(body.visitor_id)) return true;
  }
  return false;
}

function normalisePrefix(raw) {
  const prefix = String(raw == null ? '' : raw).trim();
  if (prefix.length < MIN_PREFIX_LENGTH || prefix.length > MAX_PREFIX_LENGTH) {
    return { ok: false, error: 'Enter a visitor ID prefix of 4 to 64 characters, using letters, digits, underscores or hyphens.' };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
    return { ok: false, error: 'Enter a visitor ID prefix of 4 to 64 characters, using letters, digits, underscores or hyphens.' };
  }
  return { ok: true, prefix };
}

function parseCriteria(body) {
  const mode = body && (body.mode || body.type);
  if (mode === 'test') return { ok: true, mode: 'test', prefix: null };
  if (mode === 'prefix') {
    const parsed = normalisePrefix(body && body.prefix);
    if (!parsed.ok) return parsed;
    return { ok: true, mode: 'prefix', prefix: parsed.prefix };
  }
  return { ok: false, error: 'mode must be test or prefix' };
}

function parseDirection(value) {
  if (value == null || value === '' || value === 'remove') return 'remove';
  if (value === 'restore') return 'restore';
  return null;
}

function isConfirmed(body) {
  return !!(body && body.confirm === true);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matchSql(criteria, params) {
  if (criteria.mode === 'test') return 'e.is_test = true';
  params.push(criteria.prefix);
  return `left(e.visitor_id, char_length($${params.length})) = $${params.length}`;
}

async function experimentExists(query, experimentId, accountId) {
  const params = [experimentId];
  let accountSql = '';
  if (accountId) {
    params.push(accountId);
    accountSql = ` AND account_id = $${params.length}`;
  }
  const { rows } = await query(`SELECT id FROM experiments WHERE id = $1${accountSql}`, params);
  return rows.length > 0;
}

async function previewTestTraffic(experimentId, criteria, direction, query = db.query.bind(db), accountId) {
  if (!UUID_RE.test(experimentId)) return { ok: false, status: 400, error: 'experiment id must be a UUID' };
  if (!(await experimentExists(query, experimentId, accountId))) {
    return { ok: false, status: 404, error: 'no experiment found with that id' };
  }
  const params = [experimentId];
  const match = matchSql(criteria, params);
  const state = direction === 'restore' ? 'e.excluded_at IS NOT NULL' : 'e.excluded_at IS NULL';
  const { rows } = await query(
    `SELECT v.id AS variant_id, v.name AS variant_name,
       COUNT(DISTINCT e.visitor_id) FILTER (WHERE e.id IS NOT NULL)::int AS visitors,
       COUNT(e.id)::int AS events
     FROM variants v
     LEFT JOIN events e
       ON e.variant_id = v.id
      AND e.experiment_id = v.experiment_id
      AND ${state}
      AND ${match}
     WHERE v.experiment_id = $1
     GROUP BY v.id, v.name
     ORDER BY v.name`,
    params
  );
  const variants = rows.map((row) => ({
    variant_id: row.variant_id,
    variant_name: row.variant_name,
    visitors: Number(row.visitors) || 0,
    events: Number(row.events) || 0,
  }));
  const distinct = await query(
    `SELECT COUNT(DISTINCT e.visitor_id)::int AS visitors, COUNT(e.id)::int AS events
     FROM events e
     WHERE e.experiment_id = $1 AND ${state} AND ${match}`,
    params
  );
  const totals = distinct.rows[0] || {};
  return {
    ok: true,
    mode: criteria.mode,
    prefix: criteria.prefix,
    direction,
    visitors: Number(totals.visitors) || 0,
    events: Number(totals.events) || 0,
    variants,
  };
}

function countsFromUpdated(rows) {
  const visitors = new Set();
  const byVariant = new Map();
  for (const row of rows) {
    visitors.add(row.visitor_id);
    if (!byVariant.has(row.variant_id)) {
      byVariant.set(row.variant_id, {
        variant_id: row.variant_id,
        variant_name: row.variant_name,
        visitors: new Set(),
        events: 0,
      });
    }
    const bucket = byVariant.get(row.variant_id);
    bucket.visitors.add(row.visitor_id);
    bucket.events += 1;
  }
  const variants = [...byVariant.values()]
    .map((bucket) => ({
      variant_id: bucket.variant_id,
      variant_name: bucket.variant_name,
      visitors: bucket.visitors.size,
      events: bucket.events,
    }))
    .sort((a, b) => String(a.variant_name).localeCompare(String(b.variant_name)));
  return { visitors: visitors.size, events: rows.length, variants };
}

async function applyTestTraffic({ experimentId, criteria, direction, actor, actorIp, queryPool = db.pool, accountId }) {
  if (!UUID_RE.test(experimentId)) return { ok: false, status: 400, error: 'experiment id must be a UUID' };
  const client = await queryPool.connect();
  try {
    await client.query('BEGIN');
    if (!(await experimentExists(client.query.bind(client), experimentId, accountId))) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'no experiment found with that id' };
    }
    const params = [experimentId];
    const match = matchSql(criteria, params);
    const state = direction === 'restore' ? 'e.excluded_at IS NOT NULL' : 'e.excluded_at IS NULL';
    const assignment = direction === 'restore' ? 'excluded_at = NULL' : 'excluded_at = now()';
    const updated = await client.query(
      `UPDATE events AS e
       SET ${assignment}
       FROM variants v
       WHERE e.variant_id = v.id
         AND e.experiment_id = $1
         AND ${state}
         AND ${match}
       RETURNING e.id, e.variant_id, e.visitor_id, v.name AS variant_name`,
      params
    );
    const counts = countsFromUpdated(updated.rows);
    if (counts.events === 0) {
      await client.query('COMMIT');
      return {
        ok: true,
        changed: false,
        mode: criteria.mode,
        prefix: criteria.prefix,
        direction,
        ...counts,
      };
    }
    const criteriaJson = { mode: criteria.mode };
    if (criteria.prefix) criteriaJson.prefix = criteria.prefix;
    const audit = await client.query(
      `INSERT INTO test_traffic_audit
         (experiment_id, action, actor, actor_ip, criteria, visitor_count, event_count, variant_counts)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
       RETURNING id, created_at`,
      [
        experimentId,
        direction,
        actor || 'owner',
        actorIp || null,
        JSON.stringify(criteriaJson),
        counts.visitors,
        counts.events,
        JSON.stringify(counts.variants),
      ]
    );
    let scopedAccount = accountId;
    if (!scopedAccount) {
      const owner = await client.query(`SELECT account_id FROM experiments WHERE id = $1`, [experimentId]);
      scopedAccount = owner.rows[0] ? owner.rows[0].account_id : null;
    }
    await recordAudit(client, {
      accountId: scopedAccount,
      actorLabel: actor || 'owner',
      action: direction === 'restore' ? 'test_traffic_restore' : 'test_traffic_remove',
      targetType: 'experiment',
      targetId: experimentId,
      detail: {
        criteria: criteriaJson,
        visitor_count: counts.visitors,
        event_count: counts.events,
        variant_counts: counts.variants,
        source_audit_id: Number(audit.rows[0].id),
      },
      ip: actorIp,
    });
    await client.query('COMMIT');
    return {
      ok: true,
      changed: true,
      audit_id: audit.rows[0].id,
      created_at: audit.rows[0].created_at,
      mode: criteria.mode,
      prefix: criteria.prefix,
      direction,
      ...counts,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
    throw err;
  } finally {
    client.release();
  }
}

async function listTestTrafficAudit(experimentId, query = db.query.bind(db), accountId) {
  if (!UUID_RE.test(experimentId)) return { ok: false, status: 400, error: 'experiment id must be a UUID' };
  if (!(await experimentExists(query, experimentId, accountId))) {
    return { ok: false, status: 404, error: 'no experiment found with that id' };
  }
  const { rows } = await query(
    `SELECT id, action, actor, actor_ip, criteria, visitor_count, event_count, variant_counts, created_at
     FROM test_traffic_audit
     WHERE experiment_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 100`,
    [experimentId]
  );
  return {
    ok: true,
    entries: rows.map((row) => ({
      id: Number(row.id),
      action: row.action,
      actor: row.actor,
      actor_ip: row.actor_ip || null,
      criteria: row.criteria,
      visitor_count: Number(row.visitor_count) || 0,
      event_count: Number(row.event_count) || 0,
      variant_counts: row.variant_counts || [],
      created_at: row.created_at,
    })),
  };
}

async function summariseTestTraffic(experimentId, query = db.query.bind(db)) {
  const { rows } = await query(
    `SELECT
       COUNT(DISTINCT visitor_id) FILTER (WHERE is_test)::int AS visitors,
       COUNT(DISTINCT visitor_id) FILTER (WHERE is_test AND excluded_at IS NOT NULL)::int AS removed_visitors,
       COUNT(*) FILTER (WHERE is_test)::int AS events
     FROM events
     WHERE experiment_id = $1`,
    [experimentId]
  );
  const row = rows[0] || {};
  return {
    visitors: Number(row.visitors) || 0,
    removed_visitors: Number(row.removed_visitors) || 0,
    events: Number(row.events) || 0,
  };
}

module.exports = {
  TEST_VISITOR_PREFIX,
  MIN_PREFIX_LENGTH,
  flagIsOn,
  visitorIsTest,
  refererHasQaFlag,
  requestIsTestTraffic,
  normalisePrefix,
  parseCriteria,
  parseDirection,
  isConfirmed,
  previewTestTraffic,
  applyTestTraffic,
  listTestTrafficAudit,
  summariseTestTraffic,
};
