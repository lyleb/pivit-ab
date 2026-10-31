// Member view-only copy. No database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const note = 'You have view-only access. Ask an Owner to make changes.';
assert.strictEqual(ui.VIEW_ONLY_NOTE, note);
assert.strictEqual(ui.canChangeAgency({ membership: 'owner' }), true);
assert.strictEqual(ui.canChangeAgency({ membership: 'member' }), false);
assert.strictEqual(ui.canChangeAgency({ membership: 'member', superadmin: true }), true);
assert.strictEqual(ui.canChangeAgency({ membership: 'owner', view_as: { id: 'x' } }), false);
assert.strictEqual(ui.canChangeAgency({ emergency: true }), true);
assert.strictEqual(ui.canChangeAgency({ role: 'client', membership: 'owner' }), false);
assert.strictEqual(ui.canChangeAgency(null), false);
assert.strictEqual(ui.canClearTestTraffic({ membership: 'member' }), false);
assert.strictEqual(ui.canClearTestTraffic({ membership: 'owner' }), true);

const dashboard = read('public/index.html');
const help = read('public/help.html');
const helpDoc = read('docs/help.md');
const join = read('public/join.html');
const sentence = 'You can open this link as often as you like. It\u2019s used up once you join.';
for (const file of [dashboard, help, helpDoc, join]) {
  assert.ok(file.includes(sentence), 'missing join wording');
}
assert.ok(dashboard.includes(note));
assert.ok(dashboard.includes('canChangeAgency'));
assert.ok(dashboard.includes('stripMemberControls'));
assert.ok(help.includes(note));
assert.ok(helpDoc.includes(note));
assert.ok(help.includes('preview variants'));
assert.ok(help.includes('6-digit code'));
assert.ok(!help.includes('Opening the link does not use it up'));
assert.ok(!join.includes('This link works once'));
assert.ok(!dashboard.includes('Pivitlab'));

const access = read('src/membership-access.js');
assert.ok(access.includes(note));
assert.ok(access.includes("account.role !== 'member'"));
const tenant = read('src/tenant.js');
assert.ok(tenant.includes('extra.role'));
const migrate = read('src/db/migrate.js');
const schema = read('src/db/schema.sql');
assert.ok(migrate.includes("{ version: '023', name: 'join-codes', run: applyJoinCodes }"));
assert.ok(!schema.includes('code_expires_at'));
assert.ok(!/DROP\s+TABLE/i.test(read('src/db/join-codes.js')));

console.log('member access tests passed');
