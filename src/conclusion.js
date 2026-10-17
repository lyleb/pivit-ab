// Owner drafts a conclusion from the stored daily result, then releases it.
// Client viewers see a conclusion only after release, and they approve with
// a click. Stats are never recalculated here.

const db = require('./db');
const { recordAudit } = require('./audit');
const { sendEmail } = require('./mailer');
const { ownerEmails } = require('./review-request');
const { appUrl } = require('./app-origin');
const { londonDateISO, formatLondonStamp } = require('./clock');
const { freezeConclusion, conclusionPdf, approvalPdf, pdfNames, sendPdf } = require('./conclusion-doc');

const MISSING = 'no experiment found with that id';
const NO_STORED_RESULT = 'No stored result yet. The conclusion uses the daily result and does not calculate a new one.';
const ALREADY_RELEASED = 'This conclusion is already released. The released document stays as it is.';

function postmarkConfigured() {
  return Boolean(String(process.env.POSTMARK_SERVER_TOKEN || '').trim());
}

function stamp(value) {
  if (!value) return '';
  return formatLondonStamp(new Date(value));
}

async function loadExperiment(accountId, experimentId) {
  const { rows } = await db.query(
    `SELECT id, name, status, hypothesis, url_match, url_match_type, allowed_hosts,
            goals, peeked_at, client_id, account_id, test_type
     FROM experiments
     WHERE id = $1 AND account_id = $2`,
    [experimentId, accountId]
  );
  return rows[0] || null;
}

async function loadClientExperiment(clientId, accountId, experimentId) {
  const { rows } = await db.query(
    `SELECT id, name, client_id, account_id, test_type
     FROM experiments
     WHERE id = $1 AND client_id = $2 AND account_id = $3`,
    [experimentId, clientId, accountId]
  );
  return rows[0] || null;
}

async function latestSnapshot(accountId, experimentId) {
  const { rows } = await db.query(
    `SELECT snapshot_date::text AS snapshot_date, detail
     FROM status_snapshots
     WHERE experiment_id = $1 AND account_id = $2
     ORDER BY snapshot_date DESC
     LIMIT 1`,
    [experimentId, accountId]
  );
  return rows[0] || null;
}

async function reportFor(accountId, experimentId) {
  const { rows } = await db.query(
    `SELECT id, account_id, experiment_id, status, snapshot_date::text AS snapshot_date,
            content, created_at, created_by, released_at, released_by
     FROM conclusion_reports
     WHERE account_id = $1 AND experiment_id = $2`,
    [accountId, experimentId]
  );
  return rows[0] || null;
}

async function releasedReport(accountId, experimentId) {
  const { rows } = await db.query(
    `SELECT id, account_id, experiment_id, status, content, released_at, released_by
     FROM conclusion_reports
     WHERE account_id = $1 AND experiment_id = $2 AND status = 'released'`,
    [accountId, experimentId]
  );
  return rows[0] || null;
}

async function approvalFor(accountId, reportId, clientId) {
  const params = [accountId, reportId];
  let clientSql = '';
  if (clientId) {
    params.push(clientId);
    clientSql = ` AND client_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT id, report_id, client_id, approver_name, approved_at
     FROM conclusion_approvals
     WHERE account_id = $1 AND report_id = $2${clientSql}
     ORDER BY approved_at DESC
     LIMIT 1`,
    params
  );
  return rows[0] || null;
}

function publicReport(row) {
  if (!row) return null;
  return {
    status: row.status,
    created_label: stamp(row.created_at),
    released_label: row.released_at ? stamp(row.released_at) : '',
  };
}

function publicApproval(row) {
  if (!row) return null;
  return {
    approver_name: row.approver_name,
    approved_label: stamp(row.approved_at),
  };
}

async function conclusionStatus(accountId, experimentId) {
  const experiment = await loadExperiment(accountId, experimentId);
  if (!experiment) return null;
  const [snapshot, report] = await Promise.all([
    latestSnapshot(accountId, experimentId),
    reportFor(accountId, experimentId),
  ]);
  const stored = freezeConclusion(experiment, snapshot, londonDateISO(new Date()));
  const approval = report ? await approvalFor(accountId, report.id) : null;
  return {
    available: !!stored,
    unavailable_reason: stored ? null : NO_STORED_RESULT,
    report: publicReport(report),
    approval: publicApproval(approval),
  };
}

async function draftConclusion({ accountId, experimentId, actor, userId, ip }) {
  const experiment = await loadExperiment(accountId, experimentId);
  if (!experiment) return { error: 'missing' };
  const snapshot = await latestSnapshot(accountId, experimentId);
  const content = freezeConclusion(experiment, snapshot, londonDateISO(new Date()));
  if (!content) return { error: 'unavailable', message: NO_STORED_RESULT };

  const existing = await reportFor(accountId, experimentId);
  if (existing && existing.status === 'released') {
    return { error: 'released', message: ALREADY_RELEASED, report: publicReport(existing) };
  }

  let row;
  if (existing) {
    const updated = await db.query(
      `UPDATE conclusion_reports
       SET content = $3::jsonb, snapshot_date = $4::date, created_at = now(), created_by = $5
       WHERE id = $1 AND account_id = $2 AND status = 'draft'
       RETURNING id, status, created_at, released_at`,
      [existing.id, accountId, JSON.stringify(content), snapshot.snapshot_date || null, actor || 'owner']
    );
    row = updated.rows[0];
  } else {
    const inserted = await db.query(
      `INSERT INTO conclusion_reports
         (account_id, experiment_id, status, snapshot_date, content, created_by)
       VALUES ($1, $2, 'draft', $3::date, $4::jsonb, $5)
       RETURNING id, status, created_at, released_at`,
      [accountId, experimentId, snapshot.snapshot_date || null, JSON.stringify(content), actor || 'owner']
    );
    row = inserted.rows[0];
  }
  if (!row) return { error: 'released', message: ALREADY_RELEASED };

  await recordAudit(db, {
    accountId,
    userId,
    actorLabel: actor || 'owner',
    action: 'conclusion_drafted',
    targetType: 'experiment',
    targetId: experimentId,
    detail: {
      report_id: row.id,
      snapshot_date: snapshot.snapshot_date || null,
    },
    ip,
  });

  return {
    ok: true,
    report: publicReport(row),
  };
}

async function releaseConclusion({ accountId, experimentId, actor, userId, ip }) {
  const experiment = await loadExperiment(accountId, experimentId);
  if (!experiment) return { error: 'missing' };
  const existing = await reportFor(accountId, experimentId);
  if (!existing) return { error: 'missing' };
  if (existing.status === 'released') {
    return { ok: true, already: true, report: publicReport(existing) };
  }
  const { rows } = await db.query(
    `UPDATE conclusion_reports
     SET status = 'released', released_at = now(), released_by = $3
     WHERE id = $1 AND account_id = $2 AND status = 'draft'
     RETURNING id, status, created_at, released_at`,
    [existing.id, accountId, actor || 'owner']
  );
  if (!rows[0]) return { error: 'missing' };
  await recordAudit(db, {
    accountId,
    userId,
    actorLabel: actor || 'owner',
    action: 'conclusion_released',
    targetType: 'experiment',
    targetId: experimentId,
    detail: { report_id: rows[0].id },
    ip,
  });
  return { ok: true, already: false, report: publicReport(rows[0]) };
}

async function ownerPdf(accountId, experimentId, kind) {
  const experiment = await loadExperiment(accountId, experimentId);
  if (!experiment) return null;
  const report = await reportFor(accountId, experimentId);
  if (!report) return null;
  if (kind === 'approval') {
    if (report.status !== 'released') return null;
    const approval = await approvalFor(accountId, report.id);
    if (!approval) return null;
    const bytes = approvalPdf({
      experimentName: experiment.name,
      approverName: approval.approver_name,
      approvedAt: approval.approved_at,
      releasedAt: report.released_at,
      demo: experiment.test_type === 'demo',
    });
    return { bytes, names: pdfNames(experiment.name, 'approval', approval.approved_at) };
  }
  const content = Object.assign({}, report.content);
  if (experiment.test_type === 'demo') content.demo = true;
  const bytes = conclusionPdf(content);
  return { bytes, names: pdfNames(experiment.name, 'conclusion', report.created_at) };
}

async function clientConclusionView(clientId, accountId, experimentId) {
  const experiment = await loadClientExperiment(clientId, accountId, experimentId);
  if (!experiment) return { missing: true };
  const report = await releasedReport(accountId, experimentId);
  if (!report) return { conclusion: null };
  const approval = await approvalFor(accountId, report.id, clientId);
  return {
    conclusion: {
      released: true,
      released_label: stamp(report.released_at),
      approval: publicApproval(approval),
    },
  };
}

async function clientPdf(clientId, accountId, experimentId, kind) {
  const experiment = await loadClientExperiment(clientId, accountId, experimentId);
  if (!experiment) return null;
  const report = await releasedReport(accountId, experimentId);
  if (!report) return null;
  if (kind === 'approval') {
    const approval = await approvalFor(accountId, report.id, clientId);
    if (!approval) return null;
    const bytes = approvalPdf({
      experimentName: experiment.name,
      approverName: approval.approver_name,
      approvedAt: approval.approved_at,
      releasedAt: report.released_at,
      demo: experiment.test_type === 'demo',
    });
    return { bytes, names: pdfNames(experiment.name, 'approval', approval.approved_at) };
  }
  const content = Object.assign({}, report.content);
  if (experiment.test_type === 'demo') content.demo = true;
  const bytes = conclusionPdf(content);
  return { bytes, names: pdfNames(experiment.name, 'conclusion', report.released_at || report.created_at) };
}

async function insertNotice({ accountId, experimentId, title, body }) {
  const { rows } = await db.query(
    `INSERT INTO owner_notices (account_id, kind, title, body, experiment_id)
     VALUES ($1, 'conclusion_approved', $2, $3, $4)
     RETURNING id`,
    [accountId, title, body, experimentId]
  );
  return rows[0];
}

async function notifyOwner({ accountId, experiment, clientName, whenLabel }) {
  const title = 'Conclusion approved';
  const body = `${clientName} approved the conclusion for "${experiment.name}" on ${whenLabel}.`;
  if (postmarkConfigured()) {
    try {
      const emails = await ownerEmails(accountId);
      let sent = false;
      const subject = `Conclusion approved: ${experiment.name}`;
      const text = [
        body,
        '',
        'The approval is recorded in pivitlab. Open the test to download the record.',
        '',
        `Open pivitlab: ${appUrl('/')}`,
      ].join('\n');
      for (const email of emails) {
        const result = await sendEmail({ to: email, subject, text });
        if (result && result.sent) sent = true;
      }
      if (sent) return { channel: 'email' };
    } catch (err) {
      console.error('Conclusion approval email failed:', err && err.message ? err.message : err);
    }
  }
  const notice = await insertNotice({
    accountId,
    experimentId: experiment.id,
    title,
    body,
  });
  return { channel: 'notice', noticeId: notice.id };
}

async function approveConclusion({ clientId, accountId, experimentId, ip }) {
  const experiment = await loadClientExperiment(clientId, accountId, experimentId);
  if (!experiment) return { error: 'missing' };
  const report = await releasedReport(accountId, experimentId);
  if (!report) return { error: 'missing' };
  const client = await db.query(
    `SELECT name FROM clients WHERE id = $1 AND account_id = $2`,
    [clientId, accountId]
  );
  const approverName = client.rows[0] ? client.rows[0].name : 'Viewer';
  const existing = await approvalFor(accountId, report.id, clientId);
  if (existing) {
    return {
      ok: true,
      already: true,
      approver_name: existing.approver_name,
      approved_at: existing.approved_at,
      approved_label: stamp(existing.approved_at),
    };
  }

  let row;
  try {
    const inserted = await db.query(
      `INSERT INTO conclusion_approvals
         (account_id, experiment_id, report_id, client_id, approver_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, approver_name, approved_at`,
      [accountId, experimentId, report.id, clientId, approverName]
    );
    row = inserted.rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      const again = await approvalFor(accountId, report.id, clientId);
      if (again) {
        return {
          ok: true,
          already: true,
          approver_name: again.approver_name,
          approved_at: again.approved_at,
          approved_label: stamp(again.approved_at),
        };
      }
    }
    throw err;
  }

  await recordAudit(db, {
    accountId,
    actorLabel: approverName,
    action: 'conclusion_approved',
    targetType: 'experiment',
    targetId: experimentId,
    detail: {
      report_id: report.id,
      client_id: clientId,
      approver_name: approverName,
      approved_at: row.approved_at,
    },
    ip,
  });

  let channel = 'notice';
  try {
    const notice = await notifyOwner({
      accountId,
      experiment,
      clientName: approverName,
      whenLabel: stamp(row.approved_at),
    });
    channel = notice.channel;
  } catch (err) {
    console.error('Conclusion approval notice failed:', err && err.message ? err.message : err);
    try {
      await insertNotice({
        accountId,
        experimentId: experiment.id,
        title: 'Conclusion approved',
        body: `${approverName} approved the conclusion for "${experiment.name}" on ${stamp(row.approved_at)}.`,
      });
    } catch (noticeErr) {
      console.error('Could not store the approval notice:', noticeErr.message);
    }
  }

  return {
    ok: true,
    already: false,
    channel,
    approver_name: row.approver_name,
    approved_at: row.approved_at,
    approved_label: stamp(row.approved_at),
  };
}

async function listNotices(accountId) {
  const { rows } = await db.query(
    `SELECT id, kind, title, body, experiment_id, created_at
     FROM owner_notices
     WHERE account_id = $1 AND read_at IS NULL
     ORDER BY created_at DESC
     LIMIT 20`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    experiment_id: row.experiment_id,
    created_label: stamp(row.created_at),
  }));
}

async function markNoticeRead(accountId, noticeId) {
  const { rows } = await db.query(
    `UPDATE owner_notices
     SET read_at = now()
     WHERE id = $1 AND account_id = $2 AND read_at IS NULL
     RETURNING id`,
    [noticeId, accountId]
  );
  return rows[0] || null;
}

function deliverPdf(res, file) {
  if (!file) return false;
  sendPdf(res, file.names, file.bytes);
  return true;
}

module.exports = {
  MISSING,
  NO_STORED_RESULT,
  ALREADY_RELEASED,
  postmarkConfigured,
  conclusionStatus,
  draftConclusion,
  releaseConclusion,
  ownerPdf,
  clientConclusionView,
  clientPdf,
  approveConclusion,
  listNotices,
  markNoticeRead,
  deliverPdf,
};
