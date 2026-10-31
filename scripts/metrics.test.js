const assert = require('assert');
const fs = require('fs');
const path = require('path');
const metrics = require('../src/metrics');

const goals = [
  { key: 'cta', type: 'click', label: 'CTA', primary: false },
  { key: 'thanks', type: 'url', label: 'Thanks', primary: false },
];

function event(partial) {
  return {
    variant_id: 'v1',
    variant_name: 'Control',
    visitor_id: 'a',
    event_type: 'view',
    goal_id: null,
    ...partial,
  };
}

// One visitor, several convert events: one conversion, rate 100% not 400%.
const repeats = [
  event({ event_type: 'view' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
];
const once = metrics.summariseConversions(repeats)[0];
assert.strictEqual(once.visitors, 1);
assert.strictEqual(once.conversions, 1);
assert.strictEqual(once.conversion_events, 4);
assert.strictEqual(once.conversion_rate, 100);
assert.ok(once.conversion_rate <= 100);

// Two visitors, one of them converts three times: 50%, not 150%.
const half = metrics.summariseConversions([
  event({ event_type: 'view', visitor_id: 'a' }),
  event({ event_type: 'view', visitor_id: 'b' }),
  event({ event_type: 'convert', visitor_id: 'a', goal_id: 'cta' }),
  event({ event_type: 'convert', visitor_id: 'a', goal_id: 'cta' }),
  event({ event_type: 'convert', visitor_id: 'a', goal_id: 'cta' }),
]);
assert.strictEqual(half[0].visitors, 2);
assert.strictEqual(half[0].conversions, 1);
assert.strictEqual(half[0].conversion_events, 3);
assert.strictEqual(half[0].conversion_rate, 50);

// Any goal: one visitor hitting two goals is still one headline conversion.
const bothGoals = metrics.summariseConversions([
  event({ event_type: 'view' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'thanks' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
]);
assert.strictEqual(bothGoals[0].conversions, 1);
assert.strictEqual(bothGoals[0].conversion_events, 3);
assert.strictEqual(bothGoals[0].conversion_rate, 100);

// Primary goal: the other goal does not count towards the headline rate.
const primary = metrics.summariseConversions([
  event({ event_type: 'view' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'thanks' }),
], { primaryGoalKey: 'thanks' });
assert.strictEqual(primary[0].conversions, 1);
assert.strictEqual(primary[0].conversion_events, 1);

// A convert with no view is not a conversion, so the rate stays at 0 rather than blowing up.
const noView = metrics.summariseConversions([
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
]);
assert.strictEqual(noView[0].visitors, 0);
assert.strictEqual(noView[0].conversions, 0);
assert.strictEqual(noView[0].conversion_rate, 0);

assert.strictEqual(metrics.conversionRate(1, 50), 100);
assert.strictEqual(metrics.conversionRate(4, 1), 25);
assert.strictEqual(metrics.conversionRate(3, 1), 33.33);
assert.strictEqual(metrics.conversionRate(0, 5), 0);
assert.ok(metrics.conversionRate(1, 100000) <= 100);

const byGoal = metrics.summariseByGoal([
  event({ event_type: 'view', variant_name: 'Control' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'cta' }),
  event({ event_type: 'convert', goal_id: 'thanks' }),
], goals);
const cta = byGoal.find((goal) => goal.key === 'cta').variants[0];
const thanks = byGoal.find((goal) => goal.key === 'thanks').variants[0];
assert.strictEqual(cta.conversions, 1);
assert.strictEqual(cta.conversion_events, 2);
assert.strictEqual(cta.conversion_rate, 100);
assert.strictEqual(thanks.conversions, 1);
assert.strictEqual(thanks.conversion_events, 1);
assert.ok(cta.conversion_rate <= 100 && thanks.conversion_rate <= 100);

// Same visitor converts on two days. Cumulative unique rate stays 100%, not 200%.
const series = metrics.assembleTimeseries({
  daily: [
    { variant_id: 'v1', variant_name: 'Control', day: '2026-10-01', visitors: 1, conversions: 1 },
    { variant_id: 'v1', variant_name: 'Control', day: '2026-10-02', visitors: 1, conversions: 1 },
  ],
  firstViews: [{ variant_id: 'v1', variant_name: 'Control', day: '2026-10-01', count: 1 }],
  firstConverts: [{ variant_id: 'v1', variant_name: 'Control', day: '2026-10-01', count: 1 }],
});
assert.strictEqual(series.length, 2);
assert.strictEqual(series[0].conversions, 1);
assert.strictEqual(series[0].cumulative_visitors, 1);
assert.strictEqual(series[0].cumulative_conversions, 1);
assert.strictEqual(series[1].cumulative_visitors, 1);
assert.strictEqual(series[1].cumulative_conversions, 1);
assert.strictEqual(metrics.conversionRate(series[1].cumulative_visitors, series[1].cumulative_conversions), 100);
// Summing the daily unique rows would double-count; the cumulative fields must not.
assert.ok(series[1].cumulative_conversions < series[0].conversions + series[1].conversions);

const csv = metrics.annotateUniqueConversions([
  { event_type: 'view', variant_name: 'Control', visitor_id: 'a', goal_id: null },
  { event_type: 'convert', variant_name: 'Control', visitor_id: 'a', goal_id: 'cta' },
  { event_type: 'convert', variant_name: 'Control', visitor_id: 'a', goal_id: 'cta' },
  { event_type: 'convert', variant_name: 'Control', visitor_id: 'a', goal_id: 'thanks' },
  { event_type: 'convert', variant_name: 'B', visitor_id: 'a', goal_id: 'cta' },
]);
assert.deepStrictEqual(csv.map((row) => row.unique_conversion), ['', '1', '0', '1', '1']);

assert.strictEqual(metrics.visitorTypeClause('nope; drop table events'), '');
assert.strictEqual(metrics.visitorTypeClause('new'), 'AND e.created_at::date = fs.first_day');

const sql = fs.readFileSync(path.join(__dirname, '../src/metrics.js'), 'utf8');
assert.ok(sql.includes('COUNT(*) FILTER (WHERE viewed AND converted) AS conversions'));
assert.ok(sql.includes('COUNT(DISTINCT e.visitor_id) AS converters'));
assert.ok(!sql.includes('SUM(value)'));

const resultsSrc = fs.readFileSync(path.join(__dirname, '../src/routes/results.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(__dirname, '../src/routes/client.js'), 'utf8');
assert.ok(resultsSrc.includes('getVariantResults'));
assert.ok(resultsSrc.includes('getPrimaryVariantData'));
assert.ok(resultsSrc.includes('getTimeseries'));
assert.ok(resultsSrc.includes('annotateUniqueConversions'));
assert.ok(clientSrc.includes('getVariantResults'));
assert.ok(clientSrc.includes('getPrimaryVariantData'));
assert.ok(clientSrc.includes('getTimeseries'));
assert.ok(!resultsSrc.includes("COUNT(*) FILTER (WHERE e.event_type = 'convert')"));
assert.ok(!clientSrc.includes("COUNT(*) FILTER (WHERE e.event_type = 'convert')"));
assert.ok(resultsSrc.includes('getFunnel'));
assert.ok(resultsSrc.includes('funnel: visible ? funnel : null'));
assert.ok(clientSrc.includes('getFunnel'));
assert.ok(clientSrc.includes('funnel: visible ? funnel : null'));

const stepGoals = [
  { key: 'basket', type: 'custom', label: 'Basket', step: 1 },
  { key: 'details', type: 'custom', label: 'Details', step: 2 },
  { key: 'payment', type: 'custom', label: 'Payment', step: 3 },
  { key: 'confirmation', type: 'custom', label: 'Confirmation', step: 4 },
];

function funnelEvents() {
  const rows = [];
  for (let i = 1; i <= 8; i += 1) {
    const id = 'v' + i;
    rows.push(event({ visitor_id: id, event_type: 'view', created_at: '2026-10-01T10:00:00Z' }));
    rows.push(event({ visitor_id: id, event_type: 'convert', goal_id: 'basket', created_at: '2026-10-01T10:01:00Z' }));
    if (i <= 6) rows.push(event({ visitor_id: id, event_type: 'convert', goal_id: 'details', created_at: '2026-10-01T10:02:00Z' }));
    if (i <= 4) rows.push(event({ visitor_id: id, event_type: 'convert', goal_id: 'payment', created_at: '2026-10-01T10:03:00Z' }));
    if (i <= 2) rows.push(event({ visitor_id: id, event_type: 'convert', goal_id: 'confirmation', created_at: '2026-10-01T10:04:00Z' }));
  }
  rows.push(event({ visitor_id: 'v1', event_type: 'convert', goal_id: 'basket', created_at: '2026-10-01T10:05:00Z' }));
  rows.push(event({ visitor_id: 'outsider', event_type: 'convert', goal_id: 'basket', created_at: '2026-10-01T10:01:00Z' }));
  rows.push(event({
    variant_id: 'v2',
    variant_name: 'Offer',
    visitor_id: 'o1',
    event_type: 'view',
    created_at: '2026-10-01T11:00:00Z',
  }));
  rows.push(event({
    variant_id: 'v2',
    variant_name: 'Offer',
    visitor_id: 'o1',
    event_type: 'convert',
    goal_id: 'basket',
    created_at: '2026-10-01T11:01:00Z',
  }));
  return rows;
}

const happy = metrics.summariseFunnel(funnelEvents(), stepGoals, { activationType: 'page_load' });
assert.strictEqual(happy.ordered, true);
assert.strictEqual(happy.baseline_step, 1);
assert.strictEqual(happy.activation_delays, false);
const controlFunnel = happy.variants.find((row) => row.variant_id === 'v1');
assert.deepStrictEqual(controlFunnel.steps.map((row) => row.visitors), [8, 6, 4, 2]);
assert.deepStrictEqual(controlFunnel.steps.map((row) => row.rate_of_step_1), [100, 75, 50, 25]);
assert.deepStrictEqual(controlFunnel.steps.map((row) => row.drop_off), [null, 25, 33.33, 50]);
assert.deepStrictEqual(controlFunnel.steps.map((row) => row.unmeasured), [false, false, false, false]);
const offerFunnel = happy.variants.find((row) => row.variant_id === 'v2');
assert.strictEqual(offerFunnel.steps[0].visitors, 1);
assert.strictEqual(offerFunnel.steps[1].visitors, 0);

const disorder = metrics.summariseFunnel([
  event({ visitor_id: 'late', event_type: 'view', created_at: '2026-10-01T10:00:00Z' }),
  event({ visitor_id: 'late', event_type: 'convert', goal_id: 'details', created_at: '2026-10-01T10:01:00Z' }),
  event({ visitor_id: 'late', event_type: 'convert', goal_id: 'basket', created_at: '2026-10-01T10:02:00Z' }),
  event({ visitor_id: 'late', event_type: 'convert', goal_id: 'details', created_at: '2026-10-01T10:03:00Z' }),
], stepGoals, { activationType: 'page_load' });
assert.deepStrictEqual(disorder.variants[0].steps.map((row) => row.visitors), [1, 1, 0, 0]);

const sameTime = metrics.summariseFunnel([
  event({ visitor_id: 'same', event_type: 'view', created_at: '2026-10-01T10:00:00Z' }),
  event({ visitor_id: 'same', event_type: 'convert', goal_id: 'basket', created_at: '2026-10-01T10:01:00Z' }),
  event({ visitor_id: 'same', event_type: 'convert', goal_id: 'details', created_at: '2026-10-01T10:01:00Z' }),
], stepGoals, { activationType: 'page_load' });
assert.strictEqual(sameTime.variants[0].steps[1].visitors, 1);

const skipped = metrics.summariseFunnel([
  event({ visitor_id: 'gap', event_type: 'view', created_at: '2026-10-01T10:00:00Z' }),
  event({ visitor_id: 'gap', event_type: 'convert', goal_id: 'basket', created_at: '2026-10-01T10:01:00Z' }),
  event({ visitor_id: 'gap', event_type: 'convert', goal_id: 'payment', created_at: '2026-10-01T10:03:00Z' }),
], stepGoals, { activationType: 'page_load' });
assert.deepStrictEqual(skipped.variants[0].steps.map((row) => row.visitors), [1, 0, 0, 0]);

const empty = metrics.summariseFunnel([], [{ key: 'cta', type: 'click', label: 'CTA' }], { activationType: 'page_load' });
assert.deepStrictEqual(empty.steps, []);
assert.deepStrictEqual(empty.variants, []);

const strictEmpty = metrics.summariseFunnel([
  event({ visitor_id: 'pay', event_type: 'view', created_at: '2026-10-01T10:00:00Z' }),
  event({ visitor_id: 'pay', event_type: 'convert', goal_id: 'payment', created_at: '2026-10-01T10:03:00Z' }),
], stepGoals, { activationType: 'page_load' });
assert.strictEqual(strictEmpty.variants[0].steps[0].unmeasured, false);
assert.strictEqual(strictEmpty.variants[0].steps[2].visitors, 0);

const delayed = metrics.summariseFunnel([
  event({ visitor_id: 'pay', event_type: 'view', created_at: '2026-10-01T10:00:00Z' }),
  event({ visitor_id: 'pay', event_type: 'convert', goal_id: 'payment', created_at: '2026-10-01T10:03:00Z' }),
  event({ visitor_id: 'pay', event_type: 'convert', goal_id: 'confirmation', created_at: '2026-10-01T10:04:00Z' }),
  event({ visitor_id: 'only-pay', event_type: 'view', created_at: '2026-10-01T11:00:00Z' }),
  event({ visitor_id: 'only-pay', event_type: 'convert', goal_id: 'payment', created_at: '2026-10-01T11:03:00Z' }),
], stepGoals, { activationType: 'element' });
assert.strictEqual(delayed.activation_delays, true);
assert.strictEqual(delayed.baseline_step, 3);
assert.strictEqual(delayed.variants[0].steps[0].unmeasured, true);
assert.strictEqual(delayed.variants[0].steps[0].visitors, null);
assert.strictEqual(delayed.variants[0].steps[1].unmeasured, true);
assert.strictEqual(delayed.variants[0].steps[1].label, 'Details');
assert.strictEqual(delayed.variants[0].steps[2].visitors, 2);
assert.strictEqual(delayed.variants[0].steps[2].rate_of_step_1, 100);
assert.strictEqual(delayed.variants[0].steps[3].visitors, 1);
assert.strictEqual(delayed.variants[0].steps[3].rate_of_step_1, 50);
assert.strictEqual(delayed.variants[0].steps[3].drop_off, 50);
assert.ok(delayed.rule.includes('no variant data'));

console.log('metrics tests passed');
