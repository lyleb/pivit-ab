// Archive and delete copy for agencies. No database.
// British English, and pivitlab stays lowercase.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const help = fs.readFileSync(path.join(__dirname, '../public/help.html'), 'utf8');

assert.strictEqual(
  ui.agencyDeleteSummary(2, 5),
  "This deletes 2 sites, 5 experiments and all their results. This can't be undone."
);
assert.strictEqual(
  ui.agencyDeleteSummary(1, 1),
  "This deletes 1 site, 1 experiment and all their results. This can't be undone."
);
assert.ok(!ui.agencyDeleteSummary(2, 5).includes('Pivitlab'));
assert.ok(ui.AGENCY_ARCHIVED_BANNER.includes('Tests are not running'));
assert.ok(ui.AGENCY_ARCHIVED_MEMBER.includes('Ask an Owner'));
assert.ok(ui.AGENCY_ORIGINAL.includes('original agency'));

const google = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Google',
  legacy: false,
  archived: false,
  sites: 2,
  experiments: 5,
  current: true,
  summary: ui.agencyDeleteSummary(2, 5),
  sign_out_warning: 'You are signed in to this agency. Deleting it signs you out.',
};
const archived = Object.assign({}, google, { archived: true });
const heclr = Object.assign({}, google, { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Heclr', legacy: true, archived: false });

assert.deepStrictEqual(ui.agencyActions(google).actions.map((action) => action.id), ['archive']);
assert.deepStrictEqual(ui.agencyActions(archived).actions.map((action) => action.id), ['restore', 'delete']);
assert.deepStrictEqual(ui.agencyActions(heclr).actions, []);
assert.ok(ui.agencyActions(heclr).reason.includes('original agency'));

assert.strictEqual(ui.filterAgencies([google, archived], { showArchived: false }).length, 1);
assert.strictEqual(ui.filterAgencies([google, archived], { showArchived: true }).length, 2);
assert.strictEqual(
  ui.agenciesSummary({ shown: 1, archivedHidden: 1 }),
  'Showing 1 agency. 1 archived agency is hidden.'
);

const removeCopy = ui.agencyConfirm('delete', google);
assert.strictEqual(removeCopy.body, ui.agencyDeleteSummary(2, 5));
assert.strictEqual(removeCopy.warning, google.sign_out_warning);
assert.strictEqual(removeCopy.typed, true);
assert.ok(ui.agencyNameReady(google, 'Google'));
assert.ok(ui.agencyNameReady(google, '  Google  '));
assert.ok(!ui.agencyNameReady(google, 'google'));
assert.ok(!ui.agencyNameReady(google, 'Goog'));

const people = [
  { account_id: google.id, account_name: 'Google', account_archived: true },
  { account_id: heclr.id, account_name: 'Heclr', account_archived: false },
];
assert.deepStrictEqual(ui.peopleAgencyOptions(people).agencies.map((agency) => agency.name), ['Heclr']);

for (const phrase of [
  'id="agencies-card"',
  'id="agencies-show-archived"',
  'Show archived',
  'id="agency-confirm"',
  'Type the agency name',
  'id="agency-lifecycle-card"',
  'This agency',
  'Archive hides an agency',
  'id="agency-archived-banner"',
]) {
  assert.ok(html.includes(phrase), `index.html missing ${phrase}`);
}
assert.ok(help.includes('Archive or delete an agency'));
assert.ok(help.includes("This can't be undone."));
assert.ok(!html.includes('Pivitlab'));
assert.ok(!help.includes('Pivitlab'));

console.log('agency archive copy tests passed');
