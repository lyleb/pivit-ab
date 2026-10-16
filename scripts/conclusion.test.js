// Conclusion documents copy the stored result. They do not run the stats engine.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { freezeConclusion, conclusionPdf, approvalPdf, METHOD } = require('../src/conclusion-doc');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function assertAdditiveMigration() {
  const schema = read('src/db/schema.sql');
  const migrateSrc = read('src/db/migrate.js');
  const migration = read('src/db/conclusion.js');
  assert.ok(!schema.includes('conclusion_reports'));
  assert.ok(!schema.includes('conclusion_approvals'));
  assert.ok(!schema.includes('owner_notices'));
  assert.ok(migrateSrc.includes("{ version: '010', name: 'conclusion', run: applyConclusion }"));
  assert.ok(migrateSrc.includes("{ version: '000', name: 'baseline', run: applyBaseline }"));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS conclusion_reports'));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS conclusion_approvals'));
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS owner_notices'));
  assert.ok(!/\bDROP\s/i.test(migration));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(migration));
  assert.ok(!/\bTRUNCATE\b/i.test(migration));
  assert.ok(!/\bUPDATE\s/i.test(migration));
  assert.ok(!/\bALTER\s/i.test(migration));
  assert.ok(migration.includes('ON DELETE CASCADE'));
}

function assertNoStatsEngine(rel) {
  const source = read(rel);
  assert.ok(!source.includes("require('./verdict')"));
  assert.ok(!source.includes("require('./bayesian')"));
  assert.ok(!source.includes('buildVerdict'));
  assert.ok(!source.includes('computeBayesianStats'));
}

const stored = {
  public: {
    concluded: {
      label: 'Win',
      variant_name: 'Green',
      summary: 'Green lifted purchases by about +12%.',
      range_label: '+4% to +21%',
      range_line: '95% range +4% to +21%',
      verdict_line: 'Green: +12% purchases',
      probability_label: '91% chance Green is better than Control',
      rows: [{ version: 'Green', visitors: 17, conversions: 4, rate: '23.5%' }],
      goal_label: 'Purchases',
      visitors: 17,
      days: 14,
      finished_label: '13 Oct',
      whats_next: [{ title: 'Roll out the winner.', body: 'Make Green permanent on your site.' }],
    },
  },
};

assertAdditiveMigration();
assertNoStatsEngine('src/conclusion.js');
assertNoStatsEngine('src/conclusion-doc.js');
assert.ok(METHOD.includes('labelled'));
assert.ok(METHOD.includes('favour'));
assert.ok(!METHOD.includes('labeled'));
assert.ok(!/\bfavor\b/.test(METHOD));

const experiment = {
  name: 'Shop tags',
  hypothesis: 'Green sells more.',
  url_match: '/shop',
  url_match_type: 'contains',
  goals: [{ name: 'Purchase', primary: true }],
  peeked_at: null,
};
const frozen = freezeConclusion(experiment, { detail: stored, snapshot_date: '2026-10-13' }, '2026-10-13');
assert.strictEqual(frozen.brand, 'pivitlab');
assert.strictEqual(frozen.concluded.visitors, 17);
assert.strictEqual(frozen.concluded.rows[0].conversions, 4);
assert.strictEqual(frozen.concluded.summary, 'Green lifted purchases by about +12%.');
assert.strictEqual(freezeConclusion(experiment, { detail: { public: { headline: 'Collecting data' } } }, '2026-10-13'), null);

const pdf = conclusionPdf(frozen).toString('latin1');
assert.ok(pdf.startsWith('%PDF-1.4'));
assert.ok(pdf.includes('pivitlab'));
assert.ok(!pdf.includes('Pivit'));
assert.ok(!pdf.includes('PIVIT'));
assert.ok(pdf.includes('labelled'));
assert.ok(pdf.includes('favour'));
assert.ok(!pdf.includes('labeled'));
assert.ok(!/\bfavor\b/.test(pdf));
assert.ok(pdf.includes('Green lifted purchases by about +12%.'));
assert.ok(pdf.includes('91% chance Green is better than Control'));
assert.ok(pdf.includes('23.5%'));
assert.ok(pdf.includes('credible'));
assert.ok(pdf.includes('recalculate'));
assert.ok(pdf.includes('13 October 2026'));
assert.ok(pdf.includes('Built by Heclr'));
assert.ok(pdf.includes('/Subtype /Image'));
assert.ok(pdf.includes('/ImLogo'));

const approval = approvalPdf({
  experimentName: 'Shop tags',
  approverName: 'North Shop',
  approvedAt: new Date('2026-10-13T08:14:00Z'),
  releasedAt: new Date('2026-10-13T07:02:00Z'),
}).toString('latin1');
assert.ok(approval.startsWith('%PDF-1.4'));
assert.ok(approval.includes('pivitlab'));
assert.ok(!approval.includes('Pivit'));
assert.ok(approval.includes('Approval record'));
assert.ok(approval.includes('North Shop'));
assert.ok(approval.includes('click to approve'));
assert.ok(approval.includes('not a paper signature'));
assert.ok(approval.includes('UK time'));
assert.ok(approval.includes('Built by Heclr'));

console.log('conclusion tests passed');
