// Fixed headline set for the blind period. None of these says which version
// is ahead. Futility is shown to a client only after two consecutive days.

const { addDays, formatDayMonth, formatMonthYear, londonParts } = require('./clock');

const HEADLINES = [
  { code: 'on_track', text: 'Collecting data, on track', icon: 'dot' },
  { code: 'traffic_low', text: 'Traffic lower than planned', icon: 'up' },
  { code: 'unlikely', text: 'Unlikely to finish in time', icon: 'up' },
  { code: 'check', text: 'Check needed (split or tracking issue)', icon: 'alert' },
  { code: 'ready', text: 'Result ready', icon: 'tick' },
];

const BY_CODE = new Map(HEADLINES.map((row) => [row.code, row]));

const RECOMMENDATIONS = {
  on_track: 'Keep it running. Nothing needs changing.',
  traffic_low: 'Traffic is lower than planned. Keep it running for now.',
  unlikely: 'Consider stopping and testing a bolder change, or a busier page.',
  check: 'Something about the split or the tracking needs a look. The result stays hidden until that is understood.',
  ready: 'The planned sample and the minimum runtime are both in. This is the result.',
};

const PROGRESS_NOTE = "This is progress, not a result. Who's ahead isn't shown until the test finishes, because early leads often reverse.";

const WEEK_ROUND_DAYS = 21;
const FAR_DAYS = 120;

function headlineByCode(code) {
  return BY_CODE.get(code) || BY_CODE.get('on_track');
}

function roundProgressBand(pct) {
  const value = Number(pct);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(value / 5) * 5));
}

// planMet and a real health problem outrank futility. "Unlikely" reaches the
// client only when today and the previous snapshot are both in that band.
function clientHeadlineCode({ planMet, healthProblem, trafficLow, futilityBand, previousFutilityBand } = {}) {
  if (planMet) return 'ready';
  if (healthProblem) return 'check';
  if (futilityBand === 'unlikely' && previousFutilityBand === 'unlikely') return 'unlikely';
  if (trafficLow) return 'traffic_low';
  return 'on_track';
}

function recommendationFor(code) {
  return RECOMMENDATIONS[code] || RECOMMENDATIONS.on_track;
}

function startOfLondonWeek(date) {
  const parts = londonParts(date);
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const weekday = new Date(utc).getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return new Date(utc + delta * 24 * 60 * 60 * 1000);
}

function readyLabel(projectedEnd, now, { unlikely = false } = {}) {
  if (!projectedEnd || !Number.isFinite(new Date(projectedEnd).getTime())) {
    return 'At this rate: not within the planned window';
  }
  const end = new Date(projectedEnd);
  const days = (end.getTime() - new Date(now).getTime()) / (24 * 60 * 60 * 1000);
  if (days > FAR_DAYS) return `At this rate: ${formatMonthYear(end)}`;
  if (days > WEEK_ROUND_DAYS) {
    const week = startOfLondonWeek(end);
    const when = formatDayMonth(week);
    return unlikely ? `At this rate: the week of ${when}` : `Ready around the week of ${when}`;
  }
  const when = formatDayMonth(end);
  return unlikely ? `At this rate: ${when}` : `Ready around ${when}`;
}

function ownerNote({ futilityBand, trafficOnly, clientHeadline } = {}) {
  if (futilityBand === 'amber') {
    return 'May end inconclusive. This note is only on your dashboard. The viewer is not shown it, and it does not say which version is ahead.';
  }
  if (futilityBand === 'low') {
    return 'Unlikely to reach a decisive result even if the visitors arrive. This note is only on your dashboard. It does not say which version is ahead.';
  }
  if (futilityBand === 'unlikely' && clientHeadline !== 'unlikely') {
    return 'Futility was flagged today. The viewer sees “Unlikely to finish in time” only after a second day in a row. It does not say which version is ahead.';
  }
  if (futilityBand === 'unlikely' && clientHeadline === 'unlikely') {
    if (trafficOnly) {
      return 'At the recent traffic, this runs past the planned window. The viewer headline is “Unlikely to finish in time”. It does not say which version is ahead.';
    }
    return 'The viewer headline is “Unlikely to finish in time”. It does not say which version is ahead.';
  }
  return null;
}

function shareLabel(variants) {
  const rows = variants || [];
  const total = rows.reduce((sum, row) => sum + (Number(row.visitors) || 0), 0);
  if (total <= 0) return '';
  const raw = rows.map((row) => ((Number(row.visitors) || 0) / total) * 100);
  const floors = raw.map((value) => Math.floor(value));
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - floors[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; i < left; i += 1) floors[order[i].index] += 1;
  return floors.join(' / ');
}

// Client health is three lines. A "blocking" problem becomes the check headline.
// Early quiet (not enough visitors, goal set but no conversion yet) is not a
// check: that would cry wolf on day one.
function buildClientHealth({ variants, srmDetected, totalVisitors, snippetSeenToday, snippetSilent, conversions, goalCount, daysElapsed } = {}) {
  const checks = [];
  let blocking = false;
  const visitors = Number(totalVisitors) || 0;
  if (srmDetected) {
    checks.push({ ok: false, label: 'Traffic split needs a check' });
    blocking = true;
  } else if (visitors < 50) {
    checks.push({ ok: true, label: 'Not enough visitors yet to check the traffic split' });
  } else {
    const shares = shareLabel(variants);
    checks.push({ ok: true, label: shares ? `Traffic split as planned (${shares})` : 'Traffic split as planned' });
  }
  if (snippetSeenToday) {
    checks.push({ ok: true, label: 'Snippet seen on the page today' });
  } else if (snippetSilent) {
    checks.push({ ok: false, label: 'Snippet not seen on the page today' });
    blocking = true;
  } else {
    checks.push({ ok: true, label: 'Snippet not seen on the page yet today' });
  }
  if (!goalCount) {
    checks.push({ ok: false, label: 'Goal is not being recorded' });
    blocking = true;
  } else if ((Number(conversions) || 0) > 0) {
    checks.push({ ok: true, label: 'Goal is being recorded' });
  } else if (visitors >= 200) {
    checks.push({ ok: false, label: 'Goal is not being recorded' });
    blocking = true;
  } else {
    checks.push({ ok: true, label: 'Goal is set' });
  }
  return { checks, blocking };
}

function statusNote({ blocking, trafficLow, futilityBand } = {}) {
  if (blocking) return 'Check needed';
  if (trafficLow || futilityBand === 'unlikely') return 'Traffic lower than planned';
  return 'Health: all good';
}

// Keys that must never appear on a blind client payload. Concluded results
// live under `concluded` and are allowed only once the plan is met.
const BLIND_FORBIDDEN = [
  'p_decisive',
  'probability',
  'probability_best',
  'conversions',
  'conversion_rate',
  'uplift',
  'uplift_label',
  'owner_note',
  'posterior',
  'ci_low',
  'ci_high',
  'private',
];

function findForbiddenKey(value, allowConcluded) {
  if (!value || typeof value !== 'object') return null;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    const name = String(key);
    if (allowConcluded && name === 'concluded') continue;
    if (BLIND_FORBIDDEN.includes(name)) return name;
    const nested = findForbiddenKey(child, false);
    if (nested) return nested;
  }
  return null;
}

module.exports = {
  HEADLINES,
  RECOMMENDATIONS,
  PROGRESS_NOTE,
  WEEK_ROUND_DAYS,
  FAR_DAYS,
  BLIND_FORBIDDEN,
  headlineByCode,
  roundProgressBand,
  clientHeadlineCode,
  recommendationFor,
  readyLabel,
  ownerNote,
  shareLabel,
  buildClientHealth,
  statusNote,
  findForbiddenKey,
  startOfLondonWeek,
  addDays,
};
