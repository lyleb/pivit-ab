const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const origin = require('../src/app-origin');
const ui = require('../public/admin-ui');

const previous = process.env.APP_ORIGIN;

function restoreEnv() {
  if (previous === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previous;
}

assert.strictEqual(origin.normaliseAppOrigin(undefined), null);
assert.strictEqual(origin.normaliseAppOrigin(null), null);
assert.strictEqual(origin.normaliseAppOrigin(''), null);
assert.strictEqual(origin.normaliseAppOrigin('   '), null);

assert.strictEqual(origin.normaliseAppOrigin('https://pivitlab.com'), 'https://pivitlab.com');
assert.strictEqual(origin.normaliseAppOrigin('https://pivitlab.com/'), 'https://pivitlab.com');
assert.strictEqual(origin.normaliseAppOrigin('https://pivitlab.com///'), 'https://pivitlab.com');
assert.strictEqual(origin.normaliseAppOrigin('  HTTPS://PivitLab.com/  '), 'https://pivitlab.com');
assert.strictEqual(origin.normaliseAppOrigin('https://pivitlab.com:443'), 'https://pivitlab.com');
assert.strictEqual(origin.normaliseAppOrigin('http://localhost:3000/'), 'http://localhost:3000');
assert.strictEqual(origin.normaliseAppOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
assert.strictEqual(origin.normaliseAppOrigin('http://[::1]:3000'), 'http://[::1]:3000');

assert.strictEqual(origin.normaliseAppOrigin('https://pivitlab.com/snippet'), null);
assert.strictEqual(origin.normaliseAppOrigin('https://pivitlab.com?x=1'), null);
assert.strictEqual(origin.normaliseAppOrigin('https://pivitlab.com#hash'), null);
assert.strictEqual(origin.normaliseAppOrigin('https://user:pass@pivitlab.com'), null);
assert.strictEqual(origin.normaliseAppOrigin('javascript:alert(1)'), null);
assert.strictEqual(origin.normaliseAppOrigin('pivitlab.com'), null);
assert.strictEqual(origin.normaliseAppOrigin('ftp://pivitlab.com'), null);
assert.strictEqual(origin.normaliseAppOrigin('http://'), null);
assert.strictEqual(origin.normaliseAppOrigin('https://evil.com"'), null);

const adminHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(adminHtml.includes("fetch('/api/config')"));
assert.ok(adminHtml.includes('UI.snippetTag'));
assert.ok(adminHtml.includes('UI.clientLoginUrl'));
assert.ok(!adminHtml.includes('${location.origin}/snippet/ab.js'));
assert.ok(!adminHtml.includes('${location.origin}/login.html?role=client'));

delete process.env.APP_ORIGIN;
assert.strictEqual(origin.configuredAppOrigin(), null);
process.env.APP_ORIGIN = 'https://pivitlab.com/';
assert.strictEqual(origin.configuredAppOrigin(), 'https://pivitlab.com');
process.env.APP_ORIGIN = 'not a url';
assert.strictEqual(origin.configuredAppOrigin(), null);
process.env.APP_ORIGIN = 'https://pivitlab.com';

const normalised = origin.configuredAppOrigin();
assert.strictEqual(ui.displayOrigin(normalised, 'https://pivit.click'), 'https://pivitlab.com');
assert.strictEqual(
  ui.snippetTag(ui.displayOrigin(normalised, 'https://pivit.click')),
  '<script src="https://pivitlab.com/snippet/ab.js" data-api="https://pivitlab.com"></script>'
);
assert.strictEqual(
  ui.clientLoginUrl(ui.displayOrigin(normalised, 'https://pivit.click')),
  'https://pivitlab.com/login.html?role=client'
);

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getJson(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/config' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          cache: res.headers['cache-control'],
          location: res.headers.location,
          body: JSON.parse(body),
        });
      });
    });
    req.on('error', reject);
  });
}

(async () => {
  const app = express();
  app.get('/api/config', origin.sendPublicConfig);
  app.get('/health', (req, res) => res.json({ ok: true }));
  const server = await listen(app);
  const { port } = server.address();
  try {
    process.env.APP_ORIGIN = 'https://pivitlab.com/';
    const set = await getJson(port);
    assert.strictEqual(set.status, 200);
    assert.strictEqual(set.location, undefined);
    assert.strictEqual(set.cache, 'no-store');
    assert.deepStrictEqual(set.body, { appOrigin: 'https://pivitlab.com' });

    process.env.APP_ORIGIN = 'https://pivitlab.com/not-an-origin';
    const bad = await getJson(port);
    assert.strictEqual(bad.status, 200);
    assert.deepStrictEqual(bad.body, { appOrigin: null });

    delete process.env.APP_ORIGIN;
    const unset = await getJson(port);
    assert.deepStrictEqual(unset.body, { appOrigin: null });
  } finally {
    restoreEnv();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('app-origin tests passed');
})().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
