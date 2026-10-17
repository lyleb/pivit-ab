// A client can ask for a review. That notifies the account owner and writes
// an audit row. It does not stop the test, reveal a result, or change the
// plan. Email is best-effort: a Postmark failure is stored and does not
// fail the request.

const db = require('./db');
const { recordAudit } = require('./audit');
const { sendEmail } = require('./mailer');
const { appUrl } = require('./app-origin');
const { formatLondonDay, londonDateISO } = require('./clock');

async function ownerEmails(accountId) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.email
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.account_id = $1
       AND m.role = 'owner'
       AND u.email <> ''`,
    [accountId]
  );
  return rows.map((row) => row.email).filter(Boolean);
}

async function openRequest(experimentId, accountId) {
  const { rows } = await db.query(
    `SELECT id, created_at, email_sent
     FROM review_requests
     WHERE experiment_id = $1 AND account_id = $2 AND decided_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [experimentId, accountId]
  );
  return rows[0] || null;
}

async function notifyOwners({ emails, experiment, clientName }) {
  const link = appUrl('/');
  const subject = `Review requested: ${experiment.name}`;
  const text = [
    `${clientName} asked for a review of "${experiment.name}".`,
    '',
    'They cannot reveal the result themselves. You decide whether anything changes. Stopping a test early is still your action, and it is logged.',
    '',
    `Open pivitlab: ${link}`,
  ].join('\n');
  let sent = 0;
  let failed = 0;
  let lastError = '';
  for (const email of emails) {
    try {
      const result = await sendEmail({ to: email, subject, text });
      if (result && result.error) {
        failed += 1;
        lastError = 'email was rejected';
      } else {
        sent += 1;
      }
    } catch (err) {
      failed += 1;
      lastError = err && err.message ? err.message : 'email failed';
      console.error('Review request email failed:', lastError);
    }
  }
  return { sent, failed, lastError };
}

async function requestReview({ experiment, clientId, clientName, accountId, ip }) {
  const existing = await openRequest(experiment.id, accountId);
  if (existing) {
    return {
      ok: true,
      created: false,
      id: existing.id,
      requested_at: existing.created_at,
      requested_label: formatLondonDay(londonDateISO(new Date(existing.created_at))),
    };
  }

  let row;
  try {
    const inserted = await db.query(
      `INSERT INTO review_requests (account_id, experiment_id, client_id)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [accountId, experiment.id, clientId]
    );
    row = inserted.rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      const again = await openRequest(experiment.id, accountId);
      if (again) {
        return {
          ok: true,
          created: false,
          id: again.id,
          requested_at: again.created_at,
          requested_label: formatLondonDay(londonDateISO(new Date(again.created_at))),
        };
      }
    }
    throw err;
  }

  await recordAudit(db, {
    accountId,
    actorLabel: clientName || 'client',
    action: 'review_request',
    targetType: 'experiment',
    targetId: experiment.id,
    detail: {
      review_request_id: row.id,
      experiment_name: experiment.name,
      client_id: clientId,
    },
    ip,
  });

  let emailSent = false;
  let emailError = null;
  try {
    const emails = await ownerEmails(accountId);
    if (emails.length) {
      const notice = await notifyOwners({
        emails,
        experiment,
        clientName: clientName || 'A viewer',
      });
      emailSent = notice.sent > 0;
      if (!emailSent) emailError = notice.lastError || 'email was not sent';
    }
  } catch (err) {
    emailError = err && err.message ? err.message : 'email failed';
    console.error('Review request notification failed:', emailError);
  }

  if (emailSent || emailError) {
    try {
      await db.query(
        `UPDATE review_requests SET email_sent = $2, email_error = $3 WHERE id = $1`,
        [row.id, emailSent, emailError]
      );
    } catch (err) {
      console.error('Could not store the review email result:', err.message);
    }
  }

  return {
    ok: true,
    created: true,
    id: row.id,
    requested_at: row.created_at,
    requested_label: formatLondonDay(londonDateISO(new Date(row.created_at))),
  };
}

async function listOpenReviews(accountId) {
  const { rows } = await db.query(
    `SELECT r.id, r.experiment_id, r.created_at, c.name AS client_name, e.name AS experiment_name
     FROM review_requests r
     JOIN experiments e ON e.id = r.experiment_id AND e.account_id = r.account_id
     JOIN clients c ON c.id = r.client_id
     WHERE r.account_id = $1 AND r.decided_at IS NULL
     ORDER BY r.created_at DESC`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    experiment_id: row.experiment_id,
    experiment_name: row.experiment_name,
    client_name: row.client_name,
    created_at: row.created_at,
    requested_label: formatLondonDay(londonDateISO(new Date(row.created_at))),
  }));
}

async function decideReview({ requestId, accountId, actor, ip }) {
  const { rows } = await db.query(
    `UPDATE review_requests
     SET decided_at = now(), decided_by = $3
     WHERE id = $1 AND account_id = $2 AND decided_at IS NULL
     RETURNING id, experiment_id, created_at`,
    [requestId, accountId, actor || 'owner']
  );
  if (!rows.length) return null;
  await recordAudit(db, {
    accountId,
    actorLabel: actor || 'owner',
    action: 'review_decided',
    targetType: 'experiment',
    targetId: rows[0].experiment_id,
    detail: {
      review_request_id: rows[0].id,
      decision: 'seen',
      stopped: false,
    },
    ip,
  });
  return rows[0];
}

module.exports = {
  requestReview,
  listOpenReviews,
  decideReview,
  openRequest,
  ownerEmails,
};
