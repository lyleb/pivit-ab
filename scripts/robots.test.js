const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { robotsTagMiddleware, sendRobotsTxt, ROBOTS_TAG, ROBOTS_TXT } = require('../src/robots');
const origin = require('../src/app-origin');

const previousOrigin = process.env.APP_ORIGIN;

function restoreOrigin() {
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
}

function runMiddleware(mw) {
  const headers = {};
  let called = false;
  mw({}, {
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
  }, () => { called = true; });
  assert.strictEqual(called, true);
  return headers;
}

const headerOnly = runMiddleware(robotsTagMiddleware);
assert.strictEqual(headerOnly['X-Robots-Tag'], ROBOTS_TAG);
assert.strictEqual(headerOnly['Cache-Control'], undefined);
assert.strictEqual(headerOnly['Access-Control-Allow-Origin'], undefined);

assert.deepStrictEqual(
  ROBOTS_TXT.split('\n').filter((line) => line !== ''),
  ['User-agent: *', 'Disallow: /api/', 'Disallow: /snippet/']
);
assert.ok(!ROBOTS_TXT.split('\n').includes('Disallow: /'));

delete process.env.APP_ORIGIN;
assert.strictEqual(origin.canonicalOrigin(), 'https://pivitlab.com');
assert.strictEqual(origin.canonicalUrl('/'), 'https://pivitlab.com/');
assert.strictEqual(origin.canonicalUrl('/login.html'), 'https://pivitlab.com/login.html');
assert.strictEqual(origin.canonicalUrl('/client.html'), 'https://pivitlab.com/client.html');

process.env.APP_ORIGIN = 'https://pivitlab.com/';
assert.strictEqual(origin.canonicalUrl('/login.html'), 'https://pivitlab.com/login.html');
process.env.APP_ORIGIN = 'not a url';
assert.strictEqual(origin.canonicalOrigin(), 'https://pivitlab.com');
process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
assert.strictEqual(origin.canonicalUrl('/'), 'http://127.0.0.1:3000/');
assert.strictEqual(origin.canonicalUrl('/client.html'), 'http://127.0.0.1:3000/client.html');

const rewritten = origin.applyCanonical(
  '<meta name="robots" content="noindex, nofollow">\n<link rel="canonical" href="https://pivitlab.com/login.html">',
  'http://127.0.0.1:3000/login.html'
);
assert.strictEqual(
  rewritten,
  '<meta name="robots" content="noindex, nofollow">\n<link rel="canonical" href="http://127.0.0.1:3000/login.html">'
);
assert.strictEqual(rewritten.match(/rel="canonical"/g).length, 1);

const pagesOnDisk = {
  'index.html': 'https://pivitlab.com/',
  'login.html': 'https://pivitlab.com/login.html',
  'client.html': 'https://pivitlab.com/client.html',
  'signup.html': 'https://pivitlab.com/signup.html',
  'check-email.html': 'https://pivitlab.com/check-email.html',
  'sign-in.html': 'https://pivitlab.com/sign-in.html',
  'legal.html': 'https://pivitlab.com/legal.html',
};
for (const [file, href] of Object.entries(pagesOnDisk)) {
  const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
  assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'), file);
  assert.ok(html.includes(`<link rel="canonical" href="${href}">`), file);
  assert.strictEqual(html.match(/rel="canonical"/g).length, 1, file);
}
assert.ok(!fs.existsSync(path.join(__dirname, '../public/sitemap.xml')));
assert.ok(!fs.existsSync(path.join(__dirname, '../sitemap.xml')));

const serverSource = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
const robotsUse = serverSource.indexOf('app.use(robotsTagMiddleware)');
const corsUse = serverSource.indexOf('app.use(cors(');
const robotsRoute = serverSource.indexOf("app.get('/robots.txt', sendRobotsTxt)");
const canonicalUse = serverSource.indexOf('app.use(canonicalHtmlMiddleware)');
const staticUse = serverSource.indexOf('express.static(');
assert.ok(robotsUse !== -1 && robotsUse < corsUse, 'robots header must be registered before CORS');
assert.ok(robotsRoute !== -1 && robotsRoute < staticUse, 'robots.txt must be registered before static files');
assert.ok(canonicalUse !== -1 && canonicalUse < staticUse, 'canonical HTML must be served before static files');
assert.ok(serverSource.includes('Disallow: /'));
assert.ok(!serverSource.includes('sitemap.xml') || serverSource.includes('no sitemap.xml'));
assert.ok(serverSource.includes('future marketing site'));

const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
assert.ok(readme.includes('A sitemap belongs on the future marketing site.'));

function buildApp() {
  const app = express();
  app.use(robotsTagMiddleware);
  app.use(cors({ origin: true, credentials: true }));
  app.use('/snippet/editor.js', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/robots.txt', sendRobotsTxt);
  app.use(origin.canonicalHtmlMiddleware);
  app.use('/snippet', express.static(path.join(__dirname, '../snippet')));
  app.use(express.static(path.join(__dirname, '../public')));
  app.get('/api/config', origin.sendPublicConfig);
  app.get('/health', (req, res) => res.json({ ok: true }));
  return app;
}

function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, headers }, (res) => {
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

(async () => {
  const server = await new Promise((resolve) => {
    const listening = buildApp().listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    process.env.APP_ORIGIN = 'http://127.0.0.1:3000';

    const expectedCanonical = {
      '/': 'http://127.0.0.1:3000/',
      '/index.html': 'http://127.0.0.1:3000/',
      '/login.html': 'http://127.0.0.1:3000/login.html',
      '/login.html?role=client': 'http://127.0.0.1:3000/login.html',
      '/client.html': 'http://127.0.0.1:3000/client.html',
      '/signup.html': 'http://127.0.0.1:3000/signup.html',
      '/check-email.html': 'http://127.0.0.1:3000/check-email.html',
      '/sign-in.html': 'http://127.0.0.1:3000/sign-in.html',
      '/legal.html': 'http://127.0.0.1:3000/legal.html',
    };

    for (const [urlPath, href] of Object.entries(expectedCanonical)) {
      const res = await get(port, urlPath);
      assert.strictEqual(res.status, 200, urlPath);
      assert.strictEqual(res.headers['x-robots-tag'], 'noindex, nofollow', urlPath);
      assert.ok(res.body.includes('<meta name="robots" content="noindex, nofollow">'), urlPath);
      assert.ok(res.body.includes(`<link rel="canonical" href="${href}">`), `${urlPath} canonical`);
      assert.strictEqual(res.body.match(/rel="canonical"/g).length, 1, urlPath);
      assert.strictEqual(res.headers['cache-control'], 'public, max-age=0', urlPath);
    }

    const headerPaths = ['/', '/login.html', '/client.html', '/snippet/ab.js', '/api/config', '/health'];
    for (const urlPath of headerPaths) {
      const res = await get(port, urlPath);
      assert.strictEqual(res.status, 200, urlPath);
      assert.strictEqual(res.headers['x-robots-tag'], 'noindex, nofollow', urlPath);
    }

    const snippet = await get(port, '/snippet/ab.js', { Origin: 'https://shop.example' });
    assert.strictEqual(snippet.headers['cache-control'], 'public, max-age=0');
    assert.ok(!String(snippet.headers['cache-control']).includes('no-store'));
    assert.strictEqual(snippet.headers['access-control-allow-origin'], 'https://shop.example');
    assert.strictEqual(snippet.headers['access-control-allow-credentials'], 'true');
    assert.ok(snippet.body.includes('function') || snippet.body.length > 0);

    const editor = await get(port, '/snippet/editor.js');
    assert.strictEqual(editor.status, 200);
    assert.strictEqual(editor.headers['x-robots-tag'], 'noindex, nofollow');
    assert.strictEqual(editor.headers['cache-control'], 'no-store');

    const config = await get(port, '/api/config');
    assert.strictEqual(config.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(JSON.parse(config.body), { appOrigin: 'http://127.0.0.1:3000' });

    const health = await get(port, '/health');
    assert.deepStrictEqual(JSON.parse(health.body), { ok: true });

    const robots = await get(port, '/robots.txt');
    assert.strictEqual(robots.status, 200);
    assert.strictEqual(robots.headers['x-robots-tag'], 'noindex, nofollow');
    assert.ok(String(robots.headers['content-type']).startsWith('text/plain'));
    assert.strictEqual(robots.body, ROBOTS_TXT);

    delete process.env.APP_ORIGIN;
    const fallback = await get(port, '/client.html');
    assert.ok(fallback.body.includes('<link rel="canonical" href="https://pivitlab.com/client.html">'));

    const sitemap = await get(port, '/sitemap.xml');
    assert.strictEqual(sitemap.status, 404);
    assert.strictEqual(sitemap.headers['x-robots-tag'], 'noindex, nofollow');
  } finally {
    restoreOrigin();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('robots tests passed');
})().catch((err) => {
  restoreOrigin();
  console.error(err);
  process.exit(1);
});
