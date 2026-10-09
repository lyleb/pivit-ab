// Status changes the owner can ask for. Archived is not a side effect of
// Start or Pause: the body has to say archive: true, which only the Archive
// button sends.

const STATUSES = ['draft', 'running', 'paused', 'archived'];

function normaliseStatusChange(current, body) {
  const status = body && body.status;
  if (!STATUSES.includes(status)) {
    return { ok: false, statusCode: 400, error: `status must be one of ${STATUSES.join(', ')}` };
  }
  if (status === 'archived' && (!body || body.archive !== true)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Archiving needs an explicit archive action.',
    };
  }
  if (status === current) return { ok: true, status, unchanged: true };
  return { ok: true, status, unchanged: false };
}

module.exports = { STATUSES, normaliseStatusChange };
