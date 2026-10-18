// Client portal reads. Snapshots and test setup only: no event counts,
// no Bayesian stats, no futility. Those run in the daily job.

const db = require('./db');
const { createPreviewToken, previewUrl } = require('./preview-access');
const { listItem, detailPayload, experimentPageUrl, formatLondonStamp } = require('./portal-view');
const { listVariantCounts, srmFor } = require('./experiment-plan');
const { splitCheckFromVariants } = require('./split-check');

function attachSplit(item, variants) {
  const rows = variants || [];
  item.splitCheck = splitCheckFromVariants(srmFor(rows), rows);
  item.srmDetected = !!(item.splitCheck && item.splitCheck.srmDetected);
  return item;
}

const CLIENT_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function listForClient(clientId, accountId, now = new Date()) {
  const { rows } = await db.query(
    `SELECT e.id, e.name, e.status, e.url_match, e.url_match_type, e.created_at,
            e.started_at, e.hypothesis, e.plan, e.peeked_at, e.goals, e.test_type,
            (SELECT COUNT(*)::int FROM variants v WHERE v.experiment_id = e.id AND v.enabled) AS variant_count,
            s.snapshot_date, s.headline_code, s.detail, s.created_at AS snapshot_created_at
     FROM experiments e
     LEFT JOIN LATERAL (
       SELECT snapshot_date, headline_code, detail, created_at
       FROM status_snapshots
       WHERE experiment_id = e.id AND account_id = e.account_id
       ORDER BY snapshot_date DESC
       LIMIT 1
     ) s ON true
     WHERE e.client_id = $1 AND e.account_id = $2
     ORDER BY e.url_match, e.created_at DESC`,
    [clientId, accountId]
  );
  let latest = null;
  const counts = await listVariantCounts(rows.map((row) => row.id));
  const experiments = rows.map((row) => {
    const snapshot = row.snapshot_date
      ? { headline_code: row.headline_code, detail: row.detail, created_at: row.snapshot_created_at }
      : null;
    if (snapshot && snapshot.created_at && (!latest || new Date(snapshot.created_at) > new Date(latest))) {
      latest = snapshot.created_at;
    }
    return attachSplit(listItem(row, snapshot, now), counts.get(row.id));
  });
  return {
    experiments,
    refreshed_label: latest ? formatLondonStamp(new Date(latest)) : null,
  };
}

async function owned(clientId, accountId, experimentId) {
  const { rows } = await db.query(
    `SELECT id, name, status, url_match, url_match_type, allowed_hosts, goals, goals_scope,
            plan, started_at, peeked_at, hypothesis, created_at, client_id, account_id, site_id, test_type
     FROM experiments
     WHERE id = $1 AND client_id = $2 AND account_id = $3`,
    [experimentId, clientId, accountId]
  );
  return rows[0] || null;
}

async function detailForClient(clientId, accountId, experimentId, now = new Date()) {
  const experiment = await owned(clientId, accountId, experimentId);
  if (!experiment) return null;
  const [snap, variants, review] = await Promise.all([
    db.query(
      `SELECT snapshot_date, headline_code, detail, created_at
       FROM status_snapshots
       WHERE experiment_id = $1 AND account_id = $2
       ORDER BY snapshot_date DESC
       LIMIT 1`,
      [experimentId, accountId]
    ),
    db.query(
      `SELECT id, name FROM variants
       WHERE experiment_id = $1 AND enabled
       ORDER BY created_at`,
      [experimentId]
    ),
    db.query(
      `SELECT created_at FROM review_requests
       WHERE experiment_id = $1 AND account_id = $2 AND client_id = $3 AND decided_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [experimentId, accountId, clientId]
    ),
  ]);
  const page = experimentPageUrl(experiment);
  const withPreview = variants.rows.map((variant) => {
    let preview_url = null;
    if (page && experiment.status !== 'archived') {
      const token = createPreviewToken(variant.id, CLIENT_PREVIEW_TTL_MS, Date.now(), {
        accountId: experiment.account_id,
        siteId: experiment.site_id,
      });
      preview_url = previewUrl(page, variant.id, token);
    }
    return { id: variant.id, name: variant.name, preview_url };
  });
  const detail = detailPayload({
    experiment,
    snapshot: snap.rows[0] || null,
    variants: withPreview,
    review: review.rows[0] || null,
    now,
  });
  const counts = await listVariantCounts([experimentId]);
  return attachSplit(detail, counts.get(experimentId));
}

module.exports = {
  CLIENT_PREVIEW_TTL_MS,
  listForClient,
  detailForClient,
  owned,
};
