// Agency invite copy, migration shape, and the Owner team screen.
// No database. British English, and pivitlab stays lowercase.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../public/admin-ui.js');
const { inviteEmailText, EMAIL_FAILED } = require('../src/account-invite');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const schema = read('src/db/schema.sql');
const migrateSrc = read('src/db/migrate.js');
const migration = read('src/db/account-invites.js');
const admin = read('public/index.html');
const join = read('public/join.html');
const flow = read('src/account-invite.js');
const invitesRoute = read('src/routes/invites.js');
const signup = read('src/db/signup.js');

assert.ok(!schema.includes('invite_codes'));
assert.ok(!schema.includes('account_invites'));
assert.ok(!schema.includes('account-invites'));
assert.ok(migrateSrc.includes("{ version: '000', name: 'baseline', run: applyBaseline }"));
assert.ok(migrateSrc.includes("{ version: '017', name: 'account-invites', run: applyAccountInvites }"));
assert.ok(migrateSrc.indexOf("version: '016'") < migrateSrc.indexOf("version: '017'"));
assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS account_invites'));
assert.ok(migration.includes('token_hash TEXT NOT NULL UNIQUE'));
assert.ok(migration.includes("CHECK (role IN ('owner', 'member'))"));
assert.ok(!/\bDROP\s/i.test(migration));
assert.ok(!/\bDELETE\s+FROM\b/i.test(migration));
assert.ok(!/\bTRUNCATE\b/i.test(migration));
assert.ok(!/\bUPDATE\s/i.test(migration));
assert.ok(invitesRoute.includes('requireSuperadmin'));
assert.ok(signup.includes('CREATE TABLE IF NOT EXISTS invite_codes'));
assert.ok(flow.includes('appUrl('));
assert.ok(flow.includes('account_invite_created'));
assert.ok(flow.includes('account_invite_revoked'));
assert.ok(flow.includes('account_invite_resent'));
assert.ok(flow.includes('account_invite_accepted'));
assert.ok(!flow.includes('INSERT INTO accounts'));
assert.ok(!flow.includes('INSERT INTO sites'));

const letter = inviteEmailText({
  agencyName: 'Northwind',
  role: 'member',
  link: 'https://pivitlab.test/join.html?token=abc',
});
assert.ok(letter.includes('join Northwind on pivitlab as a Member'));
assert.ok(letter.includes('https://pivitlab.test/join.html?token=abc'));
assert.ok(letter.includes('Joining does not create a new agency.'));
assert.ok(letter.includes('expires in 7 days'));
assert.ok(letter.includes('You can open this link as often as you like. It\u2019s used up once you join.'));
assert.ok(letter.includes('6-digit code'));
assert.ok(!letter.includes('It works once'));
assert.ok(!letter.includes('Opening the link does not use it up'));
assert.ok(letter.trim().endsWith('pivitlab'));
assert.ok(!letter.includes('Pivitlab'));
assert.ok(!letter.includes('PivitLab'));
assert.ok(!/create your pivitlab agency/i.test(letter));
assert.strictEqual(EMAIL_FAILED, 'The email was not sent. Copy the link instead.');

assert.strictEqual(ui.auditActionLabel('account_invite_created'), 'Created an agency invite');
assert.strictEqual(ui.auditActionLabel('account_invite_resent'), 'Resent an agency invite');
assert.strictEqual(ui.auditActionLabel('account_invite_revoked'), 'Revoked an agency invite');
assert.strictEqual(ui.auditActionLabel('account_invite_accepted'), 'Accepted an agency invite');
assert.strictEqual(ui.auditActionLabel('invite_created'), 'Created an invite');
assert.strictEqual(
  ui.auditDetailText({
    action: 'account_invite_created',
    detail: { email: 'ada@example.co.uk', role: 'member' },
  }),
  'ada@example.co.uk, Member'
);
assert.ok(!ui.auditActionLabel('account_invite_created').includes('Pivit'));

assert.strictEqual(ui.canOpenTeam({ membership: 'owner' }), true);
assert.strictEqual(ui.canOpenTeam({ membership: 'member' }), true);
assert.strictEqual(ui.canManageTeam({ membership: 'owner' }), true);
assert.strictEqual(ui.canManageTeam({ membership: 'member' }), false);
assert.strictEqual(ui.canOpenTeam({ membership: 'owner', view_as: { id: 'x' } }), false);
assert.strictEqual(ui.canManageTeam({ membership: 'owner', view_as: { id: 'x' } }), false);
assert.strictEqual(ui.canOpenTeam({ superadmin: true }), false);
assert.strictEqual(ui.canOpenTeam(null), false);
assert.strictEqual(ui.teamDeniedMessage({}), 'Team is for people in this agency.');
assert.strictEqual(
  ui.teamDeniedMessage({ view_as: { id: 'x' } }),
  'Stop the support view before you open Team.'
);
assert.deepStrictEqual(ui.teamRoute('#team'), { page: 'team' });
assert.strictEqual(ui.teamRoute('#team?x=1').page, 'team');
assert.strictEqual(ui.teamRoute('#users'), null);
assert.strictEqual(ui.teamRoute('#team-extra'), null);
assert.strictEqual(ui.usersRoute('#team'), null);
assert.strictEqual(ui.teamFreshMessage({ emailed: false }), 'The link is shown once. It has not been emailed.');
assert.ok(ui.teamFreshMessage({ emailed: true }).includes("We've emailed the invite."));
assert.ok(ui.teamFreshMessage({ resent: true, emailed: true }).includes('replaces the previous one'));
assert.strictEqual(ui.teamFreshMessage({ email_error: EMAIL_FAILED }), EMAIL_FAILED);
assert.strictEqual(ui.teamSentLabel({ last_sent_at: null }), 'Link only');
assert.strictEqual(ui.teamSentLabel({ last_sent_at: '2026-10-17T12:00:00.000Z' }), 'Emailed');

assert.ok(admin.includes('id="nav-page-team"'));
assert.ok(admin.includes('data-go="#team"'));
assert.ok(admin.includes('id="nav-page-team" data-go="#team" hidden'));
assert.ok(admin.includes('id="page-team"'));
assert.ok(admin.includes('id="team-email-invite"'));
assert.ok(admin.includes('>Email the invite</button>'));
assert.ok(admin.includes('id="team-link-invite"'));
assert.ok(admin.includes('>Create a link</button>'));
assert.ok(admin.includes('Pending invites'));
assert.ok(admin.includes('>Resend</button>'));
assert.ok(admin.includes('>Revoke</button>'));
assert.ok(admin.includes('No pending invites.'));
assert.ok(admin.includes('It does not create a new agency.'));
assert.ok(admin.includes('UI.canOpenTeam'));
assert.ok(admin.includes('/api/account/members/invites'));
assert.ok(!admin.includes('Pivitlab'));
assert.ok(!admin.includes('PivitLab'));

const teamStart = admin.indexOf('id="page-team"');
const teamEnd = admin.indexOf('id="page-users"');
assert.ok(teamStart > 0 && teamEnd > teamStart);
const teamPage = admin.slice(teamStart, teamEnd);
assert.ok(teamPage.includes('Only an Owner can invite.'));
assert.ok(!/behavior|favorite|organize|color\b/i.test(teamPage));

assert.ok(join.includes('Join this agency'));
assert.ok(join.includes('You can open this link as often as you like. It\u2019s used up once you join.'));
assert.ok(join.includes('6-digit code'));
assert.ok(join.includes('code_sent'));
assert.ok(!join.includes('This link works once'));
assert.ok(join.includes("That invite isn't valid. It may have expired, or it may already have been used."));
assert.ok(join.includes('/api/auth/join'));
assert.ok(join.includes('By joining you agree to the'));
assert.ok(join.includes('noindex, nofollow'));
assert.ok(join.includes('https://pivitlab.com/join.html'));
assert.ok(join.indexOf("addEventListener('submit'") < join.indexOf("fetch('/api/auth/join',"));
assert.ok(!join.includes('Pivitlab'));
assert.ok(!join.includes('PivitLab'));
assert.ok(!join.includes('create a new agency') || join.includes('does not create'));

console.log('account invite tests passed');
