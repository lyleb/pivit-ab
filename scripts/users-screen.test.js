// Platform-admin Users screen: filters, guard rails, and the page itself.
// No database. British English, and pivitlab stays lowercase.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');
const {
  LAST_PLATFORM_ADMIN,
  LAST_ACCOUNT_OWNER,
  NOT_YOURSELF,
} = require('../src/person-state');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

assert.strictEqual(ui.USERS_GUARD_LAST_ADMIN, LAST_PLATFORM_ADMIN);
assert.strictEqual(ui.USERS_GUARD_LAST_OWNER, LAST_ACCOUNT_OWNER);
assert.strictEqual(ui.USERS_GUARD_SELF, NOT_YOURSELF);
for (const line of [ui.USERS_GUARD_LAST_ADMIN, ui.USERS_GUARD_LAST_OWNER, ui.USERS_GUARD_SELF]) {
  assert.ok(!line.includes('Pivitlab'), line);
  assert.ok(!line.includes('PivitLab'), line);
}

const ada = {
  id: '11111111-1111-1111-1111-111111111111',
  kind: 'user',
  email: 'ada@alpha.example',
  role: 'owner',
  account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  account_name: 'Alpha',
  superadmin: false,
  suspended: false,
  archived: false,
};
const ben = {
  id: '22222222-2222-2222-2222-222222222222',
  kind: 'user',
  email: 'ben@heclr.example',
  role: 'owner',
  account_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  account_name: 'Heclr',
  superadmin: true,
  suspended: false,
  archived: false,
};
const info = {
  id: '33333333-3333-3333-3333-333333333333',
  kind: 'user',
  email: 'info@heclr.com',
  role: 'owner',
  account_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  account_name: 'Heclr',
  superadmin: true,
  suspended: false,
  archived: false,
};
const mia = {
  id: '44444444-4444-4444-4444-444444444444',
  kind: 'user',
  email: 'mia@alpha.example',
  role: 'member',
  account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  account_name: 'Alpha',
  superadmin: false,
  suspended: true,
  archived: false,
};
const ivy = {
  id: '55555555-5555-5555-5555-555555555555',
  kind: 'user',
  email: 'ivy@alpha.example',
  role: 'member',
  account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  account_name: 'Alpha',
  superadmin: false,
  suspended: false,
  archived: true,
};
const viewer = {
  id: '66666666-6666-6666-6666-666666666666',
  kind: 'viewer',
  name: 'Ada View',
  username: 'ada-view',
  role: 'viewer',
  account_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  account_name: 'Alpha',
  superadmin: false,
  suspended: false,
  archived: false,
};
const loneAdmin = {
  id: '77777777-7777-7777-7777-777777777777',
  kind: 'user',
  email: 'solo@heclr.example',
  role: null,
  account_id: null,
  account_name: null,
  superadmin: true,
  suspended: false,
  archived: false,
};

const people = [ada, ben, info, mia, ivy, viewer];

assert.deepStrictEqual(ui.personTypes(ada), ['owner']);
assert.deepStrictEqual(ui.personTypes(ben), ['platform_admin', 'owner']);
assert.deepStrictEqual(ui.personTypes(mia), ['member']);
assert.deepStrictEqual(ui.personTypes(viewer), ['viewer']);
assert.strictEqual(ui.personTypeLabel(ben), 'Platform admin · Owner');
assert.strictEqual(ui.personTypeLabel(viewer), 'Viewer');
assert.strictEqual(ui.personTypeLabel({ kind: 'user', role: null, superadmin: false }), '—');

assert.deepStrictEqual(ui.personStatusKeys(ada), ['active']);
assert.deepStrictEqual(ui.personStatusKeys(mia), ['suspended']);
assert.deepStrictEqual(ui.personStatusKeys(ivy), ['archived']);
assert.strictEqual(ui.personStatusLabel({ suspended: true, archived: true }), 'Archived · Suspended');

assert.deepStrictEqual(ui.personIdentity(ada), { primary: 'ada@alpha.example', secondary: '' });
assert.deepStrictEqual(ui.personIdentity(viewer), { primary: 'Ada View', secondary: 'ada-view' });
assert.deepStrictEqual(
  ui.personIdentity({ kind: 'viewer', name: '', username: 'ada-view' }),
  { primary: 'ada-view', secondary: '' }
);

const open = ui.filterPeople(people, {});
assert.ok(open.some((person) => person.email === 'ada@alpha.example'));
assert.ok(!open.some((person) => person.email === 'ivy@alpha.example'));
assert.strictEqual(ui.hiddenArchivedCount(people, {}), 1);
assert.strictEqual(
  ui.usersSummary({ shown: open.length, total: people.length, archivedHidden: 1, filtered: false }),
  'Showing 5 people. 1 archived person is hidden.'
);

const shownArchived = ui.filterPeople(people, { showArchived: true });
assert.strictEqual(shownArchived.length, people.length);
const onlyArchived = ui.filterPeople(people, { status: 'archived', showArchived: false });
assert.deepStrictEqual(onlyArchived.map((person) => person.email), ['ivy@alpha.example']);

const byType = ui.filterPeople(people, { type: 'platform_admin' });
assert.deepStrictEqual(byType.map((person) => person.email).sort(), ['ben@heclr.example', 'info@heclr.com']);
const owners = ui.filterPeople(people, { type: 'owner' });
assert.ok(owners.some((person) => person.id === ben.id));
assert.ok(owners.some((person) => person.id === ada.id));
assert.ok(!owners.some((person) => person.kind === 'viewer'));

const suspended = ui.filterPeople(people, { status: 'suspended' });
assert.deepStrictEqual(suspended.map((person) => person.email), ['mia@alpha.example']);
const active = ui.filterPeople(people, { status: 'active' });
assert.ok(active.every((person) => !person.suspended && !person.archived));

const alpha = ui.filterPeople(people, { agency: ada.account_id });
assert.ok(alpha.every((person) => person.account_id === ada.account_id));
assert.ok(!alpha.some((person) => person.archived));
const none = ui.filterPeople([loneAdmin, ada], { agency: 'none' });
assert.deepStrictEqual(none.map((person) => person.email), ['solo@heclr.example']);

const search = ui.filterPeople(people, { query: 'ADA-VIEW' });
assert.deepStrictEqual(search.map((person) => person.username), ['ada-view']);
const byName = ui.filterPeople(people, { query: 'ada view' });
assert.strictEqual(byName.length, 1);
assert.strictEqual(ui.filterPeople(people, { query: 'heclr', type: 'viewer' }).length, 0);

const agencies = ui.peopleAgencyOptions(people.concat([loneAdmin]));
assert.strictEqual(agencies.none, true);
assert.deepStrictEqual(agencies.agencies.map((agency) => agency.name), ['Alpha', 'Heclr']);

assert.strictEqual(ui.usersSummary({ shown: 0, total: 0, archivedHidden: 0 }), 'No one to show.');
assert.strictEqual(
  ui.usersSummary({ shown: 0, total: 2, archivedHidden: 2, filtered: false }),
  '2 archived people are hidden.'
);
assert.strictEqual(
  ui.usersSummary({ shown: 0, total: 4, archivedHidden: 0, filtered: true }),
  'No one matches these filters.'
);
assert.ok(!ui.usersSummary({ shown: 1, total: 1, archivedHidden: 0 }).includes('Pivit'));

const selfBlock = ui.personActions(info, people, 'info@heclr.com');
assert.strictEqual(selfBlock.reason, NOT_YOURSELF);
assert.ok(selfBlock.actions.every((action) => action.id === 'unsuspend' || action.id === 'restore' || action.blocked === NOT_YOURSELF));

const otherAdmin = ui.personActions(ben, people, 'info@heclr.com');
assert.strictEqual(otherAdmin.reason, '');
assert.deepStrictEqual(otherAdmin.actions.map((action) => action.id), ['suspend', 'archive']);

const lastAdmin = ui.personActions(loneAdmin, [loneAdmin], 'someone@heclr.example');
assert.strictEqual(lastAdmin.reason, LAST_PLATFORM_ADMIN);
const lastAdminSelf = ui.personActions(loneAdmin, [loneAdmin], 'solo@heclr.example');
assert.strictEqual(lastAdminSelf.reason, LAST_PLATFORM_ADMIN);

const lastOwner = ui.personActions(ada, people, 'info@heclr.com');
assert.strictEqual(lastOwner.reason, LAST_ACCOUNT_OWNER);
const memberRow = {
  id: ada.id,
  kind: 'user',
  email: ada.email,
  role: 'member',
  account_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  account_name: 'Gamma',
  superadmin: false,
  suspended: false,
  archived: false,
};
const across = ui.personActions(memberRow, [memberRow, ada], 'info@heclr.com');
assert.strictEqual(across.reason, LAST_ACCOUNT_OWNER);

const suspendedActions = ui.personActions(mia, people, 'info@heclr.com');
assert.strictEqual(suspendedActions.reason, '');
assert.deepStrictEqual(suspendedActions.actions.map((action) => action.id), ['unsuspend', 'archive']);
assert.ok(suspendedActions.actions.every((action) => !action.blocked));

const archivedActions = ui.personActions(ivy, people, 'info@heclr.com');
assert.deepStrictEqual(archivedActions.actions.map((action) => action.id), ['suspend', 'restore']);
assert.strictEqual(archivedActions.reason, '');

const viewerActions = ui.personActions(viewer, [viewer], 'info@heclr.com');
assert.strictEqual(viewerActions.reason, '');
assert.deepStrictEqual(viewerActions.actions.map((action) => action.label), ['Suspend', 'Archive']);

const suspendCopy = ui.personConfirm('suspend', ada);
assert.strictEqual(suspendCopy.title, 'Suspend sign-in?');
assert.strictEqual(suspendCopy.confirm, 'Suspend');
assert.ok(suspendCopy.body.includes('ada@alpha.example'));
assert.ok(suspendCopy.body.includes('signed out'));
assert.ok(!suspendCopy.body.includes('Pivitlab'));
assert.ok(!/behavior|favorite|authorize/i.test(suspendCopy.body));
const archiveCopy = ui.personConfirm('archive', viewer);
assert.strictEqual(archiveCopy.confirm, 'Archive');
assert.ok(archiveCopy.body.includes('Ada View'));
assert.ok(archiveCopy.body.includes('audit log'));
assert.ok(archiveCopy.body.includes('can still sign in'));
assert.strictEqual(ui.personConfirm('unsuspend', mia).confirm, 'Unsuspend');
assert.strictEqual(ui.personConfirm('restore', ivy).confirm, 'Restore');
assert.strictEqual(ui.personConfirm('delete', ada), null);

assert.deepStrictEqual(ui.personAccessPatch('suspend'), { suspended: true });
assert.deepStrictEqual(ui.personAccessPatch('unsuspend'), { suspended: false });
assert.deepStrictEqual(ui.personAccessPatch('archive'), { archived: true });
assert.deepStrictEqual(ui.personAccessPatch('restore'), { archived: false });
assert.strictEqual(ui.personAccessPatch('delete'), null);
assert.strictEqual(ui.personAccessPath(ada), `/api/admin/users/${ada.id}`);
assert.strictEqual(ui.personAccessPath(viewer), `/api/admin/clients/${viewer.id}`);
assert.strictEqual(ui.personDoneMessage('archive').includes('restore'), true);

assert.strictEqual(ui.canOpenUsers({ superadmin: true }), true);
assert.strictEqual(ui.canOpenUsers({ superadmin: true, view_as: { id: 'x' } }), false);
assert.strictEqual(ui.canOpenUsers({ superadmin: false }), false);
assert.strictEqual(ui.canOpenUsers(null), false);
assert.strictEqual(ui.usersDeniedMessage({ view_as: { id: 'x' } }), 'Stop the support view before you manage users.');
assert.strictEqual(ui.usersDeniedMessage({}), 'Users is only for a Platform admin.');
assert.deepStrictEqual(ui.usersRoute('#users'), { page: 'users' });
assert.strictEqual(ui.usersRoute('#users?x=1').page, 'users');
assert.strictEqual(ui.usersRoute('#audit'), null);
assert.strictEqual(ui.usersRoute('#users-extra'), null);

const admin = read('public/index.html');
const client = read('public/client.html');
const css = read('public/assets/pivit.css');
const usersPageStart = admin.indexOf('id="page-users"');
const usersPageEnd = admin.indexOf('id="users-confirm"');
assert.ok(usersPageStart > admin.indexOf('class="brand-logo"'));
assert.ok(usersPageEnd > usersPageStart);
const usersPage = admin.slice(usersPageStart, usersPageEnd);
assert.ok(admin.includes('id="nav-page-users"'));
assert.ok(admin.includes('data-go="#users"'));
assert.ok(admin.includes('id="nav-page-users" data-go="#users" hidden'));
assert.ok(usersPage.includes('id="admin-users"'));
assert.ok(usersPage.includes('id="users-search"'));
assert.ok(usersPage.includes('id="users-type"'));
assert.ok(usersPage.includes('id="users-status"'));
assert.ok(usersPage.includes('id="users-agency"'));
assert.ok(usersPage.includes('id="users-show-archived"'));
assert.ok(usersPage.includes('Show archived'));
assert.ok(usersPage.includes('>Platform admin</option>'));
assert.ok(usersPage.includes('>Owner</option>'));
assert.ok(usersPage.includes('>Member</option>'));
assert.ok(usersPage.includes('>Viewer</option>'));
assert.ok(usersPage.includes('>Active</option>'));
assert.ok(usersPage.includes('>Suspended</option>'));
assert.ok(usersPage.includes('>Archived</option>'));
assert.ok(usersPage.includes('Last sign-in'));
assert.ok(usersPage.includes('>Created</th>'));
assert.ok(usersPage.includes('class="table-cards"'));
assert.ok(usersPage.includes('Everyone in pivitlab, across every agency.'));
assert.ok(usersPage.includes('Nothing here deletes a person.'));
assert.ok(!usersPage.includes('Pivitlab'));
assert.ok(!usersPage.includes('PivitLab'));
assert.ok(!/data-user-action="delete"|>\s*Delete\b/.test(usersPage));
assert.ok(!/>\s*Hard delete/.test(admin));

const confirm = admin.slice(usersPageEnd, admin.indexOf('id="snippet-popover"'));
assert.ok(confirm.includes('Suspend sign-in?'));
assert.ok(confirm.includes('id="users-confirm-cancel"'));
assert.ok(confirm.includes('>Cancel</button>'));
assert.ok(!/data-user-action="delete"|Hard delete/.test(confirm));

assert.ok(admin.includes('UI.canOpenUsers'));
assert.ok(admin.includes('UI.filterPeople'));
assert.ok(admin.includes('UI.personConfirm'));
assert.ok(admin.includes("method: 'PATCH'"));
assert.ok(admin.includes('.audit-filters, .users-filters { grid-template-columns: 1fr; }'));
assert.ok(admin.includes('.users-actions button { min-height: 44px;'));
assert.ok(css.includes('pivitlab-logo-white.svg'));
assert.ok(css.includes('.table-cards.is-visible td.card-action'));
assert.ok(!client.includes('id="page-users"'));
assert.ok(!client.includes('id="nav-page-users"'));

const route = read('src/routes/people.js');
const state = read('src/person-state.js');
assert.ok(route.includes("router.get('/users'"));
assert.ok(!route.includes('router.delete'));
assert.ok(!route.includes('.delete('));
assert.ok(state.includes('u.created_at'));
assert.ok(state.includes('c.created_at'));
assert.ok(state.includes('created_at: row.created_at'));

console.log('users screen tests passed');
