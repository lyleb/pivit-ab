const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { publicServerError, PUBLIC_ERROR } = require('../src/public-error');

const login = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
assert.ok(login.includes('Forgot password?'));
assert.ok(login.includes('The owner password is managed in your hosting settings.'));
assert.ok(login.includes('Contact the person who gave you access'));
assert.ok(!login.includes('ADMIN_API_KEY'));
assert.ok(!/railway/i.test(login));

const clientHtml = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
assert.ok(clientHtml.includes('Something went wrong loading your results'));
assert.ok(!clientHtml.includes('data.detail'));
assert.ok(!clientHtml.includes('ADMIN_API_KEY'));
assert.ok(!/railway/i.test(clientHtml));

const adminHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(!adminHtml.includes('ADMIN_API_KEY'));
assert.ok(!/railway/i.test(adminHtml));

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
