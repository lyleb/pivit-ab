// Agency Team screen: who can open it, and which actions an Owner is offered.
// No database. British English, and pivitlab stays lowercase.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const admin = read('public/index.html');
const team = read('src/team.js');
const members = read('src/routes/members.js');
const clients = read('src/routes/clients.js');
const schema = read('src/db/schema.sql');
const migrate = read('src/db/migrate.js');

assert.ok(!schema.includes('team_people'));
assert.ok(migrate.includes("{ version: '017', name: 'account-invites', run: applyAccountInvites }"));
assert.ok(!migrate.includes("version: '018'"));
assert.ok(team.includes('membership.removed'));
assert.ok(team.includes('LAST_ACCOUNT_OWNER'));
assert.ok(team.includes('NOT_YOURSELF'));
assert.ok(team.includes('endAccountUserSessions'));
assert.ok(!team.includes('users.suspended_at ='));
assert.ok(!team.includes('UPDATE users'));
assert.ok(members.includes("router.get('/'"));
assert.ok(members.includes("router.delete('/:userId'"));
assert.ok(clients.includes("/:id/access"));
assert.ok(clients.includes('viewer.created'));
assert.ok(clients.includes('viewer.password_reset'));
assert.ok(!clients.includes('password_hash: password'));

assert.strictEqual(ui.auditActionLabel('membership.removed'), 'Removed from the agency');
assert.strictEqual(ui.auditActionLabel('viewer.created'), 'Created a Viewer');
assert.strictEqual(ui.auditActionLabel('viewer.updated'), 'Edited a Viewer');
assert.strictEqual(ui.auditActionLabel('viewer.password_reset'), 'Reset a Viewer password');
assert.strictEqual(
  ui.auditDetailText({ action: 'membership.removed', detail: { email: 'ada@example.co.uk', role: 'member' } }),
  'ada@example.co.uk, Member'
);
assert.strictEqual(
  ui.auditDetailText({ action: 'viewer.created', detail: { name: 'Northwind', username: 'north' } }),
  'Northwind (north)'
);

const owner = { id: 'owner-1', kind: 'user', email: 'owner@example.co.uk', role: 'owner' };
const member = { id: 'member-1', kind: 'user', email: 'member@example.co.uk', role: 'member' };
const second = { id: 'owner-2', kind: 'user', email: 'second@example.co.uk', role: 'owner' };
const viewer = {
  id: 'viewer-1',
  kind: 'viewer',
  name: 'Northwind',
  username: 'north',
  role: 'viewer',
  suspended: false,
  archived: false,
};
const people = [owner, member, viewer];

assert.strictEqual(ui.teamRemoveBlock(owner, people, 'owner@example.co.uk'), 'This agency needs at least one Owner.');
assert.strictEqual(ui.teamRemoveBlock(member, people, 'member@example.co.uk'), "You can't change your own access.");
assert.strictEqual(ui.teamRemoveBlock(member, people, 'owner@example.co.uk'), '');
assert.strictEqual(ui.teamRemoveBlock(owner, [owner, second], 'second@example.co.uk'), '');
assert.strictEqual(ui.teamRemoveBlock(owner, [owner, second], 'owner@example.co.uk'), "You can't change your own access.");
assert.strictEqual(ui.teamRoleLocked(owner, people), true);
assert.strictEqual(ui.teamRoleLocked(owner, [owner, second]), false);
assert.strictEqual(ui.teamRoleLocked(member, people), false);

const memberView = ui.teamActions(viewer, people, 'member@example.co.uk', false);
assert.deepStrictEqual(memberView.actions, []);
const ownerView = ui.teamActions(viewer, people, 'owner@example.co.uk', true);
assert.deepStrictEqual(ownerView.actions.map((action) => action.id), ['edit', 'password', 'suspend', 'archive']);
const suspended = Object.assign({}, viewer, { suspended: true });
assert.ok(ui.teamActions(suspended, people, 'owner@example.co.uk', true).actions.some((action) => action.id === 'unsuspend'));
assert.ok(!ui.teamActions(suspended, people, 'owner@example.co.uk', true).actions.some((action) => action.id === 'suspend'));
const archived = Object.assign({}, viewer, { archived: true });
assert.deepStrictEqual(
  ui.teamActions(archived, people, 'owner@example.co.uk', true).actions.map((action) => action.id),
  ['restore']
);
const userActions = ui.teamActions(member, people, 'owner@example.co.uk', true);
assert.deepStrictEqual(userActions.actions.map((action) => action.id), ['remove']);
assert.ok(!userActions.actions.some((action) => action.id === 'suspend' || action.id === 'archive'));

assert.strictEqual(ui.filterTeamPeople(people.concat([archived]), { showArchived: false }).length, 3);
assert.strictEqual(ui.filterTeamPeople(people.concat([archived]), { showArchived: true }).length, 4);
assert.strictEqual(ui.teamSummary({ shown: 2, archivedHidden: 1 }), 'Showing 2 people. 1 archived person is hidden.');
assert.ok(ui.teamPeopleHint(false).includes('Only an Owner can make changes.'));
assert.ok(ui.teamPeopleHint(true).includes('does not delete their pivitlab account'));
assert.ok(ui.teamConfirm('remove', member).body.includes('pivitlab account stays'));
assert.ok(ui.teamConfirm('suspend', viewer).title.includes('Viewer'));
assert.ok(!ui.teamConfirm('suspend', viewer).body.includes('every agency'));
assert.strictEqual(ui.teamStatusNote(member), '');
const closed = Object.assign({}, member, { suspended: true });
assert.ok(ui.teamStatusNote(closed).includes('Platform admin'));
assert.strictEqual(ui.teamStatusNote(viewer), '');

const teamStart = admin.indexOf('id="page-team"');
const teamEnd = admin.indexOf('id="page-users"');
const teamPage = admin.slice(teamStart, teamEnd);
assert.ok(teamPage.includes('id="team-people-table"'));
assert.ok(teamPage.includes('class="table-scroll team-people-scroll"'));
assert.ok(teamPage.includes('id="team-viewer-create"'));
assert.ok(teamPage.includes('>Create viewer</button>'));
assert.ok(teamPage.includes('Show archived'));
assert.ok(teamPage.includes('Only an Owner can invite.'));
assert.ok(teamPage.includes('It does not create a new agency.'));
assert.ok(admin.includes("callApi('/api/account/members')"));
assert.ok(admin.includes("method: 'DELETE'"));
assert.ok(admin.includes('/access'));
assert.ok(!/behavior|favorite|organize|color\b/i.test(teamPage));
assert.ok(!teamPage.includes('Pivitlab'));
assert.ok(!teamPage.includes('PivitLab'));
assert.ok(!teamPage.includes('Client login'));
assert.ok(admin.includes('class="team-email"'));
assert.ok(admin.includes('#team-people-table .team-email { overflow-wrap: anywhere; }'));
assert.ok(admin.includes('#page-team .team-people-scroll { overflow: visible; }'));
assert.ok(admin.includes('grid-template-areas: "brand" "logout" "nav"'));

console.log('team tests passed');
