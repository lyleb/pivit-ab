// Domain normalisation, the remembered site choice, and the setup copy.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { customerHost } = require('../src/auth-flow');
const {
  DOMAIN_IN_USE_WARNING,
  normaliseSiteDomain,
  sameAccountDomainMessage,
  chosenSite,
  siteChoiceRequired,
} = require('../src/site-domain');
const ui = require('../public/admin-ui');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

assert.strictEqual(normaliseSiteDomain('HTTPS://WWW.Example.co.uk/pricing/?q=1#top'), 'example.co.uk');
assert.strictEqual(normaliseSiteDomain('www.example.co.uk/'), 'example.co.uk');
assert.strictEqual(normaliseSiteDomain('Example.CO.UK'), 'example.co.uk');
assert.strictEqual(normaliseSiteDomain('https://shop.example.co.uk'), 'shop.example.co.uk');
assert.strictEqual(normaliseSiteDomain('example.co.uk.'), 'example.co.uk');
assert.strictEqual(normaliseSiteDomain(''), '');
assert.strictEqual(normaliseSiteDomain('localhost'), '');
assert.strictEqual(normaliseSiteDomain('http://127.0.0.1/admin'), '');
assert.strictEqual(normaliseSiteDomain('not a domain'), '');
assert.strictEqual(customerHost('https://WWW.Example.co.uk/pricing/'), normaliseSiteDomain('https://WWW.Example.co.uk/pricing/'));

assert.strictEqual(
  sameAccountDomainMessage('example.co.uk'),
  'This account already has a site for example.co.uk.'
);
assert.strictEqual(
  DOMAIN_IN_USE_WARNING,
  'This domain is already in use. A test runs only where this site\'s snippet is installed.'
);
assert.strictEqual(ui.DOMAIN_IN_USE_WARNING, DOMAIN_IN_USE_WARNING);
assert.ok(!DOMAIN_IN_USE_WARNING.includes('account'));
assert.ok(DOMAIN_IN_USE_WARNING.includes('pivitlab') === false);

const only = [{ id: 'site-a', name: 'a.example' }];
assert.strictEqual(chosenSite(only, null).id, 'site-a');
assert.strictEqual(siteChoiceRequired(only, null), false);
assert.strictEqual(ui.siteChoiceState(only, '').required, false);
assert.strictEqual(ui.siteChoiceState(only, '').site.id, 'site-a');

const many = [
  { id: 'oldest', name: 'first.example' },
  { id: 'shop', name: 'shop.example' },
];
assert.strictEqual(chosenSite(many, null), null);
assert.strictEqual(chosenSite(many, 'missing'), null);
assert.strictEqual(chosenSite(many, 'shop').id, 'shop');
assert.strictEqual(siteChoiceRequired(many, null), true);
assert.strictEqual(siteChoiceRequired(many, 'shop'), false);
const pending = ui.siteChoiceState(many, '');
assert.strictEqual(pending.required, true);
assert.strictEqual(pending.site, null);
assert.notStrictEqual(pending.site, many[0]);
const remembered = ui.siteChoiceState(many, 'shop');
assert.strictEqual(remembered.required, false);
assert.strictEqual(remembered.site.id, 'shop');

const schema = read('src/db/schema.sql');
const migration = read('src/db/active-site.js');
const migrateSrc = read('src/db/migrate.js');
assert.ok(!schema.includes('active_site_id'));
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS active_site_id UUID'));
assert.ok(migration.includes('ON DELETE SET NULL'));
assert.ok(!/\bDROP\s/i.test(migration));
assert.ok(!/\bDELETE\s+FROM\b/i.test(migration));
assert.ok(!/\bTRUNCATE\b/i.test(migration));
assert.ok(!/\bUPDATE\s/i.test(migration));
assert.ok(migrateSrc.includes("{ version: '015', name: 'active-site', run: applyActiveSite }"));
assert.ok(migrateSrc.indexOf("version: '014'") < migrateSrc.indexOf("version: '015'"));

const dashboard = read('public/index.html');
for (const phrase of [
  'id="setup-site"',
  'id="wizard-site"',
  'id="snippet-site"',
  'id="sites-add-form"',
  'id="wizard-goals-site"',
  'Choose a site',
  'Choose a site to get the snippet.',
  'Choose a site before adding goals. Suggestions stay with that site.',
  'pivitlab remembers the choice',
  DOMAIN_IN_USE_WARNING,
  'UI.siteChoiceState',
  '/api/setup/site',
]) {
  assert.ok(dashboard.includes(phrase), phrase);
}
assert.ok(!dashboard.includes('Another account has also added'));
assert.ok(!dashboard.includes('normalized'));
assert.ok(dashboard.includes('pivitlab'));
assert.ok(!/behaviour|color|favorite/.test(dashboard.slice(dashboard.indexOf('id="sites-card"'), dashboard.indexOf('id="review-requests-card"'))));

console.log('site-domain tests passed');
