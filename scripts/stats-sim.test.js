// Fast subset of the A/A and power checks. Seeded, so the rates do not flicker.
// A longer cross-check against spotify-confidence is scripts/confidence_crosscheck.py
// and is not part of npm test.

const assert = require('assert');
const { runSimulation } = require('../src/simulate');

const aa = runSimulation({
  baseline: 0.1,
  relative: 0.5,
  variantCount: 2,
  runs: 200,
  draws: 4000,
  seed: 20261008,
  kind: 'aa',
});
const power = runSimulation({
  baseline: 0.1,
  relative: 0.5,
  variantCount: 2,
  runs: 200,
  draws: 4000,
  seed: 20261008,
  kind: 'power',
});
const family = runSimulation({
  baseline: 0.1,
  relative: 0.5,
  variantCount: 3,
  runs: 120,
  draws: 4000,
  seed: 20261008,
  kind: 'aa',
});

// Seeded counts. A/A is a little under 5% because the flat prior interval is
// slightly cautious. Power lands on the planned 80%. Three variants, with the
// Bonferroni bar, stay near 5% rather than about 10%.
assert.strictEqual(aa.hits, 4);
assert.strictEqual(power.hits, 162);
assert.strictEqual(family.hits, 6);
assert.ok(aa.rate < 0.1);
assert.ok(power.rate > 0.7 && power.rate < 0.9);
assert.ok(family.rate < 0.12);

console.log('stats simulation', JSON.stringify({ aa, power, family }, null, 2));
