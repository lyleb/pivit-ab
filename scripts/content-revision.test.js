// Revision numbers, legacy null events, and the results notice. No database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../snippet/ab.js');
const {
  changesDiffer,
  revisionNumber,
  eventRevision,
  buildRevisionSummary,
  changedWhileRunningLabel,
} = require('../src/content-revision');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

assert.strictEqual(revisionNumber(null), 1);
assert.strictEqual(revisionNumber(undefined), 1);
assert.strictEqual(revisionNumber(0), 1);
assert.strictEqual(revisionNumber('2'), 2);
assert.strictEqual(revisionNumber('2abc'), 1);
assert.strictEqual(revisionNumber(2.5), 1);
assert.strictEqual(revisionNumber(2), 2);

assert.strictEqual(changesDiffer(null, []), false);
assert.strictEqual(changesDiffer([], []), false);
assert.strictEqual(changesDiffer(
  [{ selector: 'h1', type: 'text', value: 'Pay' }],
  [{ value: 'Pay', type: 'text', selector: 'h1' }]
), false);
assert.strictEqual(changesDiffer(
  [{ selector: 'h1', type: 'text', value: 'Pay' }],
  [{ selector: 'h1', type: 'text', value: 'Pay now' }]
), true);
assert.strictEqual(changesDiffer([], null), false);

assert.strictEqual(eventRevision(undefined, 3), 3);
assert.strictEqual(eventRevision(2, 3), 2);
assert.strictEqual(eventRevision(9, 3), 3);
assert.strictEqual(eventRevision(1, null), 1);

const savedAt = '2026-11-12T12:00:00.000Z';
assert.strictEqual(changedWhileRunningLabel(savedAt), 'Changed while running on 12 November 2026');

const summary = buildRevisionSummary({
  counts: [
    { revision: null, visitors: 4 },
    { revision: 2, visitors: 1 },
  ],
  history: [
    { revision: 2, saved_at: savedAt, while_running: true },
  ],
});
assert.strictEqual(summary.spans, true);
assert.ok(summary.notice.includes('more than one version'));
assert.ok(summary.notice.includes('not split by version'));
assert.strictEqual(summary.changed_while_running[0].label, 'Changed while running on 12 November 2026');
assert.strictEqual(summary.revisions[0].revision, 1);
assert.strictEqual(summary.revisions[0].visitors, 4);
assert.strictEqual(summary.revisions[0].line, 'Revision 1 · 4 visitors');
assert.strictEqual(
  summary.revisions[1].line,
  'Revision 2 · Changed while running on 12 November 2026 · 1 visitor'
);

const single = buildRevisionSummary({
  counts: [{ revision: 1, visitors: 3 }],
  history: [],
});
assert.strictEqual(single.spans, false);
assert.strictEqual(single.notice, '');
assert.strictEqual(single.changed_while_running.length, 0);

const view = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'view',
  content_revision: 2,
}, false);
assert.strictEqual(view.content_revision, 2);
const convert = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'convert',
  content_revision: 2,
}, false);
assert.strictEqual(convert.content_revision, 2);
const click = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'click',
  content_revision: 2,
}, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(click, 'content_revision'), false);
const plain = runtime.eventBody({
  experiment_id: 'e',
  variant_id: 'v',
  visitor_id: 'shopper',
  event_type: 'view',
}, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(plain, 'content_revision'), false);

const schema = read('src/db/schema.sql');
const migrateSrc = read('src/db/migrate.js');
const migration = read('src/db/content-revision.js');
assert.ok(!schema.includes('content_revision'), 'content_revision stays out of schema.sql');
assert.ok(migrateSrc.includes("{ version: '025', name: 'content-revision', run: applyContentRevision }"));
assert.ok(migrateSrc.indexOf("version: '024'") < migrateSrc.indexOf("version: '025'"));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS content_revision INTEGER NOT NULL DEFAULT 1'));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS content_revision INTEGER'));
assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS content_revisions'));
assert.ok(!/\bDROP\s/i.test(migration));
assert.ok(!/\bDELETE\s+FROM\b/i.test(migration));
assert.ok(!/\bTRUNCATE\b/i.test(migration));
assert.ok(!/\bUPDATE\s/i.test(migration));

const experiments = read('src/routes/experiments.js');
const patchAt = experiments.indexOf("router.patch('/:id/variants/:variantId'");
assert.ok(patchAt !== -1);
const patch = experiments.slice(patchAt, patchAt + 2200);
assert.ok(patch.includes('refuseViewOnly(req, res)'));
assert.ok(patch.indexOf('refuseViewOnly(req, res)') < patch.indexOf('recordContentRevision'));

const ui = require('../public/admin-ui.js');
assert.strictEqual(ui.revisionLabel(null), 'Revision 1');
assert.strictEqual(ui.revisionLabel(3), 'Revision 3');
const html = ui.renderRevisionNotice(summary);
assert.ok(html.includes('Changed while running on 12 November 2026'));
assert.ok(html.includes('more than one version'));
assert.ok(html.includes('Revision 2 · Changed while running on 12 November 2026 · 1 visitor'));
assert.strictEqual(ui.renderRevisionNotice(single), '');

const dashboard = read('public/index.html');
assert.ok(dashboard.includes('paintRevisionNotice'));
assert.ok(dashboard.includes('UI.revisionLabel'));
assert.ok(dashboard.includes('id="revision-notice"'));

console.log('content revision tests passed');
