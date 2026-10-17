// Suspended and archived people: migration registration and the words
// the API uses. No database. British English, and pivitlab stays lowercase.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');
const {
  SIGN_IN_CLOSED,
  LAST_PLATFORM_ADMIN,
  LAST_ACCOUNT_OWNER,
  NOT_YOURSELF,
  DELETE_CLOSED,
  DELETE_CONFIRM,
  DELETE_MISMATCH,
  personClosed,
  parseAccessBody,
  parseDeleteBody,
  confirmMatches,
  deletedLabel,
  deletedLabelSql,
  deletedEmail,
  deletedUsername,
} = require('../src/person-state');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const schema = read('src/db/schema.sql');
const migrateSrc = read('src/db/migrate.js');
const migration = read('src/db/people-state.js');

assert.ok(!schema.includes('suspended_at'));
assert.ok(!schema.includes('archived_at'));
assert.ok(!schema.includes('deleted_at'));
assert.ok(!schema.includes('removed_at'));
assert.ok(migrateSrc.includes("{ version: '000', name: 'baseline', run: applyBaseline }"));
assert.ok(migrateSrc.includes("{ version: '016', name: 'people-state', run: applyPeopleState }"));
assert.ok(migrateSrc.indexOf("version: '015'") < migrateSrc.indexOf("version: '016'"));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ'));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ'));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ'));
assert.ok(migration.includes('ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspended_at'));
assert.ok(migration.includes('ALTER TABLE memberships ADD COLUMN IF NOT EXISTS removed_at'));
assert.ok(!/\bDROP\s/i.test(migration));
assert.ok(!/\bDELETE\s+FROM\b/i.test(migration));
assert.ok(!/\bTRUNCATE\b/i.test(migration));
assert.ok(!/\bUPDATE\s/i.test(migration));

assert.strictEqual(SIGN_IN_CLOSED, "That sign-in isn't available.");
assert.strictEqual(LAST_PLATFORM_ADMIN, 'pivitlab needs at least one Platform admin.');
assert.strictEqual(LAST_ACCOUNT_OWNER, 'This agency needs at least one Owner.');
assert.strictEqual(NOT_YOURSELF, "You can't change your own access.");
for (const line of [SIGN_IN_CLOSED, LAST_PLATFORM_ADMIN, LAST_ACCOUNT_OWNER, NOT_YOURSELF]) {
  assert.ok(!line.includes('Pivitlab'), line);
  assert.ok(!line.includes('PivitLab'), line);
  assert.ok(!/recognise|behavior|favorite|authorize/i.test(line), line);
  assert.ok(!line.toLowerCase().includes('suspended'), line);
  assert.ok(!line.toLowerCase().includes('archived'), line);
}

assert.strictEqual(personClosed(null), false);
assert.strictEqual(personClosed({ suspended_at: null, archived_at: null, deleted_at: null }), false);
assert.strictEqual(personClosed({ archived_at: new Date() }), false);
assert.strictEqual(personClosed({ suspended_at: new Date() }), true);
assert.strictEqual(personClosed({ deleted_at: new Date() }), true);

const empty = parseAccessBody({});
assert.strictEqual(empty.ok, false);
assert.strictEqual(empty.status, 400);
const bad = parseAccessBody({ suspended: 'yes' });
assert.strictEqual(bad.ok, false);
assert.ok(bad.error.includes('true or false'));
const flags = parseAccessBody({ suspended: true, archived: false });
assert.strictEqual(flags.ok, true);
assert.strictEqual(flags.suspended, true);
assert.strictEqual(flags.archived, false);

assert.strictEqual(ui.auditActionLabel('user.suspended'), 'Suspended sign-in');
assert.strictEqual(ui.auditActionLabel('user.unsuspended'), 'Allowed sign-in again');
assert.strictEqual(ui.auditActionLabel('user.archived'), 'Archived a person');
assert.strictEqual(ui.auditActionLabel('user.restored'), 'Restored a person');
assert.strictEqual(ui.auditActionLabel('user.deleted'), 'Deleted a person');
assert.ok(!ui.auditActionLabel('user.deleted').includes('Pivit'));
assert.strictEqual(
  ui.auditDetailText({ action: 'user.deleted', detail: { label: 'Deleted user 11111111', kind: 'user' } }),
  'Deleted user 11111111'
);
assert.strictEqual(
  ui.auditDetailText({ action: 'user.suspended', detail: { email: 'ada@alpha.example' } }),
  'ada@alpha.example'
);
assert.strictEqual(
  ui.auditDetailText({ action: 'user.archived', detail: { username: 'ada-view' } }),
  'ada-view'
);

const sampleId = '11111111-1111-4111-8111-111111111111';
assert.strictEqual(deletedLabel(sampleId), 'Deleted user 11111111');
assert.strictEqual(deletedLabel(sampleId.toUpperCase()), 'Deleted user 11111111');
assert.strictEqual(deletedEmail(sampleId), 'deleted-11111111-1111-4111-8111-111111111111@invalid');
assert.strictEqual(deletedUsername(sampleId), 'deleted-11111111-1111-4111-8111-111111111111');
assert.strictEqual(deletedLabelSql('u.id'), "('Deleted user ' || left(replace(u.id::text, '-', ''), 8))");
assert.throws(() => deletedLabelSql('users.email'), /unsafe/);
assert.strictEqual(DELETE_CLOSED, 'Suspend or archive this person before deleting them.');
assert.strictEqual(DELETE_CONFIRM, 'Type their email or username to confirm.');
assert.strictEqual(DELETE_MISMATCH, "That doesn't match their email or username.");
for (const line of [DELETE_CLOSED, DELETE_CONFIRM, DELETE_MISMATCH]) {
  assert.ok(!line.includes('Pivitlab'), line);
  assert.ok(!line.includes('PivitLab'), line);
  assert.ok(!/behavior|favorite|authorize|anonymize/i.test(line), line);
}
const missingConfirm = parseDeleteBody({});
assert.strictEqual(missingConfirm.ok, false);
assert.strictEqual(missingConfirm.error, DELETE_CONFIRM);
const blankConfirm = parseDeleteBody({ confirm: '   ' });
assert.strictEqual(blankConfirm.ok, false);
const typedConfirm = parseDeleteBody({ confirm: '  Ada@Alpha.example  ' });
assert.strictEqual(typedConfirm.ok, true);
assert.strictEqual(typedConfirm.confirm, 'Ada@Alpha.example');
assert.strictEqual(confirmMatches(' Ada@Alpha.example ', ['ada@alpha.example']), true);
assert.strictEqual(confirmMatches('ada-view', ['Ada View']), false);
assert.strictEqual(confirmMatches('ADA-VIEW', ['ada-view']), true);

const dashboard = read('public/index.html');
assert.ok(dashboard.includes('id="admin-users"'));
assert.ok(dashboard.includes('Suspend sign-in'));
assert.ok(dashboard.includes('id="users-confirm-match"'));

console.log('person state tests passed');
