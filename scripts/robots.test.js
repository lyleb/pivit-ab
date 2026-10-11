const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { robotsTagMiddleware, sendRobotsTxt, sendSitemap, ROBOTS_TAG, ROBOTS_TXT } = require('../src/robots');
const origin = require('../src/app-origin');
const { sendLandingPage } = require('../src/landing');

const previousOrigin = process.env.APP_ORIGIN;

function restoreOrigin() {
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
}

function runMiddleware(mw, req) {
  const headers = {};
  let called = false;
  mw(req || {}, {
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

const landingHeader = runMiddleware(robotsTagMiddleware, { path: '/' });
assert.strictEqual(landingHeader['X-Robots-Tag'], undefined);
const sitemapHeader = runMiddleware(robotsTagMiddleware, { path: '/sitemap.xml' });
assert.strictEqual(sitemapHeader['X-Robots-Tag'], undefined);
const loginHeader = runMiddleware(robotsTagMiddleware, { path: '/login.html' });
assert.strictEqual(loginHeader['X-Robots-Tag'], ROBOTS_TAG);
const indexHeader = runMiddleware(robotsTagMiddleware, { path: '/index.html' });
assert.strictEqual(indexHeader['X-Robots-Tag'], ROBOTS_TAG);

assert.deepStrictEqual(
  ROBOTS_TXT.split('\n').filter((line) => line !== ''),
  [
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /snippet/',
    'Disallow: /owner',
    'Sitemap: https://pivitlab.com/sitemap.xml',
  ]
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
  'index.html': 'https://pivitlab.com/index.html',
  'login.html': 'https://pivitlab.com/login.html',
  'client.html': 'https://pivitlab.com/client.html',
  'signup.html': 'https://pivitlab.com/signup.html',
  'check-email.html': 'https://pivitlab.com/check-email.html',
  'sign-in.html': 'https://pivitlab.com/sign-in.html',
  'legal.html': 'https://pivitlab.com/legal.html',
  'privacy.html': 'https://pivitlab.com/privacy.html',
};
for (const [file, href] of Object.entries(pagesOnDisk)) {
  const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
  assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'), file);
  assert.ok(html.includes(`<link rel="canonical" href="${href}">`), file);
  assert.strictEqual(html.match(/rel="canonical"/g).length, 1, file);
}
const publicDir = path.join(__dirname, '../public');
for (const file of fs.readdirSync(publicDir)) {
  if (!file.endsWith('.html')) continue;
  const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.ok(!html.includes('href="/owner"'), file);
  assert.ok(!html.includes('href="/owner.html"'), file);
  assert.ok(!html.includes('Owner password'), file);
  assert.ok(!html.includes('Owner login'), file);
}
assert.ok(!fs.existsSync(path.join(publicDir, 'owner.html')));
assert.ok(fs.existsSync(path.join(__dirname, '../src/pages/owner.html')));

assert.ok(!fs.existsSync(path.join(__dirname, '../public/sitemap.xml')));
assert.ok(!fs.existsSync(path.join(__dirname, '../sitemap.xml')));
const landingFile = fs.readFileSync(path.join(__dirname, '../src/pages/landing.html'), 'utf8');
assert.ok(landingFile.includes('<meta name="robots" content="index, follow">'));
assert.ok(!landingFile.includes('noindex'));
assert.ok(landingFile.includes('lang="en-GB"'));
assert.ok(landingFile.includes('<link rel="canonical" href="https://pivitlab.com/">'));
assert.ok(landingFile.includes('<title>pivitlab: A/B testing without the enterprise baggage</title>'));
assert.ok(landingFile.includes('A/B testing without the <span class="accent">enterprise baggage</span>.'));
assert.ok(landingFile.includes('og:title'));
assert.ok(landingFile.includes('og:locale" content="en_GB"'));
assert.ok(landingFile.includes('https://pivitlab.com/assets/og-pivitlab.png'));
assert.ok(landingFile.includes('https://heclr.com'));
assert.ok(landingFile.includes('Built by'));
assert.ok(landingFile.includes('href="/privacy.html"'));
assert.ok(landingFile.includes('href="/legal.html"'));
assert.ok(landingFile.includes('Request access: <a href="mailto:info@pivitlab.com">email info@pivitlab.com</a>'));
assert.ok(fs.existsSync(path.join(__dirname, '../public/assets/og-pivitlab.png')));
const privacy = fs.readFileSync(path.join(__dirname, '../public/privacy.html'), 'utf8');
assert.ok(privacy.includes('Placeholder for Lyle to write'));
assert.ok(privacy.includes("Lyle's wording"));

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
assert.ok(serverSource.includes("app.get('/sitemap.xml', sendSitemap)"));
assert.ok(serverSource.includes("app.get('/', sendLandingPage)"));
assert.ok(!serverSource.includes('future marketing site'));
assert.ok(!serverSource.includes('no sitemap.xml'));

const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
assert.ok(readme.includes('The sitemap lists only `https://pivitlab.com/`.'));
assert.ok(readme.includes('ACCESS_REQUESTS_ENABLED'));

function buildApp() {
  const app = express();
  app.use(robotsTagMiddleware);
  app.use(cors({ origin: true, credentials: true }));
  app.use('/snippet/editor.js', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/robots.txt', sendRobotsTxt);
  app.get('/sitemap.xml', sendSitemap);
  app.get('/', sendLandingPage);
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
      '/index.html': 'http://127.0.0.1:3000/index.html',
      '/login.html': 'http://127.0.0.1:3000/login.html',
      '/login.html?role=client': 'http://127.0.0.1:3000/login.html',
      '/client.html': 'http://127.0.0.1:3000/client.html',
      '/signup.html': 'http://127.0.0.1:3000/signup.html',
      '/check-email.html': 'http://127.0.0.1:3000/check-email.html',
      '/sign-in.html': 'http://127.0.0.1:3000/sign-in.html',
      '/legal.html': 'http://127.0.0.1:3000/legal.html',
      '/privacy.html': 'http://127.0.0.1:3000/privacy.html',
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

    const home = await get(port, '/');
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.headers['x-robots-tag'], undefined);
    assert.ok(home.body.includes('<meta name="robots" content="index, follow">'));
    assert.ok(!home.body.includes('noindex'));
    assert.ok(home.body.includes('<link rel="canonical" href="http://127.0.0.1:3000/">'));
    assert.ok(home.body.includes('A/B testing without the <span class="accent">enterprise baggage</span>.'));
    assert.ok(home.body.includes('Request access: <a href="mailto:info@pivitlab.com">email info@pivitlab.com</a>'));
    assert.ok(!home.body.includes('id="req-form"'));
    assert.strictEqual(home.headers['cache-control'], 'private, no-store');
    assert.ok(home.body.includes('id="invite-card"') === false);

    const headerPaths = ['/index.html', '/login.html', '/client.html', '/privacy.html', '/snippet/ab.js', '/api/config', '/health'];
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
    assert.ok(robots.body.includes('Sitemap: https://pivitlab.com/sitemap.xml'));

    const sitemapLocal = await get(port, '/sitemap.xml');
    assert.strictEqual(sitemapLocal.status, 200);
    assert.strictEqual(sitemapLocal.headers['x-robots-tag'], undefined);
    assert.ok(sitemapLocal.body.includes('<loc>http://127.0.0.1:3000/</loc>'));
    assert.strictEqual(sitemapLocal.body.match(/<loc>/g).length, 1);

    delete process.env.APP_ORIGIN;
    const fallback = await get(port, '/client.html');
    assert.ok(fallback.body.includes('<link rel="canonical" href="https://pivitlab.com/client.html">'));
    const homeFallback = await get(port, '/');
    assert.ok(homeFallback.body.includes('<link rel="canonical" href="https://pivitlab.com/">'));

    const sitemap = await get(port, '/sitemap.xml');
    assert.strictEqual(sitemap.status, 200);
    assert.strictEqual(sitemap.headers['x-robots-tag'], undefined);
    assert.ok(String(sitemap.headers['content-type']).includes('xml'));
    assert.ok(sitemap.body.includes('<loc>https://pivitlab.com/</loc>'));
    assert.strictEqual(sitemap.body.match(/<loc>/g).length, 1);
    assert.ok(!sitemap.body.includes('/login.html'));
    assert.ok(!sitemap.body.includes('/index.html'));
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
