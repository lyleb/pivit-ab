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

console.log('metrics tests passed');
