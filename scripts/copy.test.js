const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { publicServerError, PUBLIC_ERROR } = require('../src/public-error');

const login = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
assert.ok(login.includes('Forgot password?'));
assert.ok(login.includes('Contact the person who gave you access'));
assert.ok(login.includes('class="invite-action" href="/signup.html">Got an invite code from pivitlab?<br>Create your account</a>'));
assert.ok(login.indexOf('Email me a sign-in link') < login.indexOf('class="invite-action"'));
assert.ok(login.includes('Email me a sign-in link'));
assert.ok(login.includes('Viewing results for a company? Client login →'));
assert.ok(login.includes('href="/login.html?role=client"'));
assert.ok(login.includes('Use the username and password your agency gave you.'));
assert.ok(login.includes("requested === 'client' ? 'client' : 'email'"));
assert.ok(!login.includes('class="mode-switch"'));
assert.ok(!login.includes('>Client login</button>'));
assert.ok(!login.includes('Owner password'));
assert.ok(!login.includes('Owner login'));
assert.ok(!login.includes('/owner'));
assert.ok(!login.includes('The owner password is managed in your hosting settings.'));
assert.ok(!login.includes('ADMIN_API_KEY'));
assert.ok(!/railway/i.test(login));

const checkEmail = fs.readFileSync(path.join(__dirname, '../public/check-email.html'), 'utf8');
const sentLine = "If that address can be used, we've sent a link.";
const noEmailHint = 'No email? You need a pivitlab account first. Ask for an invite, or use the address you signed up with.';
assert.ok(checkEmail.includes(sentLine));
assert.strictEqual(checkEmail.split(noEmailHint).length - 1, 1);
assert.ok(checkEmail.indexOf(sentLine) < checkEmail.indexOf(noEmailHint));
assert.ok(checkEmail.includes("if (purpose === 'signup')"));
assert.ok(!checkEmail.includes('sent.textContent = `We\'ve sent a link to ${email}`'));

const ownerPage = fs.readFileSync(path.join(__dirname, '../src/pages/owner.html'), 'utf8');
assert.ok(ownerPage.includes('Fallback password. Day to day, sign in by email at info@heclr.com.'));
assert.ok(ownerPage.includes('This password is kept in your hosting settings. pivitlab cannot reset it.'));
assert.ok(!ownerPage.includes('Once email sign-in is set up'));
assert.ok(ownerPage.includes("fetch('/api/auth/login'"));
assert.ok(ownerPage.includes('noindex, nofollow'));
assert.ok(ownerPage.includes('https://pivitlab.com/owner'));
assert.ok(!ownerPage.includes('ADMIN_API_KEY'));
assert.ok(!/railway/i.test(ownerPage));

const clientHtml = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
assert.ok(clientHtml.includes('Something went wrong loading your results'));
assert.ok(!clientHtml.includes('data.detail'));
assert.ok(!clientHtml.includes('ADMIN_API_KEY'));
assert.ok(!/railway/i.test(clientHtml));

const adminHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(!adminHtml.includes('ADMIN_API_KEY'));
assert.ok(!/railway/i.test(adminHtml));
assert.ok(adminHtml.includes('Plan saved.'));
assert.ok(adminHtml.includes('Next: review the experiment, then start it.'));
assert.ok(adminHtml.includes('You signed in with the owner password. Day to day, sign in by email at info@heclr.com. This password is only the fallback.'));
assert.ok(!adminHtml.includes('Once email sign-in is set up'));
assert.ok(adminHtml.includes('id="emergency-dismiss"'));
assert.ok(adminHtml.includes("Support view: see another customer's account read-only. Every view is logged."));
assert.ok(!adminHtml.includes('You\'re signed in with the emergency password'));
assert.ok(!adminHtml.includes('View as another account'));
assert.ok(!adminHtml.includes('id="status-value"'));
assert.ok(adminHtml.includes('id="status-archive"'));

const clientRoute = fs.readFileSync(path.join(__dirname, '../src/routes/client.js'), 'utf8');
assert.ok(!clientRoute.includes('detail:'));
assert.ok(clientRoute.includes('publicServerError'));

const auth = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');
auth.split('\n').filter((line) => line.includes('.json(')).forEach((line) => {
  assert.ok(!line.includes('ADMIN_API_KEY'), line);
  assert.ok(!/railway/i.test(line), line);
  assert.ok(!line.includes('detail:'), line);
});

const logs = [];
const original = console.error;
console.error = (err) => logs.push(err);
const body = publicServerError(new Error('password authentication failed for user "postgres"'));
console.error = original;
assert.deepStrictEqual(body, { error: PUBLIC_ERROR });
assert.ok(!JSON.stringify(body).includes('postgres'));
assert.ok(!JSON.stringify(body).includes('detail'));
assert.strictEqual(logs.length, 1);

console.log('copy tests passed');
