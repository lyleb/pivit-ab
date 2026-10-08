const assert = require('assert');
const plan = require('../src/plan');
const reading = require('../src/reading');

const z = plan.normalQuantile(0.975);
assert.ok(Math.abs(z - 1.95996398454) < 1e-6, z);
assert.ok(Math.abs(plan.normalQuantile(0.8) - 0.84162123357) < 1e-6);

const two = plan.buildPlan({
  baseline_rate: 0.03,
  relative_effect: 0.1,
  effect_choice: 'medium',
  weekly_traffic: 5000,
  min_runtime_days: 14,
  variant_count: 2,
  source: 'auto',
});
assert.strictEqual(two.ok, true);
assert.ok(two.plan.visitors_per_variant > 1000);
assert.strictEqual(two.plan.comparisons, 1);
assert.strictEqual(two.plan.bonferroni, false);
assert.strictEqual(two.plan.source, 'auto');
assert.strictEqual(two.plan.alpha_per_comparison, 0.05);
assert.ok(two.plan.sentence.startsWith("You'll need about "));
assert.ok(two.plan.sentence.includes('visitors per variant'));
assert.ok(!two.plan.sentence.includes('MDE'));
assert.ok(two.plan.explanation.includes('80%'));
assert.ok(two.plan.explanation.includes('once'));

const three = plan.buildPlan({
  baseline_rate: 0.03,
  effect_choice: 'medium',
  weekly_traffic: 5000,
  min_runtime_days: 14,
  variant_count: 3,
});
assert.strictEqual(three.ok, true);
assert.strictEqual(three.plan.comparisons, 2);
assert.strictEqual(three.plan.bonferroni, true);
assert.ok(three.plan.visitors_per_variant > two.plan.visitors_per_variant);
assert.ok(three.plan.explanation.includes('2.5%'));
assert.ok(three.plan.explanation.toLowerCase().includes('bonferroni'));

assert.strictEqual(plan.buildPlan({ baseline_rate: 0.03, effect_choice: 'medium', min_runtime_days: 6 }).ok, false);
assert.strictEqual(plan.buildPlan({ baseline_rate: 0, effect_choice: 'medium', min_runtime_days: 14 }).ok, false);

const noTraffic = plan.buildPlan({
  baseline_rate: 3,
  effect_choice: 'big',
  min_runtime_days: 7,
  variant_count: 2,
});
assert.strictEqual(noTraffic.ok, true);
assert.strictEqual(noTraffic.plan.baseline_rate, 0.03);
assert.strictEqual(noTraffic.plan.relative_effect, 0.2);
assert.strictEqual(noTraffic.plan.estimated_weeks, null);
assert.ok(noTraffic.plan.sentence.includes('Add weekly traffic'));
assert.ok(noTraffic.plan.runtime_warning.includes('One week'));

const auto = plan.autoPlanInput({
  baseline_rate: 0.04,
  baseline_source: 'history',
  weekly_traffic: 800,
  traffic_source: 'visitors',
}, [
  { name: 'Control', traffic_split: 50, enabled: true },
  { name: 'B', traffic_split: 50, enabled: true },
]);
assert.strictEqual(auto.effect_choice, 'medium');
assert.strictEqual(auto.source, 'auto');
assert.strictEqual(auto.min_runtime_days, 14);
const saved = plan.buildPlan(auto);
assert.strictEqual(saved.plan.source, 'auto');
assert.ok(saved.plan.estimated_weeks >= 1);

const progress = reading.planProgress({
  plan: two.plan,
  startedAt: new Date('2026-10-01T00:00:00Z'),
  now: new Date('2026-10-04T00:00:00Z'),
  variants: [
    { id: 'a', name: 'Control', visitors: 10, traffic_split: 50, enabled: true },
    { id: 'b', name: 'B', visitors: two.plan.visitors_per_variant, traffic_split: 50, enabled: true },
  ],
});
assert.strictEqual(progress.days_elapsed, 3);
assert.strictEqual(progress.runtime_met, false);
assert.strictEqual(progress.sample_met, false);
assert.strictEqual(progress.plan_met, false);

const done = reading.planProgress({
  plan: { visitors_per_variant: 10, min_runtime_days: 14 },
  startedAt: new Date('2026-09-01T00:00:00Z'),
  now: new Date('2026-10-01T00:00:00Z'),
  variants: [
    { name: 'Control', visitors: 10, enabled: true },
    { name: 'B', visitors: 12, enabled: true },
  ],
});
assert.strictEqual(done.plan_met, true);

assert.strictEqual(reading.describeReading({ status: 'running', plan: null, progress: done }).mode, 'unplanned');
assert.strictEqual(reading.describeReading({ status: 'running', plan: null, progress: done }).outcome_visible, true);
assert.strictEqual(reading.describeReading({ status: 'running', plan: two.plan, progress, peekedAt: null }).mode, 'blind');
assert.strictEqual(reading.describeReading({ status: 'running', plan: two.plan, progress, peekedAt: null }).outcome_visible, false);
assert.strictEqual(reading.describeReading({ status: 'running', plan: two.plan, progress, peekedAt: '2026-10-02' }).mode, 'peeked');
assert.strictEqual(reading.describeReading({ status: 'running', plan: two.plan, progress: done, peekedAt: null }).mode, 'verdict');
assert.strictEqual(reading.describeReading({
  status: 'running', plan: two.plan, progress: done, srmDetected: true,
}).mode, 'data_problem');
assert.strictEqual(reading.listSignal('running', { mode: 'blind', days_elapsed: 3, min_runtime_days: 14 }), 'Health check · 3 of 14 days');
assert.strictEqual(reading.listSignal('running', { mode: 'unplanned' }), 'Set a plan');
assert.ok(!reading.listSignal('running', { mode: 'blind', days_elapsed: 1, min_runtime_days: 14 }).includes('prob'));

console.log('plan tests passed', {
  two: two.plan.visitors_per_variant,
  three: three.plan.visitors_per_variant,
  sentence: two.plan.sentence,
});
