// Count dataLayer events is off until a site switches it on. The snippet
// only hears about it when the flag is true. A missing site, or a legacy
// tag with no site, stays off.

const TYPE_ERROR = 'Say whether dataLayer events count.';

function parseDatalayerEventsUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: TYPE_ERROR };
  }
  if (typeof body.datalayer_events !== 'boolean') {
    return { ok: false, status: 400, error: TYPE_ERROR };
  }
  return { ok: true, datalayer_events: body.datalayer_events };
}

async function publicDatalayerEvents(db, scope) {
  if (!scope || scope.ok === false || !scope.siteId) return false;
  const { rows } = await db.query(
    `SELECT datalayer_events FROM sites WHERE id = $1 AND account_id = $2`,
    [scope.siteId, scope.accountId]
  );
  return !!(rows[0] && rows[0].datalayer_events === true);
}

module.exports = {
  TYPE_ERROR,
  parseDatalayerEventsUpdate,
  publicDatalayerEvents,
};
