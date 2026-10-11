// Turns a stored snapshot into what a client is allowed to see.
// Blind payloads are built from an allow-list. Direction, probabilities and
// per-variant conversion figures stay out until the snapshot says the plan
// was met.

const { daysElapsed } = require('./reading');
const {
  HEADLINES,
  PROGRESS_NOTE,
  headlineByCode,
  recommendationFor,
  findForbiddenKey,
} = require('./headlines');
const { formatLondonDay, formatLondonStamp, londonDateISO } = require('./clock');

function goalName(experiment) {
  const goals = experiment && Array.isArray(experiment.goals) ? experiment.goals : [];
  const primary = goals.find((goal) => goal && goal.primary) || goals[0];
  if (!primary) return '';
  return String(primary.name || primary.id || '').trim();
}

function matchPhrase(type) {
  return {
    contains: 'contains',
    exact: 'exact match',
    starts_with: 'starts with',
    regex: 'regular expression',
  }[type] || 'contains';
}

function pageLine(experiment) {
  const page = (experiment && experiment.url_match) || '';
  const match = matchPhrase(experiment && experiment.url_match_type);
  if (!page) return '';
  return `${page} (${match})`;
}

function publicOf(snapshot) {
  if (!snapshot) return null;
  const detail = snapshot.detail;
  if (detail && detail.public && typeof detail.public === 'object') return detail.public;
  return null;
}

function privateOf(snapshot) {
  if (!snapshot || !snapshot.detail) return null;
  return snapshot.detail.private || null;
}

function portalMode({ status, plan, peekedAt, snapshot } = {}) {
  if (status === 'draft') return 'draft';
  const hasPlan = !!(plan && plan.visitors_per_variant);
  if (!hasPlan) return 'unplanned';
  const pub = publicOf(snapshot);
  if (pub && (pub.headline_code === 'ready' || pub.concluded)) return 'concluded';
  if (peekedAt) return 'peeked';
  if (status === 'archived') return 'stopped';
  return 'blind';
}

function listGroup(status, mode) {
  if (status === 'draft' || mode === 'draft') return 'draft';
  if (status === 'archived' || mode === 'concluded' || mode === 'stopped') return 'finished';
  return 'running';
}

function pillFor({ status, mode, headlineCode, days, concludedLabel }) {
  if (mode === 'concluded' && concludedLabel) return { text: concludedLabel, tone: 'done' };
  if (mode === 'draft' || status === 'draft') return { text: 'Not started', tone: 'draft' };
  if (mode === 'peeked') return { text: 'Peeked', tone: 'risk' };
  if (mode === 'unplanned') return { text: status === 'paused' ? 'Paused' : 'Running', tone: 'run' };
  if (status === 'archived' || mode === 'stopped') return { text: 'Finished', tone: 'done' };
  const tone = (headlineCode === 'unlikely' || headlineCode === 'traffic_low' || headlineCode === 'check')
    ? 'risk'
    : (status === 'paused' ? 'draft' : 'run');
  const head = status === 'paused' ? 'Paused' : 'Running';
  const text = days > 0 ? `${head} · day ${days}` : head;
  return { text, tone };
}

function headlineForMode(mode, pub) {
  if (mode === 'peeked') return { code: 'peeked', text: 'Peeked · not a verdict', icon: 'alert' };
  if (mode === 'unplanned') return { code: 'unplanned', text: 'No plan yet', icon: 'dot' };
  if (mode === 'draft') return { code: 'draft', text: 'Not started', icon: 'dot' };
  if (pub && pub.headline_code) return headlineByCode(pub.headline_code);
  return null;
}

function versionWord(count) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? 'version' : 'versions'}`;
}

function listItem(experiment, snapshot, now) {
  const pub = publicOf(snapshot);
  const mode = portalMode({
    status: experiment.status,
    plan: experiment.plan,
    peekedAt: experiment.peeked_at,
    snapshot,
  });
  const days = daysElapsed(experiment.started_at, now || new Date());
  const headline = headlineForMode(mode, pub);
  const concluded = pub && pub.concluded ? pub.concluded : null;
  const goal = goalName(experiment);
  const pill = pillFor({
    status: experiment.status,
    mode,
    headlineCode: headline && headline.code,
    days,
    concludedLabel: concluded && concluded.label,
  });
  const subtitleParts = [
    experiment.url_match || '',
    versionWord(experiment.variant_count),
  ];
  if (mode === 'concluded' && concluded && concluded.finished_label) {
    subtitleParts.push(`finished ${concluded.finished_label}`);
  } else if (goal) {
    subtitleParts.push(`goal: ${goal}`);
  }
  const item = {
    id: experiment.id,
    name: experiment.name,
    status: experiment.status,
    url_match: experiment.url_match || '',
    created_at: experiment.created_at,
    group: listGroup(experiment.status, mode),
    mode,
    page: experiment.url_match || '',
    variant_count: Number(experiment.variant_count) || 0,
    goal: goal,
    subtitle: subtitleParts.filter(Boolean).join(' · '),
    pill: pill.text,
    tone: pill.tone,
    days_elapsed: pub && pub.days_elapsed != null ? pub.days_elapsed : days,
    min_runtime_days: pub ? pub.min_runtime_days : (experiment.plan && experiment.plan.min_runtime_days) || null,
  };
  if (headline) {
    item.headline_code = headline.code;
    item.headline = headline.text;
    item.icon = headline.icon;
  }
  if (mode === 'blind' || mode === 'stopped') {
    if (pub) {
      item.status_note = pub.status_note || '';
      item.visitors = pub.visitors;
      item.planned_visitors = pub.planned_visitors;
      item.progress_pct_band = pub.progress_pct_band;
      item.ready_label = pub.ready_label || '';
      item.bar = headline && (headline.code === 'unlikely' || headline.code === 'traffic_low' || headline.code === 'check')
        ? 'warn'
        : 'ok';
    }
  }
  if (mode === 'concluded' && concluded) {
    item.status_note = '';
    item.verdict_line = concluded.verdict_line || '';
    item.range_line = concluded.range_line || '';
    item.headline = 'Report ready';
    item.headline_code = 'ready';
    item.icon = 'tick';
  }
  if (mode === 'stopped') item.stopped = true;
  return item;
}

function leadChallenger(verdict) {
  const rows = (verdict && verdict.challengers) || [];
  return rows.find((row) => row.verdict === 'win')
    || rows.find((row) => row.verdict === 'loss')
    || rows[0]
    || null;
}

function probabilitySentence(verdict) {
  const probs = (verdict && verdict.probability_best) || [];
  if (probs.length < 2) return '';
  const best = probs.slice().sort((a, b) => b.probability_best - a.probability_best)[0];
  const pct = Math.round(Number(best.probability_best) || 0);
  if (probs.length === 2) {
    const other = probs.find((row) => row.variant_id !== best.variant_id);
    return `${pct}% chance ${best.variant_name} is better than ${other ? other.variant_name : 'the other version'}`;
  }
  return `${pct}% chance ${best.variant_name} is the best version`;
}

function plainSummary(verdict, goalLabel) {
  if (!verdict) return '';
  if (verdict.verdict === 'data_problem') return verdict.summary || '';
  const row = leadChallenger(verdict);
  if (!row) return verdict.summary || '';
  const goal = goalLabel || 'the goal';
  if (row.verdict === 'win') return `${row.variant_name} lifted ${goal} by about ${row.uplift_label}.`;
  if (row.verdict === 'loss') {
    const drop = String(row.uplift_label || '').replace(/^-/, '');
    return `${row.variant_name} came in about ${drop} lower than ${row.control_name || 'Control'} on ${goal}.`;
  }
  return `There's no meaningful difference between ${row.variant_name} and ${row.control_name || 'Control'} at this size.`;
}

function whatsNext({ verdict, pageSuggestion } = {}) {
  const pageLine = pageSuggestion && pageSuggestion.label
    ? `Your next-busiest page is ${pageSuggestion.label} (about ${Number(pageSuggestion.weekly || 0).toLocaleString('en-GB')} visits a week).`
    : 'Pick the next busiest page on the site that is not already in a test.';
  if (!verdict || verdict.verdict === 'data_problem') {
    return [
      { title: 'Do not roll out a winner from this test.', body: 'The traffic split needs a check before the numbers can be trusted.' },
      { title: 'Fix the split, then run it again.', body: 'A broken split can look like a result when it is not one.' },
      { title: 'Start a new test.', body: pageLine },
    ];
  }
  const row = leadChallenger(verdict);
  const call = row ? row.verdict : 'inconclusive';
  if (call === 'win') {
    return [
      { title: 'Roll out the winner.', body: `Make ${row.variant_name} permanent on your site. We can keep serving it to everyone until you do.` },
      { title: 'Build on it.', body: 'Try the same idea on another page, or test a stronger version of it.' },
      { title: 'Start a new test.', body: pageLine },
    ];
  }
  if (call === 'loss') {
    return [
      { title: 'Keep what you have.', body: `${row.variant_name} did not beat ${row.control_name || 'Control'}.` },
      { title: 'Try a bolder change.', body: 'A small tweak often stays too close to call.' },
      { title: 'Start a new test.', body: pageLine },
    ];
  }
  return [
    { title: 'There is no meaningful difference at this size.', body: 'Nothing here is worth rolling out. Try a bolder change so the next test can reach an answer.' },
    { title: 'Try a bolder change.', body: 'Or test it on a busier page.' },
    { title: 'Start a new test.', body: pageLine },
  ];
}

function rateLabel(visitors, conversions) {
  const v = Number(visitors) || 0;
  const c = Number(conversions) || 0;
  if (v <= 0 || c <= 0) return '0%';
  const pct = Math.min(c, v) / v * 100;
  const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded}%`;
}

function concludedPayload({ verdict, goalLabel, rows, visitors, days, finishedOn, pageSuggestion }) {
  const lead = leadChallenger(verdict);
  const label = verdict && verdict.verdict === 'data_problem'
    ? 'Data problem'
    : (lead ? lead.label : (verdict && verdict.label) || 'Verdict');
  const range = lead && lead.ci_low_label
    ? `${lead.ci_low_label} to ${lead.ci_high_label}`
    : '';
  const goal = goalLabel || 'the goal';
  const verdictLine = verdict && verdict.verdict === 'data_problem'
    ? 'Data problem'
    : (lead && lead.verdict === 'win'
      ? `${lead.variant_name}: ${lead.uplift_label} ${goal}`
      : (lead ? `${lead.variant_name}: ${lead.label}` : label));
  return {
    label,
    variant_name: lead ? lead.variant_name : '',
    summary: plainSummary(verdict, goalLabel),
    range_label: range,
    range_line: range ? `95% range ${range}` : '',
    verdict_line: verdictLine,
    probability_label: verdict && verdict.verdict === 'data_problem' ? '' : probabilitySentence(verdict),
    rows: (rows || []).map((row) => ({
      version: row.variant_name || row.name,
      visitors: Number(row.visitors) || 0,
      conversions: Number(row.conversions) || 0,
      rate: rateLabel(row.visitors, row.conversions),
    })),
    goal_label: goalLabel || 'Conversions',
    visitors: Number(visitors) || 0,
    days: Number(days) || 0,
    finished_on: finishedOn || '',
    finished_label: finishedOn ? formatLondonDay(finishedOn) : '',
    whats_next: whatsNext({ verdict, pageSuggestion }),
  };
}

function blindPublic({ assessment, headlineCode, health, daysElapsed: elapsed, minRuntimeDays, statusNoteText }) {
  const headline = headlineByCode(headlineCode);
  return {
    headline_code: headline.code,
    headline: headline.text,
    icon: headline.icon,
    progress_pct_band: assessment.progressPctBand,
    visitors: assessment.visitors,
    planned_visitors: assessment.plannedVisitors,
    daily_rate: Math.round(assessment.dailyRate || 0),
    ready_label: assessment.readyLabel,
    days_elapsed: elapsed,
    min_runtime_days: minRuntimeDays,
    status_note: statusNoteText,
    recommendation: recommendationFor(headline.code),
    progress_note: PROGRESS_NOTE,
    health: health,
    possible_headlines: HEADLINES.map((row) => row.text),
  };
}

function experimentPageUrl(experiment) {
  const raw = String((experiment && experiment.url_match) || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\*.*$/, '');
  const host = experiment && Array.isArray(experiment.allowed_hosts) ? experiment.allowed_hosts[0] : '';
  if (!raw.startsWith('/') && raw.includes('.')) {
    return `https://${raw.replace(/\*.*$/, '')}`;
  }
  if (!host) return '';
  let path = raw.replace(/\*.*$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return `https://${host}${path}`;
}

function detailPayload({ experiment, snapshot, variants, review, now }) {
  const pub = publicOf(snapshot);
  const mode = portalMode({
    status: experiment.status,
    plan: experiment.plan,
    peekedAt: experiment.peeked_at,
    snapshot: snapshot ? { detail: { public: pub } } : null,
  });
  const days = daysElapsed(experiment.started_at, now || new Date());
  const safePublic = mode === 'concluded' || mode === 'blind' || mode === 'stopped' ? pub : null;
  if ((mode === 'blind' || mode === 'stopped') && safePublic) {
    const leaked = findForbiddenKey(safePublic, false);
    if (leaked) {
      const error = new Error(`blind snapshot leaked ${leaked}`);
      error.code = 'BLIND_LEAK';
      throw error;
    }
  }
  return {
    experiment: {
      id: experiment.id,
      name: experiment.name,
      status: experiment.status,
      hypothesis: experiment.hypothesis || '',
      url_match: experiment.url_match || '',
      url_match_type: experiment.url_match_type || 'contains',
      page_line: pageLine(experiment),
      goal: goalName(experiment),
      variants: (variants || []).map((variant) => ({
        id: variant.id,
        name: variant.name,
        preview_url: variant.preview_url || null,
      })),
    },
    mode,
    days_elapsed: days,
    min_runtime_days: experiment.plan && experiment.plan.min_runtime_days
      ? Number(experiment.plan.min_runtime_days)
      : null,
    refreshed_label: snapshot && snapshot.created_at ? formatLondonStamp(snapshot.created_at) : null,
    snapshot: safePublic,
    review: review && review.created_at
      ? {
        requested_at: review.created_at,
        requested_label: formatLondonDay(londonDateISO(new Date(review.created_at))),
      }
      : null,
  };
}

module.exports = {
  goalName,
  matchPhrase,
  pageLine,
  publicOf,
  privateOf,
  portalMode,
  listGroup,
  listItem,
  headlineForMode,
  leadChallenger,
  probabilitySentence,
  plainSummary,
  whatsNext,
  concludedPayload,
  blindPublic,
  experimentPageUrl,
  detailPayload,
  formatLondonStamp,
};
