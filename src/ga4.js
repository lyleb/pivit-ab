// Send to GA4 is a paid feature. pivitlab has no priced plans yet, so a
// Platform admin marks an agency with paid_plan. A site then stores its own
// GA4 measurement ID and whether the snippet should send. The snippet never
// receives the ID unless both switches are on and the ID is valid.

const MEASUREMENT_ID = /^G-[A-Z0-9]{6,12}$/;

const MEASUREMENT_ID_ERROR = 'Enter a GA4 measurement ID that starts with G-.';
const PAID_PLAN_ERROR = 'Send to GA4 is on paid plans. This agency does not have it yet.';
const ENABLED_TYPE_ERROR = 'Say whether Send to GA4 is on.';
const EMPTY_ID_ERROR = 'Enter a GA4 measurement ID, such as G-XXXXXXXXXX, before switching Send to GA4 on.';
const NOTHING_ERROR = 'Nothing to save.';
const PAID_FLAG_ERROR = 'Say whether this agency is on a paid plan.';

// '' means empty. null means the text is not a measurement ID.
function normaliseMeasurementId(value) {
  if (value == null) return '';
  const text = String(value).trim().toUpperCase();
  if (!text) return '';
  if (!MEASUREMENT_ID.test(text)) return null;
  return text;
}

function publicGa4Config(row) {
  if (!row || row.paid_plan !== true || row.ga4_enabled !== true) return null;
  const id = normaliseMeasurementId(row.ga4_measurement_id);
  if (!id) return null;
  return { measurement_id: id };
}

function parseGa4Update(body, existing, paid) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: NOTHING_ERROR };
  }
  const hasId = Object.prototype.hasOwnProperty.call(body, 'measurement_id');
  const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'enabled');
  if (!hasId && !hasEnabled) return { ok: false, status: 400, error: NOTHING_ERROR };

  let id = existing && existing.ga4_measurement_id ? String(existing.ga4_measurement_id) : '';
  if (hasId) {
    if (body.measurement_id != null && typeof body.measurement_id !== 'string') {
      return { ok: false, status: 400, error: MEASUREMENT_ID_ERROR };
    }
    const parsed = normaliseMeasurementId(body.measurement_id);
    if (parsed == null) return { ok: false, status: 400, error: MEASUREMENT_ID_ERROR };
    id = parsed;
  }

  let enabled = !!(existing && existing.ga4_enabled === true);
  if (hasEnabled) {
    if (typeof body.enabled !== 'boolean') {
      return { ok: false, status: 400, error: ENABLED_TYPE_ERROR };
    }
    enabled = body.enabled;
  }

  if (enabled && !id) return { ok: false, status: 400, error: EMPTY_ID_ERROR };
  if (enabled && paid !== true) return { ok: false, status: 403, error: PAID_PLAN_ERROR };
  return { ok: true, measurement_id: id || null, enabled };
}

function parsePaidPlan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.paid_plan !== 'boolean') {
    return { ok: false, status: 400, error: PAID_FLAG_ERROR };
  }
  return { ok: true, paid_plan: body.paid_plan };
}

async function accountPaidPlan(db, accountId) {
  const { rows } = await db.query(
    `SELECT paid_plan FROM accounts WHERE id = $1`,
    [accountId]
  );
  return !!(rows[0] && rows[0].paid_plan === true);
}

async function publicGa4ForScope(db, scope) {
  if (!scope || scope.ok === false || !scope.siteId) return null;
  const { rows } = await db.query(
    `SELECT s.ga4_enabled, s.ga4_measurement_id, a.paid_plan
     FROM sites s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.id = $1 AND s.account_id = $2`,
    [scope.siteId, scope.accountId]
  );
  return publicGa4Config(rows[0]);
}

async function ga4Uptake(db) {
  const total = await db.query(
    `SELECT COUNT(*)::int AS n FROM sites WHERE ga4_enabled`
  );
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.paid_plan,
            COUNT(s.id) FILTER (WHERE s.ga4_enabled)::int AS sites_on
     FROM accounts a
     LEFT JOIN sites s ON s.account_id = a.id
     GROUP BY a.id
     ORDER BY a.name, a.id`
  );
  return {
    sites_on: total.rows[0] ? Number(total.rows[0].n) || 0 : 0,
    agencies: rows.map((row) => ({
      id: row.id,
      name: row.name,
      paid_plan: row.paid_plan === true,
      sites_on: Number(row.sites_on) || 0,
    })),
  };
}

module.exports = {
  MEASUREMENT_ID,
  MEASUREMENT_ID_ERROR,
  PAID_PLAN_ERROR,
  ENABLED_TYPE_ERROR,
  EMPTY_ID_ERROR,
  NOTHING_ERROR,
  PAID_FLAG_ERROR,
  normaliseMeasurementId,
  publicGa4Config,
  parseGa4Update,
  parsePaidPlan,
  accountPaidPlan,
  publicGa4ForScope,
  ga4Uptake,
};
