// /privacy and /terms are public pages. The homepage, the app and join link them.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { canonicalHtmlMiddleware, legacyLegalRedirect } = require('../src/app-origin');
const { sendLandingPage } = require('../src/landing');
const { robotsTagMiddleware } = require('../src/robots');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const privacy = read('public/privacy-notice.html');
const terms = read('public/terms.html');
const landing = read('src/pages/landing.html');
const appPage = read('public/index.html');
const join = read('public/join.html');
const signup = read('public/signup.html');
const client = read('public/client.html');
const help = read('public/help.html');
const helpDoc = read('docs/help.md');

for (const html of [privacy, terms]) {
  assert.ok(html.startsWith('<!-- The text on this page should be reviewed by a solicitor. -->'));
  assert.ok(!html.includes('>The text on this page should be reviewed'));
  assert.ok(html.includes('Last updated: 14 November 2026'));
  assert.ok(html.includes('pivitlab is a service run by Go2Media'));
  assert.ok(!/\[[A-Z][^\]]+\]/.test(html), 'a placeholder is still in the page');
  assert.ok(html.includes('info@pivitlab.com'));
  assert.ok(html.includes('class="brand-logo"'));
  assert.ok(html.includes('lang="en-GB"'));
  assert.ok(!html.includes('Pivitlab'));
  assert.ok(!html.includes('PivitLab'));
}

assert.ok(privacy.includes('random visitor id'));
assert.ok(privacy.includes('processor'));
assert.ok(privacy.includes('controller'));
assert.ok(privacy.includes('UK GDPR'));
assert.ok(privacy.includes('Railway'));
assert.ok(privacy.includes('application hosting and the database'));
assert.ok(privacy.includes('Postmark'));
assert.ok(privacy.includes('transactional email'));
assert.ok(privacy.includes('PostHog'));
assert.ok(privacy.includes('product analytics'));
assert.ok(privacy.includes('Hostinger'));
assert.ok(privacy.includes('domain and email hosting'));
assert.ok(privacy.includes('only where a customer turns on Send to GA4'));
assert.ok(privacy.includes('deleted 30 days after an account closes'));
assert.ok(privacy.includes('unless the law requires us to keep them longer'));
assert.ok(privacy.includes('UK-US data bridge'));
assert.ok(privacy.includes('International Data Transfer Addendum'));
assert.ok(!privacy.includes('Cloudflare'));
assert.ok(!privacy.includes('Any other supplier'));
assert.ok(privacy.includes('ico.org.uk'));
assert.ok(privacy.includes('id="cookies"'));
assert.ok(privacy.includes('_ab_visitor_id'));
assert.ok(privacy.includes('pivit.sid'));
assert.ok(terms.includes('as it is') || terms.includes('as-is') || terms.includes('provided as it is'));
assert.ok(terms.includes('law of Scotland'));
assert.ok(terms.includes('consent banner') || terms.includes('privacy notice'));
assert.ok(terms.includes('early access'));
assert.ok(terms.includes('free'));

assert.ok(landing.includes('href="/privacy"'));
assert.ok(landing.includes('href="/terms"'));
assert.ok(!landing.includes('class="beta-pill"'));
assert.ok(!landing.includes('Private beta · invite only'));
assert.ok(landing.includes('.hero h1 .accent{color:#fff}'));
assert.ok(!landing.includes('background-clip:text'));
assert.ok(appPage.includes('href="/privacy"'));
assert.ok(appPage.includes('href="/terms"'));
assert.ok(appPage.includes('id="live-timing-note"'));
assert.ok(join.includes('href="/privacy"'));
assert.ok(join.includes('href="/terms"'));
assert.ok(signup.includes('href="/privacy"'));
assert.ok(signup.includes('href="/terms"'));
assert.ok(client.includes('href="/privacy"'));
assert.ok(client.includes('href="/terms"'));
assert.ok(help.includes('<strong>Safe failure.</strong>'));
assert.ok(helpDoc.includes('**Safe failure.**'));
assert.ok(help.includes('never left blank for more than 3 seconds'));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

const app = express();
app.use(robotsTagMiddleware);
app.get('/', sendLandingPage);
app.use(legacyLegalRedirect);
app.use(canonicalHtmlMiddleware);

const server = http.createServer(app);
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  try {
    const home = await get(port, '/');
    assert.strictEqual(home.status, 200);
    assert.ok(home.body.includes('href="/privacy"'));
    assert.ok(home.body.includes('href="/terms"'));
    assert.ok(!home.body.includes('Private beta · invite only'));
    assert.ok(!home.body.includes('class="beta-pill"'));
    assert.ok(home.body.includes('color:#fff'));

    const privacyRes = await get(port, '/privacy');
    assert.strictEqual(privacyRes.status, 200);
    assert.ok(privacyRes.body.includes('Privacy notice'));
    assert.ok(privacyRes.body.includes('href="/terms"'));
    assert.ok(privacyRes.body.includes('pivitlab is a service run by Go2Media'));
    assert.ok(privacyRes.body.includes('deleted 30 days after an account closes'));
    assert.ok(!/\[[A-Z][^\]]+\]/.test(privacyRes.body));

    const termsRes = await get(port, '/terms');
    assert.strictEqual(termsRes.status, 200);
    assert.ok(termsRes.body.includes('Terms of use'));
    assert.ok(termsRes.body.includes('href="/privacy"'));
    assert.ok(termsRes.body.includes('law of Scotland'));
    assert.ok(termsRes.body.includes('pivitlab is a service run by Go2Media'));

    const oldPrivacy = await get(port, '/privacy.html');
    assert.strictEqual(oldPrivacy.status, 301);
    assert.strictEqual(oldPrivacy.headers.location, '/privacy');
    const oldTerms = await get(port, '/legal.html');
    assert.strictEqual(oldTerms.status, 301);
    assert.strictEqual(oldTerms.headers.location, '/terms');

    const joinRes = await get(port, '/join.html');
    assert.strictEqual(joinRes.status, 200);
    assert.ok(joinRes.body.includes('href="/privacy"'));
    assert.ok(joinRes.body.includes('href="/terms"'));

    const appRes = await get(port, '/index.html');
    assert.strictEqual(appRes.status, 200);
    assert.ok(appRes.body.includes('href="/privacy">Privacy</a>'));
    assert.ok(appRes.body.includes('href="/terms">Terms</a>'));

    console.log('legal page tests passed');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
