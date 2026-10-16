// Bucketing must stay close to the configured weights. The incident this
// guards was a 50/50 demo (Control 104, variant-b 146, p ≈ 0.008) fed with
// visitor ids like v_pt<run>-<n>.
const assert = require('assert');
const snippet = require('../snippet/ab.js');
const { detectSRM, chiSquarePValue } = require('../src/srm');

const EXPERIMENT = '7c2bbb45-b87d-4660-8908-7a9f001f9268';
const OTHER = '7c2bbb45-b87d-4660-8908-7a9f001f9269';

function variants(weights) {
  return weights.map((weight, index) => ({
    id: index === 0 ? 'control' : `variant-${index}`,
    name: index === 0 ? 'Control' : `variant-${String.fromCharCode(97 + index)}`,
    traffic_split: weight,
  }));
}

function counts(experimentId, list, ids) {
  const tally = {};
  list.forEach((variant) => { tally[variant.id] = 0; });
  ids.forEach((id) => {
    const chosen = snippet.assignVariant({ id: experimentId, variants: list }, id);
    assert.ok(chosen && tally[chosen.id] != null, `no variant for ${id}`);
    tally[chosen.id] += 1;
  });
  return tally;
}

function idsFor(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) ids.push(`v_ptmuyez2tm-${i}`);
    else if (i % 3 === 1) ids.push(`v_ptrun${(i % 97).toString(36)}-${i}`);
    else ids.push(`v_${(i * 2654435761 >>> 0).toString(36)}-${i.toString(36)}`);
  }
  return ids;
}

const sample = idsFor(10000);
const half = variants([50, 50]);
const numeric = counts(EXPERIMENT, half, sample);
assert.ok(numeric.control > 4500 && numeric.control < 5500, `control ${numeric.control}`);
assert.ok(numeric['variant-1'] > 4500 && numeric['variant-1'] < 5500, `variant-b ${numeric['variant-1']}`);

const asStrings = counts(EXPERIMENT, variants(['50', '50']), sample);
assert.ok(asStrings.control > 4500 && asStrings.control < 5500, `string weights control ${asStrings.control}`);
assert.ok(asStrings['variant-1'] > 4500 && asStrings['variant-1'] < 5500, `string weights variant-b ${asStrings['variant-1']}`);

const sequential = [];
for (let i = 0; i < 10000; i++) sequential.push(`v_pt${(i % 64).toString(36)}-${String(i).padStart(5, '0')}`);
const padded = counts(EXPERIMENT, half, sequential);
assert.ok(padded.control > 4500 && padded.control < 5500, `padded control ${padded.control}`);
assert.ok(padded['variant-1'] > 4500 && padded['variant-1'] < 5500, `padded variant-b ${padded['variant-1']}`);

// Same visitor, two experiment ids that differ by one character, must not
// move together. The old hash agreed on about 98% of these ids.
let same = 0;
sample.forEach((id) => {
  const left = snippet.assignVariant({ id: EXPERIMENT, variants: half }, id);
  const right = snippet.assignVariant({ id: OTHER, variants: half }, id);
  if (left.id === right.id) same += 1;
});
assert.ok(same > 4200 && same < 5800, `experiments moved together ${same} times`);

assert.strictEqual(snippet.assignVariant({ id: EXPERIMENT, variants: half }, 'v_ptabc-1').id, snippet.assignVariant({ id: EXPERIMENT, variants: half }, 'v_ptabc-1').id);
assert.strictEqual(snippet.assignVariant({ id: EXPERIMENT, variants: variants([0, 0]) }, 'v_ptabc-1'), null);
assert.strictEqual(snippet.assignVariant({ id: EXPERIMENT, variants: variants(['', '0']) }, 'v_ptabc-1'), null);
assert.strictEqual(snippet.assignVariant({ id: EXPERIMENT, variants: half }, ''), null);
assert.strictEqual(snippet.assignVariant({ id: EXPERIMENT, variants: [] }, 'v_ptabc-1'), null);

const thirds = variants([20, 30, 50]);
const spread = counts(EXPERIMENT, thirds, sample);
assert.ok(Math.abs(spread.control - 2000) < 400, `20% got ${spread.control}`);
assert.ok(Math.abs(spread['variant-1'] - 3000) < 400, `30% got ${spread['variant-1']}`);
assert.ok(Math.abs(spread['variant-2'] - 5000) < 400, `50% got ${spread['variant-2']}`);

// The reported demo split. p ≈ 0.008 must warn. A 51/49 split of 10,000 must not.
const incident = detectSRM([
  { name: 'Control', visitors: 104, traffic_split: 50 },
  { name: 'variant-b', visitors: 146, traffic_split: 50 },
]);
assert.strictEqual(incident.applicable, true);
assert.ok(incident.p_value < 0.01, `incident p ${incident.p_value}`);
assert.strictEqual(incident.srm_detected, true);

const quiet = detectSRM([
  { name: 'Control', visitors: 5100, traffic_split: 50 },
  { name: 'variant-b', visitors: 4900, traffic_split: 50 },
]);
assert.ok(quiet.p_value > 0.01, `quiet p ${quiet.p_value}`);
assert.strictEqual(quiet.srm_detected, false);

// Textbook: chi-square 3.84, df 1, is about p = 0.05. 6.63 is about p = 0.01.
assert.ok(Math.abs(chiSquarePValue(3.841, 1) - 0.05) < 0.002);
assert.ok(Math.abs(chiSquarePValue(6.635, 1) - 0.01) < 0.001);

console.log('bucket tests passed', JSON.stringify({ numeric, asStrings, padded, same, incident: incident.p_value }));
