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
assert.ok(adminHtml.includes('displayOrigin(configuredAppOrigin, null)'));
assert.ok(adminHtml.includes('The public address is not available yet.'));
assert.ok(!adminHtml.includes('${location.origin}/snippet/ab.js'));
assert.ok(!adminHtml.includes('${location.origin}/login.html?role=client'));
assert.ok(!adminHtml.includes('displayOrigin(configuredAppOrigin, location.origin)'));

assert.strictEqual(ui.displayOrigin('https://pivitlab.com', null), 'https://pivitlab.com');
assert.strictEqual(ui.displayOrigin(null, null), null);
assert.strictEqual(ui.displayOrigin('javascript:alert(1)', null), null);
assert.strictEqual(
  ui.snippetTag('https://pivitlab.com'),
  '<script src="https://pivitlab.com/snippet/ab.js" data-api="https://pivitlab.com"></script>'
);

const emailFiles = [
  'src/auth-flow.js',
  'src/access-requests.js',
  'src/review-request.js',
  'src/conclusion.js',
  'src/account-invite.js',
];
for (const file of emailFiles) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.ok(src.includes('appUrl('), file);
  assert.ok(!src.includes("req.get('host')"), file);
  assert.ok(!src.includes('req.get("host")'), file);
  assert.ok(!src.includes('req.protocol'), file);
  assert.ok(!src.includes("|| 'https://pivitlab.com'"), file);
  assert.ok(!src.includes('location.origin'), file);
}
const editorContext = fs.readFileSync(path.join(__dirname, '../src/editor-context.js'), 'utf8');
assert.ok(editorContext.includes('appUrl('));
assert.ok(!editorContext.includes("req.get('host')"));
assert.ok(!editorContext.includes('req.protocol'));

function quiet() {
  return { warn() {}, error() {} };
}

function boot(env) {
  const logs = [];
  let exited = null;
  let value = null;
  try {
    value = origin.publicAppOrigin({
      env,
      exit(code) {
        exited = code;
        throw new Error('exit');
      },
      log: {
        warn(msg) { logs.push(['warn', msg]); },
        error(msg) { logs.push(['error', msg]); },
      },
    });
  } catch (err) {
    if (err.message !== 'exit') throw err;
  }
  return { value, exited, logs };
}

const productionOk = boot({ NODE_ENV: 'production', APP_ORIGIN: 'https://pivitlab.com/' });
assert.strictEqual(productionOk.exited, null);
assert.strictEqual(productionOk.value, 'https://pivitlab.com');
assert.strictEqual(productionOk.logs.length, 0);
assert.strictEqual(
  origin.appUrl('/sign-in.html?token=abc', {
    env: { NODE_ENV: 'production', APP_ORIGIN: 'https://pivitlab.com' },
    exit(code) { throw new Error('exit ' + code); },
    log: quiet(),
  }),
  'https://pivitlab.com/sign-in.html?token=abc'
);

for (const bad of [undefined, '', '   ', 'http://127.0.0.1:3000', 'http://pivitlab.com', 'https://pivitlab.com/admin', 'not a url']) {
  const refused = boot({ NODE_ENV: 'production', APP_ORIGIN: bad });
  assert.strictEqual(refused.exited, 1, String(bad));
  assert.strictEqual(refused.value, null, String(bad));
  assert.ok(refused.logs.some(([level, msg]) => level === 'error' && msg.includes('https://pivitlab.com')), String(bad));
  assert.ok(refused.logs.every(([, msg]) => !msg.includes('Host')), String(bad));
}

const devHttp = boot({ NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:3000/' });
assert.strictEqual(devHttp.exited, null);
assert.strictEqual(devHttp.value, 'http://localhost:3000');
assert.strictEqual(devHttp.logs.length, 0);

const devMissing = boot({ NODE_ENV: 'development' });
assert.strictEqual(devMissing.exited, null);
assert.strictEqual(devMissing.value, 'http://127.0.0.1:3000');
assert.ok(devMissing.logs.some(([level, msg]) => level === 'warn' && msg.includes('snippet tag') && msg.includes('pivitlab')));
assert.ok(!devMissing.logs.some(([, msg]) => /Pivitlab/.test(msg)));

const customPort = boot({ NODE_ENV: 'test', PORT: '4010' });
assert.strictEqual(customPort.value, 'http://127.0.0.1:4010');
assert.strictEqual(boot({ NODE_ENV: 'test', PORT: 'nope' }).value, 'http://127.0.0.1:3000');
assert.strictEqual(boot({ NODE_ENV: 'test', PORT: '0' }).value, 'http://127.0.0.1:3000');
assert.strictEqual(boot({ NODE_ENV: 'test', PORT: '65536' }).value, 'http://127.0.0.1:3000');

assert.strictEqual(
  origin.appUrl('/index.html', { env: { NODE_ENV: 'development', APP_ORIGIN: 'https://pivitlab.com' }, log: quiet() }),
  'https://pivitlab.com/index.html'
);
assert.strictEqual(
  origin.appUrl('/', { env: { NODE_ENV: 'test', PORT: '4010' }, log: quiet() }),
  'http://127.0.0.1:4010/'
);
assert.throws(() => origin.appUrl('//evil.example', { env: { NODE_ENV: 'test', APP_ORIGIN: 'https://pivitlab.com' }, log: quiet() }), /single slash/);

const savedNodeEnv = process.env.NODE_ENV;
const savedPort = process.env.PORT;
const warnings = [];
const originalWarn = console.warn;
console.warn = (msg) => warnings.push(String(msg));
try {
  process.env.NODE_ENV = 'development';
  delete process.env.APP_ORIGIN;
  delete process.env.PORT;
  assert.strictEqual(origin.publicAppOrigin(), 'http://127.0.0.1:3000');
  assert.strictEqual(origin.publicAppOrigin(), 'http://127.0.0.1:3000');
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('email links'));
  assert.ok(warnings[0].includes('https://pivitlab.com'));
} finally {
  console.warn = originalWarn;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;
}

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

function getJson(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/config', headers }, (res) => {
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

    process.env.NODE_ENV = 'test';
    delete process.env.PORT;
    process.env.APP_ORIGIN = 'https://pivitlab.com/not-an-origin';
    const bad = await getJson(port, { Host: 'evil.example' });
    assert.strictEqual(bad.status, 200);
    assert.deepStrictEqual(bad.body, { appOrigin: 'http://127.0.0.1:3000' });
    assert.deepStrictEqual(Object.keys(bad.body), ['appOrigin']);

    delete process.env.APP_ORIGIN;
    const unset = await getJson(port, { Host: 'pivit.click' });
    assert.deepStrictEqual(unset.body, { appOrigin: 'http://127.0.0.1:3000' });
    assert.ok(!JSON.stringify(unset.body).includes('pivit.click'));
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
