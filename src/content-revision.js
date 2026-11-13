// Content revisions. Saving a different changes list moves the experiment and
// that variant on to the next revision. Events with a null revision were
// stored before this existed and count as revision 1.

const LONDON_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/London',
});

function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function revisionNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000000) return 1;
  return n;
}

function changesDiffer(previous, next) {
  if (!Array.isArray(next)) return false;
  const before = Array.isArray(previous) ? previous : [];
  return canon(before) !== canon(next);
}

// The snippet may say which revision it applied. A missing or future number
// uses the revision stored on the variant now. Null on an old row stays null;
// this is only for a new event.
function eventRevision(sent, current) {
  const live = revisionNumber(current);
  const n = Number(sent);
  if (!Number.isInteger(n) || n < 1 || n > live) return live;
  return n;
}

function formatRevisionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return LONDON_DATE.format(date);
}

function visitorPhrase(count) {
  const n = Number(count) || 0;
  return n === 1 ? '1 visitor' : `${n} visitors`;
}

function changedWhileRunningLabel(savedAt) {
  const date = formatRevisionDate(savedAt);
  if (!date) return '';
  return `Changed while running on ${date}`;
}

// counts: view events grouped by revision (null counts as 1).
// history: rows from content_revisions for this experiment.
function buildRevisionSummary({ counts, history } = {}) {
  const visitors = new Map();
  (counts || []).forEach((row) => {
    const revision = revisionNumber(row && row.revision);
    const n = Number(row && row.visitors) || 0;
    visitors.set(revision, (visitors.get(revision) || 0) + n);
  });

  const when = new Map();
  (history || []).forEach((row) => {
    if (!row) return;
    const revision = revisionNumber(row.revision);
    const savedAt = row.saved_at || null;
    const running = row.while_running === true;
    const prev = when.get(revision);
    if (!prev) {
      when.set(revision, { saved_at: savedAt, while_running: running });
      return;
    }
    if (running) prev.while_running = true;
    if (savedAt && (!prev.saved_at || new Date(savedAt) < new Date(prev.saved_at))) {
      prev.saved_at = savedAt;
    }
  });

  const changed = [];
  (history || []).forEach((row) => {
    if (!row || row.while_running !== true) return;
    const label = changedWhileRunningLabel(row.saved_at);
    if (!label) return;
    changed.push({
      revision: revisionNumber(row.revision),
      saved_at: row.saved_at,
      label,
    });
  });

  const revisions = [...visitors.keys()].sort((a, b) => a - b).map((revision) => {
    const meta = when.get(revision) || {};
    const count = visitors.get(revision) || 0;
    const date = meta.saved_at ? formatRevisionDate(meta.saved_at) : '';
    const bits = [`Revision ${revision}`];
    if (meta.while_running && date) bits.push(changedWhileRunningLabel(meta.saved_at));
    else if (date) bits.push(date);
    bits.push(visitorPhrase(count));
    return {
      revision,
      visitors: count,
      saved_at: meta.saved_at || null,
      while_running: meta.while_running === true,
      line: bits.join(' · '),
    };
  });

  const spans = revisions.length > 1;
  return {
    spans,
    notice: spans
      ? 'These results include visitors from more than one version of this test. The figures below are not split by version.'
      : '',
    changed_while_running: changed,
    revisions,
  };
}

async function loadRevisionSummary(experimentId, options) {
  const db = require('./db');
  const { visibleEventSql } = require('./metrics');
  const includeTest = !!(options && options.includeTest);
  const mode = options && options.testOnly ? 'test' : undefined;
  const [counts, history] = await Promise.all([
    db.query(
      `SELECT COALESCE(content_revision, 1) AS revision,
              COUNT(DISTINCT visitor_id)::int AS visitors
       FROM events
       WHERE experiment_id = $1
         AND event_type = 'view'
         AND ${visibleEventSql('', 2, mode)}
       GROUP BY 1
       ORDER BY 1`,
      [experimentId, includeTest]
    ),
    db.query(
      `SELECT revision, saved_at, while_running
       FROM content_revisions
       WHERE experiment_id = $1
       ORDER BY revision, saved_at`,
      [experimentId]
    ),
  ]);
  return buildRevisionSummary({ counts: counts.rows, history: history.rows });
}

// Bump when the changes list is actually different. Name, split, goals and
// the steps note do not start a new revision. The caller holds the transaction
// and has already locked the experiment row.
async function recordContentRevision(client, { experimentId, variantId, previousChanges, nextChanges, status }) {
  if (!changesDiffer(previousChanges, nextChanges)) return { bumped: false };
  const exp = await client.query(
    `UPDATE experiments
     SET content_revision = content_revision + 1
     WHERE id = $1
     RETURNING content_revision, status`,
    [experimentId]
  );
  if (!exp.rows.length) {
    const err = new Error('no experiment found with that id');
    err.status = 404;
    throw err;
  }
  const revision = revisionNumber(exp.rows[0].content_revision);
  const whileRunning = (status || exp.rows[0].status) === 'running';
  await client.query(
    `UPDATE variants SET content_revision = $1 WHERE id = $2 AND experiment_id = $3`,
    [revision, variantId, experimentId]
  );
  await client.query(
    `INSERT INTO content_revisions (experiment_id, variant_id, revision, while_running)
     VALUES ($1, $2, $3, $4)`,
    [experimentId, variantId, revision, whileRunning]
  );
  return { bumped: true, revision, while_running: whileRunning };
}

module.exports = {
  canon,
  revisionNumber,
  changesDiffer,
  eventRevision,
  formatRevisionDate,
  changedWhileRunningLabel,
  buildRevisionSummary,
  loadRevisionSummary,
  recordContentRevision,
};
