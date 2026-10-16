// Turns a stored conclusion into PDF lines. This module does not load the
// stats engine and does not count events. Every figure is copied from the
// snapshot that was already stored.

const { goalName, pageLine } = require('./portal-view');
const { londonParts } = require('./clock');
const { renderDocument } = require('./pdf-doc');
const { contentDispositionAttachment } = require('./csv');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const METHOD = [
  'pivitlab decides with a Bayesian credible interval on the relative uplift (challenger minus control, divided by control).',
  'The 95% range is always shown.',
  'A range that excludes no change is a win or a loss.',
  'A win is in favour of the challenger.',
  'A loss is in favour of the control.',
  'A range that includes no change is inconclusive.',
  'With more than one challenger the interval is tightened so a false win across every comparison stays near 5%.',
  'Probability best is a secondary detail, not the decision.',
  'A broken traffic split is labelled a data problem, not a win, a loss, or inconclusive.',
].join(' ');

function longDate(iso) {
  const [year, month, day] = String(iso || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function longStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = londonParts(date);
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}, ${hour}:${minute} (UK time)`;
}

function push(items, text, size, bold, gapBefore) {
  if (text == null || text === '') return;
  items.push({
    text: String(text),
    size: size || 11,
    bold: !!bold,
    gapBefore: gapBefore || 0,
  });
}

// Copies the stored concluded object. Returns null when the snapshot has no
// result, so the caller cannot invent one.
function freezeConclusion(experiment, snapshot, generatedOn) {
  const detail = snapshot && snapshot.detail;
  const pub = detail && detail.public;
  const concluded = pub && pub.concluded;
  if (!concluded || typeof concluded !== 'object') return null;
  return {
    brand: 'pivitlab',
    experiment_name: (experiment && experiment.name) || '',
    hypothesis: (experiment && experiment.hypothesis) || '',
    page_line: pageLine(experiment),
    goal: goalName(experiment),
    peeked: !!(experiment && experiment.peeked_at),
    demo: !!(experiment && experiment.test_type === 'demo'),
    generated_on: generatedOn,
    snapshot_date: snapshot.snapshot_date || '',
    concluded: JSON.parse(JSON.stringify(concluded)),
  };
}

function conclusionLines(content) {
  const stored = (content && content.concluded) || {};
  const items = [];
  push(items, 'pivitlab', 14, true, 0);
  push(items, 'Conclusion', 20, true, 14);
  push(items, content.experiment_name || 'Test', 13, true, 6);
  if (content.demo) {
    push(items, 'Demo', 12, true, 8);
    push(
      items,
      'Demo test. Test traffic only. Real visitors are not included. The 14-day minimum runtime is skipped, which is only allowed for a demo test.',
      10,
      false,
      4
    );
  }
  const finished = stored.finished_label ? `, finished ${stored.finished_label}` : '';
  push(
    items,
    `Stored result${finished}. These figures were copied from that result. pivitlab did not recalculate them for this document.`,
    10,
    false,
    10
  );
  if (content.peeked) {
    push(
      items,
      'Someone looked before the plan was reached. The stored verdict still uses the planned sample.',
      10,
      false,
      8
    );
  }

  push(items, 'Verdict', 13, true, 16);
  const heading = stored.label === 'Win' || stored.label === 'Loss'
    ? `${stored.label}: ${stored.variant_name || ''}`.trim()
    : (stored.label || 'Verdict');
  push(items, heading, 16, true, 6);
  push(items, stored.summary, 11, false, 6);
  if (stored.range_label) push(items, `95% range: ${stored.range_label}`, 11, false, 4);
  if (stored.range_line && stored.range_line !== `95% range ${stored.range_label}`) {
    push(items, stored.range_line, 11, false, 2);
  }
  if (stored.probability_label) push(items, stored.probability_label, 11, false, 4);
  if (stored.verdict_line) push(items, stored.verdict_line, 10, false, 4);
  push(
    items,
    'Probability best is a secondary detail, not the decision. The decision is the 95% credible range on the relative uplift.',
    10,
    false,
    6
  );

  push(items, 'Results', 13, true, 16);
  const goal = stored.goal_label || 'Conversions';
  push(items, `Version    Visitors    ${goal}    Rate`, 10, true, 6);
  (stored.rows || []).forEach((row) => {
    push(
      items,
      `${row.version}    ${row.visitors}    ${row.conversions}    ${row.rate}`,
      10,
      false,
      2
    );
  });
  if (stored.visitors != null) {
    push(items, `${stored.visitors} visitors over ${stored.days} days.`, 10, false, 8);
  }

  if (content.hypothesis) {
    push(items, 'Hypothesis', 13, true, 16);
    push(items, content.hypothesis, 11, false, 6);
  }
  if (content.page_line) {
    push(items, 'Page', 13, true, 12);
    push(items, content.page_line, 11, false, 4);
  }
  if (content.goal) {
    push(items, 'Goal', 13, true, 12);
    push(items, content.goal, 11, false, 4);
  }

  const next = stored.whats_next || [];
  if (next.length) {
    push(items, "What's next", 13, true, 16);
    next.forEach((step, index) => {
      push(items, `${index + 1}. ${step.title || ''}`, 11, true, 8);
      push(items, step.body || '', 10, false, 2);
    });
  }

  push(items, 'How pivitlab decides', 13, true, 18);
  push(items, METHOD, 10, false, 6);
  if (content.generated_on) {
    push(items, `Document date: ${longDate(content.generated_on)}.`, 9, false, 14);
  }
  return items;
}

function conclusionPdf(content) {
  return renderDocument(conclusionLines(content), { watermark: content && content.demo ? 'Demo' : '' });
}

function approvalLines({ experimentName, approverName, approvedAt, releasedAt, demo }) {
  const items = [];
  push(items, 'pivitlab', 14, true, 0);
  push(items, 'Approval record', 20, true, 14);
  push(
    items,
    'This records a click to approve in pivitlab. It is not a paper signature.',
    11,
    false,
    10
  );
  push(items, `Test: ${experimentName || 'Test'}`, 12, true, 16);
  if (demo) {
    push(items, 'Demo', 12, true, 8);
    push(items, 'Demo test. This approval is for test traffic only.', 10, false, 4);
  }
  push(items, `Approved by: ${approverName || 'Client'}`, 12, false, 8);
  push(items, `Approved on: ${longStamp(approvedAt)}`, 12, false, 6);
  if (releasedAt) push(items, `Conclusion released: ${longStamp(releasedAt)}`, 11, false, 6);
  push(
    items,
    'The account owner released the conclusion before this approval. A draft conclusion is not shown in the client portal.',
    10,
    false,
    14
  );
  return items;
}

function approvalPdf(record) {
  return renderDocument(approvalLines(record), { watermark: record && record.demo ? 'Demo' : '' });
}

function pdfDay(date) {
  const day = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const month = String(day.getUTCMonth() + 1).padStart(2, '0');
  const dateNum = String(day.getUTCDate()).padStart(2, '0');
  return `${day.getUTCFullYear()}-${month}-${dateNum}`;
}

function pdfSlug(name) {
  const folded = String(name || '').normalize('NFKD').replace(/\p{M}/gu, '');
  const cleaned = folded.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return cleaned || 'experiment';
}

function pdfNames(experimentName, kind, date) {
  const token = kind === 'approval' ? 'approval' : 'conclusion';
  const ascii = `${pdfSlug(experimentName)}-${token}-${pdfDay(date)}.pdf`;
  return { ascii, utf8: ascii };
}

function sendPdf(res, names, bytes) {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', contentDispositionAttachment(names));
  res.send(bytes);
}

module.exports = {
  METHOD,
  longDate,
  longStamp,
  freezeConclusion,
  conclusionLines,
  conclusionPdf,
  approvalLines,
  approvalPdf,
  pdfNames,
  sendPdf,
};
