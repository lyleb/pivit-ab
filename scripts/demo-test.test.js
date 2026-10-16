// Demo tests are a separate type: test traffic only, a fixed sample, and a
// runtime waiver that a live plan cannot opt into.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const plan = require('../src/plan');
const reading = require('../src/reading');
const demo = require('../src/demo-test');
const ui = require('../public/admin-ui.js');
const snippet = require('../snippet/ab.js');
const { conclusionPdf, approvalPdf } = require('../src/conclusion-doc');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const sample = [
  { name: 'Control', visitors: 100, enabled: true, traffic_split: 50 },
  { name: 'Challenger', visitors: 100, enabled: true, traffic_split: 50 },
];

const built = demo.demoPlan({ variantCount: 2 });
assert.strictEqual(built.demo, true);
assert.strictEqual(built.runtime_waived, true);
assert.strictEqual(built.test_traffic_only, true);
assert.strictEqual(built.visitors_per_variant, 100);
assert.strictEqual(built.min_runtime_days, 0);
assert.strictEqual(built.method, 'demo-fixed-sample');
assert.ok(built.explanation.includes('pivitlab'));
assert.ok(built.explanation.includes(demo.RUNTIME_NOTE));
assert.ok(!built.explanation.includes('Pivitlab'));

const three = demo.demoPlan({ variantCount: 3 });
assert.strictEqual(three.visitors_per_variant, 100);
assert.strictEqual(three.comparisons, 2);
assert.strictEqual(three.bonferroni, true);

const now = new Date('2026-10-16T12:00:00Z');
const met = reading.planProgress({ plan: built, startedAt: now, now, variants: sample });
assert.strictEqual(met.sample_met, true);
assert.strictEqual(met.runtime_met, true);
assert.strictEqual(met.plan_met, true);
assert.strictEqual(met.days_elapsed, 0);

const short = reading.planProgress({
  plan: built,
  startedAt: now,
  now,
  variants: [{ name: 'Control', visitors: 99, enabled: true, traffic_split: 50 }, sample[1]],
});
assert.strictEqual(short.plan_met, false);

const liveZero = reading.planProgress({
  plan: { visitors_per_variant: 100, min_runtime_days: 0, demo: false, runtime_waived: false },
  startedAt: now,
  now,
  variants: sample,
});
assert.strictEqual(liveZero.sample_met, true);
assert.strictEqual(liveZero.runtime_met, false);
assert.strictEqual(liveZero.plan_met, false);

const forged = reading.planProgress({
  plan: { visitors_per_variant: 100, min_runtime_days: 0, runtime_waived: true },
  startedAt: now,
  now,
  variants: sample,
});
assert.strictEqual(forged.runtime_met, false);
assert.strictEqual(demo.runtimeWaived(forged.plan), false);
assert.strictEqual(demo.runtimeWaived(built), true);

assert.strictEqual(plan.buildPlan({ baseline_rate: 0.03, effect_choice: 'medium', min_runtime_days: 6 }).ok, false);
const livePlan = plan.buildPlan({
  baseline_rate: 0.03,
  effect_choice: 'medium',
  min_runtime_days: 14,
  variant_count: 2,
  demo: true,
  runtime_waived: true,
});
assert.strictEqual(livePlan.ok, true);
assert.strictEqual(livePlan.plan.demo, undefined);
assert.strictEqual(livePlan.plan.runtime_waived, undefined);
assert.ok(livePlan.plan.min_runtime_days >= 7);

assert.deepStrictEqual(demo.countOptions({ test_type: 'demo' }, true), { testOnly: true });
assert.deepStrictEqual(demo.countOptions({ test_type: 'live' }, true), { includeTest: true });
assert.deepStrictEqual(demo.countOptions({ test_type: 'live' }, false), { includeTest: false });
assert.strictEqual(demo.isDemo({ test_type: 'demo' }), true);
assert.strictEqual(demo.isDemo({ test_type: 'live', plan: { demo: true } }), false);
assert.strictEqual(demo.isDemo({ plan: { demo: true } }), true);

assert.strictEqual(demo.normaliseTestType('demo').type, 'demo');
assert.strictEqual(demo.normaliseTestType(undefined).type, 'live');
assert.strictEqual(demo.normaliseTestType('qa').ok, false);
assert.strictEqual(demo.typeChangeError({ test_type: 'demo' }, { test_type: 'live' }), demo.SWITCH_ERROR);
assert.strictEqual(demo.typeChangeError({ test_type: 'live' }, { demo: true }), 'A live test cannot be changed into a demo.');
assert.strictEqual(demo.typeChangeError({ test_type: 'demo' }, { status: 'running' }), null);
assert.ok(demo.PLAN_LOCKED_ERROR.includes('100 visitors per variant'));
assert.ok(demo.PLAN_LOCKED_ERROR.includes('cannot be switched to live'));

assert.strictEqual(snippet.mayBucketExperiment({ test_type: 'demo' }, 'visitor-1', false), false);
assert.strictEqual(snippet.mayBucketExperiment({ test_type: 'demo' }, 'v_ptabc', false), true);
assert.strictEqual(snippet.mayBucketExperiment({ test_type: 'demo' }, 'visitor-1', true), true);
assert.strictEqual(snippet.mayBucketExperiment({ test_type: 'live' }, 'visitor-1', false), true);
assert.strictEqual(snippet.mayBucketExperiment(null, 'visitor-1', false), true);

const badge = ui.demoBadgeHtml();
assert.ok(badge.includes('class="badge demo"'));
assert.ok(badge.includes('>Demo<'));
assert.strictEqual(ui.demoRuntimeNote(), demo.RUNTIME_NOTE);
assert.strictEqual(ui.isDemoTest({ test_type: 'demo' }), true);
assert.strictEqual(ui.isDemoTest({ test_type: 'live' }), false);
const planHtml = ui.demoPlanHtml();
assert.ok(planHtml.includes('data-demo-plan="1"'));
assert.ok(planHtml.includes('100 visitors per variant'));
assert.ok(planHtml.includes('cannot be switched to live'));
assert.ok(planHtml.includes('pivitlab'));
assert.ok(planHtml.includes(demo.RUNTIME_NOTE));

const index = read('public/index.html');
const client = read('public/client.html');
const css = read('public/assets/pivit.css');
assert.ok(index.includes('id="wizard-type"'));
assert.ok(index.includes('value="demo">Demo</option>'));
assert.ok(index.includes('UI.demoBadgeHtml()'));
assert.ok(index.includes('This demo test counts test traffic only'));
assert.ok(index.includes('href="/assets/pivit.css?v=7"'));
const demoCopyAt = index.indexOf('This demo test counts test traffic only');
assert.ok(demoCopyAt > 0);
assert.ok(!index.slice(demoCopyAt, demoCopyAt + 400).includes('not the verdict'));
assert.ok(client.includes('UI.demoBadgeHtml()'));
assert.ok(client.includes('UI.demoRuntimeNote()'));
assert.ok(client.includes('href="/assets/pivit.css?v=7"'));
assert.ok(/\.badge\.demo\s*\{[^}]*text-transform:\s*none/.test(css));

const schema = read('src/db/schema.sql');
const migrateSrc = read('src/db/migrate.js');
const migration = read('src/db/demo-test.js');
assert.ok(!schema.includes('test_type'));
assert.ok(migrateSrc.includes("{ version: '013', name: 'demo-test', run: applyDemoTest }"));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS test_type'));
assert.ok(migration.includes("DEFAULT 'live'"));
assert.ok(!/\bDROP\s/i.test(migration));
assert.ok(!/\bDELETE\s+FROM\b/i.test(migration));
assert.ok(!/\bTRUNCATE\b/i.test(migration));

const pdf = conclusionPdf({
  brand: 'pivitlab',
  experiment_name: 'Homepage demo',
  demo: true,
  concluded: {
    label: 'Win',
    variant_name: 'Challenger',
    summary: 'Ahead on test traffic.',
    range_label: '+1% to +4%',
    rows: [],
  },
});
const pdfText = pdf.toString('latin1');
assert.ok(pdfText.includes('(Demo)'));
assert.ok(pdfText.includes('14-day'));
assert.ok(pdfText.includes('Test traffic only'));
assert.ok(pdfText.includes('demo test'));
const livePdf = conclusionPdf({
  experiment_name: 'Homepage',
  demo: false,
  concluded: { label: 'Win', variant_name: 'Challenger', summary: 'Ahead.', rows: [] },
});
assert.ok(!livePdf.toString('latin1').includes('(Demo)'));
const approval = approvalPdf({
  experimentName: 'Homepage demo',
  approverName: 'North Shop',
  approvedAt: now,
  demo: true,
});
const approvalText = approval.toString('latin1');
assert.ok(approvalText.includes('(Demo)'));
assert.ok(approvalText.includes('test traffic only'));

console.log('demo test unit tests passed');
