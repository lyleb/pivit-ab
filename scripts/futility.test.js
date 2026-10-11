// Futility bands, headline hysteresis, and the blind payload.
// No database. The Monte Carlo cases use a small draw count so the suite stays quick.
const assert = require('assert');
const { assessFutility, bandFor } = require('../src/futility');
const {
  HEADLINES,
  roundProgressBand,
  clientHeadlineCode,
  readyLabel,
  findForbiddenKey,
  buildClientHealth,
} = require('../src/headlines');
const { blindPublic } = require('../src/portal-view');
const { londonParts, nextLondonRun, londonDateISO } = require('../src/clock');

const forbidden = /ahead|winning|edging|better|worse|uplift|probability/i;
HEADLINES.forEach((row) => {
  assert.ok(!forbidden.test(row.text), row.text);
});
assert.deepStrictEqual(HEADLINES.map((row) => row.code), [
  'on_track', 'traffic_low', 'unlikely', 'check', 'ready',
]);

assert.strictEqual(roundProgressBand(31), 30);
assert.strictEqual(roundProgressBand(33), 35);
assert.strictEqual(roundProgressBand(2), 0);
assert.strictEqual(roundProgressBand(97.6), 100);
assert.strictEqual(roundProgressBand(0), 0);

assert.strictEqual(bandFor(0.42, false), 'none');
assert.strictEqual(bandFor(0.3, false), 'none');
assert.strictEqual(bandFor(0.2, true), 'amber');
assert.strictEqual(bandFor(0.1, false), 'amber');
assert.strictEqual(bandFor(0.09, true), 'unlikely');
assert.strictEqual(bandFor(0.09, false), 'low');

assert.strictEqual(clientHeadlineCode({
  futilityBand: 'unlikely',
  previousFutilityBand: null,
  trafficLow: true,
}), 'traffic_low');
assert.strictEqual(clientHeadlineCode({
  futilityBand: 'unlikely',
  previousFutilityBand: 'unlikely',
  trafficLow: true,
}), 'unlikely');
assert.strictEqual(clientHeadlineCode({
  planMet: true,
  futilityBand: 'unlikely',
  previousFutilityBand: 'unlikely',
}), 'ready');
assert.strictEqual(clientHeadlineCode({
  healthProblem: true,
  futilityBand: 'unlikely',
  previousFutilityBand: 'unlikely',
}), 'check');
assert.strictEqual(clientHeadlineCode({ futilityBand: 'amber', trafficLow: false }), 'on_track');

const morning = new Date('2026-10-11T04:59:00Z');
assert.strictEqual(londonParts(morning).hour, 5);
const due = nextLondonRun(morning, 6);
assert.strictEqual(londonParts(due).hour, 6);
assert.strictEqual(londonDateISO(due), '2026-10-11');
const later = nextLondonRun(new Date('2026-10-11T05:01:00Z'), 6);
assert.strictEqual(londonDateISO(later), '2026-10-12');
assert.ok(later.getTime() > new Date('2026-10-11T05:01:00Z').getTime());

const now = new Date('2026-10-11T06:00:00Z');
assert.strictEqual(readyLabel(new Date('2026-10-18T12:00:00Z'), now, {}), 'Ready around 18 Oct');
assert.ok(readyLabel(new Date('2026-12-03T12:00:00Z'), now, {}).startsWith('Ready around the week of'));
assert.strictEqual(
  readyLabel(new Date('2027-05-15T12:00:00Z'), now, { unlikely: true }),
  'At this rate: May 2027'
);

function arm(id, name, visitors, conversions) {
  return {
    variant_id: id,
    variant_name: name,
    visitors,
    conversions,
    traffic_split: 50,
    enabled: true,
  };
}

const pastCap = {
  visitorsPerVariant: 5000,
  dailyRate: 2,
  startedAt: new Date('2026-07-01T06:00:00Z'),
  estimatedDays: 30,
  now: new Date('2026-10-11T07:00:00Z'),
  plan: { visitors_per_variant: 5000, comparisons: 1 },
  runs: 20,
  innerDraws: 30,
};
const lowLeft = assessFutility(Object.assign({}, pastCap, {
  variants: [arm('c', 'Control', 20, 1), arm('a', 'Variant A', 20, 10)],
}));
const lowRight = assessFutility(Object.assign({}, pastCap, {
  variants: [arm('c', 'Control', 20, 10), arm('a', 'Variant A', 20, 1)],
}));
assert.strictEqual(lowLeft.trafficOnly, true);
assert.strictEqual(lowLeft.band, 'unlikely');
assert.strictEqual(lowLeft.pDecisive, null);
assert.strictEqual(lowRight.band, 'unlikely');
assert.strictEqual(lowRight.pDecisive, null);

const onTime = {
  visitorsPerVariant: 800,
  dailyRate: 400,
  startedAt: new Date('2026-10-06T06:00:00Z'),
  estimatedDays: 20,
  now,
  plan: { visitors_per_variant: 800, comparisons: 1, alpha_per_comparison: 0.05 },
  runs: 40,
  innerDraws: 80,
  seed: 'aa-check',
};
const aa = assessFutility(Object.assign({}, onTime, {
  variants: [arm('c', 'Control', 200, 20), arm('a', 'Variant A', 200, 20)],
}));
assert.strictEqual(aa.trafficOnly, false);
assert.notStrictEqual(aa.band, 'unlikely');
assert.ok(aa.pDecisive < 0.5, `A/A P(decisive) was ${aa.pDecisive}`);
assert.strictEqual(clientHeadlineCode({
  futilityBand: aa.band,
  previousFutilityBand: aa.band,
  trafficLow: aa.trafficLow,
}), 'on_track');

const strongBase = Object.assign({}, onTime, { seed: 'lift', runs: 30, innerDraws: 60 });
const strong = assessFutility(Object.assign({}, strongBase, {
  variants: [arm('c', 'Control', 400, 40), arm('a', 'Variant A', 400, 120)],
}));
const flipped = assessFutility(Object.assign({}, strongBase, {
  variants: [arm('c', 'Control', 400, 120), arm('a', 'Variant A', 400, 40)],
}));
assert.strictEqual(strong.band, 'none');
assert.strictEqual(flipped.band, 'none');

const health = buildClientHealth({
  variants: [arm('c', 'Control', 34, 0), arm('a', 'A', 33, 0), arm('b', 'B', 33, 0)],
  srmDetected: false,
  totalVisitors: 100,
  snippetSeenToday: true,
  conversions: 4,
  goalCount: 1,
  daysElapsed: 9,
});
assert.strictEqual(health.blocking, false);
assert.ok(health.checks[0].label.includes('34 / 33 / 33'));

const quietMorning = buildClientHealth({
  variants: [arm('c', 'Control', 10, 0), arm('a', 'A', 10, 0)],
  totalVisitors: 20,
  snippetSeenToday: false,
  snippetSilent: false,
  conversions: 0,
  goalCount: 1,
  daysElapsed: 9,
});
assert.strictEqual(quietMorning.blocking, false);

const assessment = assessFutility(Object.assign({}, pastCap, {
  variants: [arm('c', 'Control', 20, 1), arm('a', 'Variant A', 20, 1)],
}));
const pub = blindPublic({
  assessment,
  headlineCode: 'traffic_low',
  health: health.checks,
  daysElapsed: 9,
  minRuntimeDays: 14,
  statusNoteText: 'Traffic lower than planned',
});
assert.strictEqual(findForbiddenKey(pub, false), null);
assert.ok(!JSON.stringify(pub).includes('p_decisive'));
pub.concluded = { rows: [{ conversions: 1 }] };
assert.strictEqual(findForbiddenKey(pub, false), 'conversions');

console.log('futility tests passed');
