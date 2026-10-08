const assert = require('assert');
const { buildVerdict, ruleOutLine } = require('../src/verdict');
const { mulberry32 } = require('../src/rng');
const { computeBayesianStats } = require('../src/bayesian');

const line = ruleOutLine(-0.02, 0.04);
assert.ok(line.includes('+4%'), line);
assert.ok(/unlikely/i.test(line));
assert.ok(!/mde/i.test(line));

const plan = { visitors_per_variant: 1000, comparisons: 1, alpha_per_comparison: 0.05 };
const random = mulberry32(7);
const win = buildVerdict({
  plan,
  draws: 2000,
  random,
  variants: [
    { variant_id: 'c', variant_name: 'Control', visitors: 2000, conversions: 200 },
    { variant_id: 'b', variant_name: 'B', visitors: 2000, conversions: 400 },
  ],
});
assert.strictEqual(win.challengers[0].verdict, 'win');
assert.strictEqual(win.challengers[0].label, 'Win');
assert.ok(win.challengers[0].ci_low > 0);
assert.ok(win.challengers[0].rule_out.includes('unlikely'));
assert.ok(Array.isArray(win.probability_best));
assert.ok(win.probability_best.length === 2);

const again = buildVerdict({
  plan,
  draws: 2000,
  random: mulberry32(7),
  variants: [
    { variant_id: 'c', variant_name: 'Control', visitors: 2000, conversions: 200 },
    { variant_id: 'b', variant_name: 'B', visitors: 2000, conversions: 400 },
  ],
});
assert.strictEqual(again.challengers[0].uplift_label, win.challengers[0].uplift_label);
assert.strictEqual(again.probability_best[1].probability_best, win.probability_best[1].probability_best);

const loss = buildVerdict({
  plan,
  draws: 1500,
  random: mulberry32(9),
  variants: [
    { variant_id: 'c', variant_name: 'Control', visitors: 2000, conversions: 400 },
    { variant_id: 'b', variant_name: 'B', visitors: 2000, conversions: 200 },
  ],
});
assert.strictEqual(loss.challengers[0].verdict, 'loss');

const quiet = buildVerdict({
  plan,
  draws: 800,
  random: mulberry32(3),
  variants: [
    { variant_id: 'c', variant_name: 'Control', visitors: 400, conversions: 40 },
    { variant_id: 'b', variant_name: 'B', visitors: 400, conversions: 42 },
  ],
});
assert.strictEqual(quiet.challengers[0].verdict, 'inconclusive');
assert.ok(quiet.challengers[0].ci_low < 0 && quiet.challengers[0].ci_high > 0);

const broken = buildVerdict({
  plan,
  srmDetected: true,
  variants: [
    { variant_id: 'c', variant_name: 'Control', visitors: 2000, conversions: 200 },
    { variant_id: 'b', variant_name: 'B', visitors: 2000, conversions: 400 },
  ],
});
assert.strictEqual(broken.verdict, 'data_problem');
assert.strictEqual(broken.label, 'Data problem');
assert.strictEqual(broken.challengers.length, 0);

const seeded = computeBayesianStats([
  { variant_id: 'c', variant_name: 'Control', visitors: 50, conversions: 5 },
  { variant_id: 'b', variant_name: 'B', visitors: 50, conversions: 8 },
], 500, { random: mulberry32(1) });
const seededAgain = computeBayesianStats([
  { variant_id: 'c', variant_name: 'Control', visitors: 50, conversions: 5 },
  { variant_id: 'b', variant_name: 'B', visitors: 50, conversions: 8 },
], 500, { random: mulberry32(1) });
assert.deepStrictEqual(seeded, seededAgain);
assert.ok(seeded[0].probability_best != null);

console.log('verdict tests passed', {
  win: win.challengers[0].uplift_label,
  range: `${win.challengers[0].ci_low_label} to ${win.challengers[0].ci_high_label}`,
  rule: win.challengers[0].rule_out,
});
