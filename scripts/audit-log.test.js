// Audit log screen copy, query building, and migration 014 registration.
// No database. British English, and pivitlab stays lowercase.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');
const { parseAuditQuery, DEFAULT_PAGE_SIZE, LEGACY_PAGE_SIZE, MAX_PAGE_SIZE } = require('../src/audit-log');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const schema = read('src/db/schema.sql');
const migrateSrc = read('src/db/migrate.js');
const migration = read('src/db/audit-backfill.js');
const admin = read('public/index.html');
const client = read('public/client.html');
const css = read('public/assets/pivit.css');

assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS test_traffic_audit'));
assert.ok(!schema.includes('audit-backfill'));
assert.ok(!schema.includes("version: '014'"));
assert.ok(migrateSrc.includes("{ version: '000', name: 'baseline', run: applyBaseline }"));
assert.ok(migrateSrc.includes("{ version: '014', name: 'audit-backfill', run: applyAuditBackfill }"));
assert.ok(migrateSrc.indexOf("version: '013'") < migrateSrc.indexOf("version: '014'"));
assert.ok(migration.includes('INSERT INTO audit_log'));
assert.ok(migration.includes('FROM test_traffic_audit'));
assert.ok(migration.includes("WHEN 'remove' THEN 'test_traffic_remove'"));
assert.ok(migration.includes("WHEN 'restore' THEN 'test_traffic_restore'"));
assert.ok(migration.includes("l.detail->>'source_audit_id'"));
assert.ok(!/\bDROP\s/i.test(migration));
assert.ok(!/\bDELETE\s+FROM\b/i.test(migration));
assert.ok(!/\bTRUNCATE\b/i.test(migration));
assert.ok(!/\bUPDATE\s/i.test(migration));

assert.ok(admin.includes('id="nav-page-audit"'));
assert.ok(admin.includes('data-go="#audit"'));
assert.ok(admin.includes('>Audit log</button>'));
assert.ok(admin.includes('id="page-audit"'));
assert.ok(admin.includes('id="audit-test"'));
assert.ok(admin.includes('id="audit-user"'));
assert.ok(admin.includes('id="audit-action"'));
assert.ok(admin.includes('id="audit-prev"'));
assert.ok(admin.includes('id="audit-next"'));
assert.ok(admin.includes('class="brand-logo"'));
assert.ok(admin.includes('aria-label="pivitlab"'));
assert.ok(css.includes('pivitlab-logo-white.svg'));
assert.ok(admin.includes('What happened in this agency in pivitlab. Newest first.'));
assert.ok(!admin.includes('Pivitlab'));
assert.ok(!admin.includes('PivitLab'));
assert.ok(!client.includes('id="page-audit"'));
assert.ok(!client.includes('id="nav-page-audit"'));

const hintAt = admin.indexOf('What happened in this agency in pivitlab.');
assert.ok(hintAt > 0);
const hint = admin.slice(hintAt, hintAt + 180);
assert.ok(!/behavior|favorite|organize|color\b/i.test(hint));
assert.ok(hint.includes('Only an owner of this agency can see these events.'));

assert.strictEqual(ui.auditActionLabel('role_change'), 'Changed a role');
assert.strictEqual(ui.auditActionLabel('test_traffic_remove'), 'Removed test traffic');
assert.strictEqual(ui.auditActionLabel('test_traffic_restore'), 'Restored test traffic');
assert.strictEqual(ui.auditActionLabel('reveal'), 'Revealed early');
assert.ok(!ui.auditActionLabel('role_change').includes('Pivit'));
assert.strictEqual(
  ui.auditDetailText({
    action: 'role_change',
    detail: { email: 'ada@example.co.uk', from_role: 'member', to_role: 'owner' },
  }),
  'ada@example.co.uk, from Member to Owner'
);
assert.strictEqual(
  ui.auditDetailText({
    action: 'test_traffic_remove',
    detail: { criteria: { mode: 'prefix', prefix: 'v_pt_' }, visitor_count: 1, event_count: 2 },
  }),
  'Prefix v_pt_. 1 visitor, 2 events.'
);
assert.strictEqual(
  ui.auditDetailText({
    action: 'test_traffic_remove',
    detail: { criteria: { mode: 'all' }, visitor_count: 2, event_count: 3 },
  }),
  'All test traffic. 2 visitors, 3 events.'
);

assert.strictEqual(ui.auditRoute('#home'), null);
assert.deepStrictEqual(ui.auditRoute('#audit'), { test: '', user: '', action: '', page: 1 });
assert.deepStrictEqual(ui.auditRoute('#audit?test=abc&user=ada&action=role_change&page=3'), {
  test: 'abc',
  user: 'ada',
  action: 'role_change',
  page: 3,
});
assert.strictEqual(ui.auditHash({ test: '', user: '', action: '', page: 1 }), '#audit');
assert.strictEqual(
  ui.auditHash({ test: 'abc', user: 'ada', action: 'signin', page: 2 }),
  '#audit?test=abc&user=ada&action=signin&page=2'
);
assert.strictEqual(
  ui.auditQuery({ test: 'abc', page: 2 }),
  '/api/audit?test=abc&page=2&page_size=25'
);
assert.strictEqual(ui.auditPageLabel(2, 60, 25), 'Page 2 of 3');
assert.strictEqual(ui.AUDIT_PAGE_SIZE, 25);

const open = parseAuditQuery({});
assert.strictEqual(open.ok, true);
assert.strictEqual(open.page, 1);
assert.strictEqual(open.pageSize, LEGACY_PAGE_SIZE);
const paged = parseAuditQuery({ page: '2', page_size: '25', action: 'role_change' });
assert.strictEqual(paged.ok, true);
assert.strictEqual(paged.page, 2);
assert.strictEqual(paged.pageSize, DEFAULT_PAGE_SIZE);
assert.strictEqual(paged.action, 'role_change');
const capped = parseAuditQuery({ page_size: '500' });
assert.strictEqual(capped.pageSize, MAX_PAGE_SIZE);
const badTest = parseAuditQuery({ test: 'not-a-test' });
assert.strictEqual(badTest.ok, false);
assert.strictEqual(badTest.status, 400);
assert.ok(badTest.error.includes('test'));
const badAction = parseAuditQuery({ action: 'drop table' });
assert.strictEqual(badAction.ok, false);
assert.ok(badAction.error.includes('recognised'));
assert.ok(!badAction.error.includes('recognized'));

console.log('audit log tests passed');
