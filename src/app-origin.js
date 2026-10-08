// Optional public origin for URLs the admin UI shows (snippet tag, client login).
// APP_ORIGIN is a feature flag: unset or invalid means the UI keeps using
// location.origin. This does not change which host serves traffic.
//
// The same rules live in public/admin-ui.js (displayOrigin) so the page can
// ignore a bad payload on its own. null fallback makes that return null here.
//
// The HTML pages also get a canonical link. pivitlab.com is the Search Console
// property. pivitlab.co.uk already redirects there, but pivit.click still
// serves these same pages with a 200. The canonical points at the pivitlab.com
// equivalent (or APP_ORIGIN when that is set) so Google knows which host to
// keep. This does not redirect pivit.click — that is a separate migration.

const fs = require('fs');
const path = require('path');
const { displayOrigin } = require('../public/admin-ui');

const DEFAULT_CANONICAL_ORIGIN = 'https://pivitlab.com';

// / and /index.html are the same dashboard. The canonical is the root URL,
// which is the address the app is actually opened at.
const CANONICAL_PAGES = {
  '/': { file: 'index.html', pathname: '/' },
  '/index.html': { file: 'index.html', pathname: '/' },
  '/login.html': { file: 'login.html', pathname: '/login.html' },
  '/client.html': { file: 'client.html', pathname: '/client.html' },
};

function normaliseAppOrigin(raw) {
  if (raw == null) return null;
  return displayOrigin(String(raw), null);
}

function configuredAppOrigin() {
  return normaliseAppOrigin(process.env.APP_ORIGIN);
}

function sendPublicConfig(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ appOrigin: configuredAppOrigin() });
}

function canonicalOrigin() {
  return configuredAppOrigin() || DEFAULT_CANONICAL_ORIGIN;
}

function canonicalUrl(pathname) {
  const page = pathname === '/' || pathname === '' ? '/' : pathname;
  return canonicalOrigin() + page;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function applyCanonical(html, url) {
  const tag = `<link rel="canonical" href="${escapeAttr(url)}">`;
  if (/<link rel="canonical" href="[^"]*">/.test(html)) {
    return html.replace(/<link rel="canonical" href="[^"]*">/, tag);
  }
  const robots = '<meta name="robots" content="noindex, nofollow">';
  if (html.includes(robots)) return html.replace(robots, `${robots}\n${tag}`);
  return html.replace('</head>', `${tag}\n</head>`);
}

// Serves the three HTML pages with the canonical href filled in. Registered
// before express.static so the file on disk is not sent unchanged.
// Cache-Control matches express.static's default (maxAge 0). Nothing else
// about caching is set here.
function canonicalHtmlMiddleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const page = CANONICAL_PAGES[req.path];
  if (!page) return next();
  const filePath = path.join(__dirname, '../public', page.file);
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next();
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=0');
    res.type('html');
    res.send(applyCanonical(html, canonicalUrl(page.pathname)));
  });
}

module.exports = {
  DEFAULT_CANONICAL_ORIGIN,
  CANONICAL_PAGES,
  normaliseAppOrigin,
  configuredAppOrigin,
  sendPublicConfig,
  canonicalOrigin,
  canonicalUrl,
  applyCanonical,
  canonicalHtmlMiddleware,
};
