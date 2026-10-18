// Split badge: same p < 0.01 bar as the sample-ratio check, and no
// Split OK / Split skewed verdict until 100 visitors.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { detectSRM, SRM_P_VALUE_THRESHOLD } = require('../src/srm');
const { splitCheck, splitCheckFromVariants, SPLIT_CHECK_MIN_VISITORS } = require('../src/split-check');
const ui = require('../public/admin-ui');

assert.strictEqual(SPLIT_CHECK_MIN_VISITORS, 100);
assert.strictEqual(SRM_P_VALUE_THRESHOLD, 0.01);

function fromCounts(rows) {
  const srm = detectSRM(rows);
  return { srm, badge: splitCheckFromVariants(srm, rows) };
}

// The reported demo split. 250 visitors, p < 0.01, so the pill says skewed.
const incident = fromCounts([
  { name: 'Control', visitors: 104, traffic_split: 50 },
  { name: 'variant-b', visitors: 146, traffic_split: 50 },
]);
assert.ok(incident.srm.p_value < 0.01, `incident p ${incident.srm.p_value}`);
assert.strictEqual(incident.srm.srm_detected, true);
assert.strictEqual(incident.badge.state, 'skewed');
assert.strictEqual(incident.badge.show, true);
assert.strictEqual(incident.badge.label, 'Split skewed');
assert.strictEqual(incident.badge.tooltip, "Visitors aren't splitting as set; results may be unreliable");
assert.strictEqual(incident.badge.srmDetected, true);
assert.strictEqual(incident.badge.threshold, 0.01);
assert.strictEqual(incident.badge.visitors, 250);

// A calm 50/50 of 10,000 stays Split OK. p stays above 0.01.
const quiet = fromCounts([
  { name: 'Control', visitors: 5100, traffic_split: 50 },
  { name: 'variant-b', visitors: 4900, traffic_split: 50 },
]);
assert.ok(quiet.srm.p_value > 0.01, `quiet p ${quiet.srm.p_value}`);
assert.strictEqual(quiet.srm.srm_detected, false);
assert.strictEqual(quiet.badge.state, 'ok');
assert.strictEqual(quiet.badge.show, true);
assert.strictEqual(quiet.badge.label, 'Split OK');
assert.strictEqual(quiet.badge.tooltip, 'Visitors are splitting as expected');

// Exactly 100 visitors is enough. A wild split is skewed; an even split is OK.
const atFloor = fromCounts([
  { name: 'Control', visitors: 10, traffic_split: 50 },
  { name: 'variant-b', visitors: 90, traffic_split: 50 },
]);
assert.strictEqual(atFloor.badge.visitors, 100);
assert.ok(atFloor.srm.p_value < 0.01);
assert.strictEqual(atFloor.badge.state, 'skewed');
assert.strictEqual(atFloor.badge.show, true);

const evenFloor = fromCounts([
  { name: 'Control', visitors: 50, traffic_split: 50 },
  { name: 'variant-b', visitors: 50, traffic_split: 50 },
]);
assert.strictEqual(evenFloor.badge.visitors, 100);
assert.strictEqual(evenFloor.srm.srm_detected, false);
assert.strictEqual(evenFloor.badge.state, 'ok');

// 99 visitors stays hidden even when the chi-square would already flag it.
const early = fromCounts([
  { name: 'Control', visitors: 10, traffic_split: 50 },
  { name: 'variant-b', visitors: 89, traffic_split: 50 },
]);
assert.strictEqual(early.badge.visitors, 99);
assert.ok(early.srm.p_value < 0.01, `early p ${early.srm.p_value}`);
assert.strictEqual(early.srm.srm_detected, true);
assert.strictEqual(early.badge.srmDetected, true);
assert.strictEqual(early.badge.state, 'early');
assert.strictEqual(early.badge.show, false);
assert.strictEqual(early.badge.label, 'Too early');
assert.ok(!early.badge.label.includes('Split'));

const quietEarly = splitCheck({ srmDetected: false, applicable: true, totalVisitors: 40 });
assert.strictEqual(quietEarly.state, 'early');
assert.strictEqual(quietEarly.show, false);

// One variant, or no traffic, is not a split check yet.
const single = fromCounts([{ name: 'Control', visitors: 400, traffic_split: 100 }]);
assert.strictEqual(single.srm.applicable, false);
assert.strictEqual(single.badge.state, 'early');
assert.strictEqual(single.badge.show, false);

const empty = splitCheckFromVariants(null, []);
assert.strictEqual(empty.state, 'early');
assert.strictEqual(empty.show, false);

// A paused variant's visitors do not count toward the 100.
const paused = splitCheckFromVariants(
  detectSRM([{ name: 'Control', visitors: 60, traffic_split: 50 }, { name: 'variant-b', visitors: 60, traffic_split: 50 }]),
  [
    { name: 'Control', visitors: 60, traffic_split: 50, enabled: true },
    { name: 'variant-b', visitors: 60, traffic_split: 50, enabled: true },
    { name: 'old', visitors: 500, traffic_split: 0, enabled: false },
  ]
);
assert.strictEqual(paused.visitors, 120);
assert.strictEqual(paused.state, 'ok');

const pillOk = ui.splitPillHtml(quiet.badge, '11111111-1111-1111-1111-111111111111');
assert.ok(pillOk.includes('class="split-pill ok"'));
assert.ok(pillOk.includes('href="#srm-panel"'));
assert.ok(pillOk.includes('data-open-srm="11111111-1111-1111-1111-111111111111"'));
assert.ok(pillOk.includes('title="Visitors are splitting as expected"'));
assert.ok(pillOk.includes('>Split OK</a>'));

const pillSkewed = ui.splitPillHtml(incident.badge);
assert.ok(pillSkewed.includes('class="split-pill skewed"'));
assert.ok(pillSkewed.includes('>Split skewed</a>'));
assert.ok(pillSkewed.includes("Visitors aren&#39;t splitting as set; results may be unreliable"));
assert.ok(!pillSkewed.includes('data-open-srm'));

const pillEarly = ui.splitPillHtml(early.badge);
assert.ok(pillEarly.includes('class="split-pill early"'));
assert.ok(pillEarly.includes('>Too early</a>'));
assert.ok(!pillEarly.includes('Split OK'));
assert.ok(!pillEarly.includes('Split skewed'));
assert.strictEqual(ui.splitPillHtml(null), '');

[pillOk, pillSkewed, pillEarly].forEach((html) => {
  assert.ok(!/pivitlab/i.test(html.replace(/href="#srm-panel"/, '')));
  assert.ok(!html.includes('color'));
});

const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
assert.ok(index.includes('id="split-badge"'));
assert.ok(index.includes('id="srm-panel"'));
assert.ok(index.includes('data-label="Split"'));
assert.ok(index.includes('UI.splitPillHtml(exp.splitCheck, exp.id)'));
assert.strictEqual(index.split('id="srm-panel"').length - 1, 1);
assert.ok(client.includes('UI.splitPillHtml(item.splitCheck, item.id)'));
assert.ok(client.includes('id="srm-panel"'));
assert.ok(client.includes('function splitBlock'));

console.log('split-check tests passed');
