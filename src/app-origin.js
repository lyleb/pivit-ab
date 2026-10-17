// Public origin for the snippet tag, the client login link and every link in
// an email. Those URLs come from APP_ORIGIN. They do not use the browser's
// location.origin or the request Host header.
//
// Production (NODE_ENV=production) refuses to start unless APP_ORIGIN is an
// https origin, for example https://pivitlab.com. In development, a missing
// or invalid value falls back to http://127.0.0.1:<port> (port 3000 when
// PORT is unset) and a warning is logged once.
//
// The same acceptance rules live in public/admin-ui.js (displayOrigin) so the
// page can ignore a bad payload on its own. null fallback makes that return
// null here. The dashboard passes null: it does not substitute location.origin.
//
// The HTML pages also get a canonical link. pivitlab.com is the Search Console
// property. pivitlab.co.uk already redirects there, but pivit.click still
// serves these same pages with a 200. The canonical points at the pivitlab.com
// equivalent (or APP_ORIGIN when that is set) so Google knows which host to
// keep. This does not redirect pivit.click — that is a separate migration.
//
// / is the public landing page and is served on its own. The dashboard stays
// at /index.html. Its canonical is /index.html, so it does not compete with
// the landing page. The dashboard remains noindexed.

const fs = require('fs');
const path = require('path');
const { displayOrigin } = require('../public/admin-ui');

const DEFAULT_CANONICAL_ORIGIN = 'https://pivitlab.com';
const DEV_FALLBACK_PORT = '3000';

let warnedFallback = false;

const CANONICAL_PAGES = {
  '/index.html': { file: 'index.html', pathname: '/index.html' },
  '/login.html': { file: 'login.html', pathname: '/login.html' },
  '/client.html': { file: 'client.html', pathname: '/client.html' },
  '/signup.html': { file: 'signup.html', pathname: '/signup.html' },
  '/check-email.html': { file: 'check-email.html', pathname: '/check-email.html' },
  '/sign-in.html': { file: 'sign-in.html', pathname: '/sign-in.html' },
  '/legal.html': { file: 'legal.html', pathname: '/legal.html' },
  '/privacy.html': { file: 'privacy.html', pathname: '/privacy.html' },
};

function normaliseAppOrigin(raw) {
  if (raw == null) return null;
  return displayOrigin(String(raw), null);
}

function configuredAppOrigin() {
  return normaliseAppOrigin(process.env.APP_ORIGIN);
}

function developmentFallbackOrigin(env) {
  const raw = env && env.PORT != null ? String(env.PORT).trim() : '';
  const port = /^\d{1,5}$/.test(raw) && Number(raw) > 0 && Number(raw) <= 65535
    ? String(Number(raw))
    : DEV_FALLBACK_PORT;
  return `http://127.0.0.1:${port}`;
}

function fallbackWarning(origin) {
  return `APP_ORIGIN is unset or is not a valid http or https origin. Using ${origin} for the snippet tag, the client login link and email links. Set APP_ORIGIN to the public https address, for example https://pivitlab.com, before you deploy.`;
}

function productionRefusal() {
  return 'Refusing to start. NODE_ENV is production and APP_ORIGIN must be an https origin, for example https://pivitlab.com. The value is missing or is not https. Set APP_ORIGIN and restart.';
}

// Origin used in the snippet tag, the client login link and email links.
// Overrides are for tests. After exit(1) this throws, so a test stub that
// does not throw still cannot return a non-https origin.
function publicAppOrigin(overrides) {
  const env = (overrides && overrides.env) || process.env;
  const log = (overrides && overrides.log) || console;
  const normalised = normaliseAppOrigin(env && env.APP_ORIGIN);
  const production = !!(env && env.NODE_ENV === 'production');

  if (production) {
    if (!normalised || normalised.indexOf('https://') !== 0) {
      const message = productionRefusal();
      if (log && typeof log.error === 'function') log.error(message);
      const exit = (overrides && overrides.exit) || process.exit;
      exit(1);
      throw new Error(message);
    }
    return normalised;
  }

  if (normalised) return normalised;

  const fallback = developmentFallbackOrigin(env);
  const message = fallbackWarning(fallback);
  if (overrides && overrides.log) {
    if (typeof log.warn === 'function') log.warn(message);
  } else if (!warnedFallback) {
    warnedFallback = true;
    console.warn(message);
  }
  return fallback;
}

// Absolute pivitlab URL. The path must start with one slash so it cannot
// replace the origin (a scheme or a protocol-relative URL would).
function appUrl(path, overrides) {
  const suffix = String(path || '/');
  if (!suffix.startsWith('/') || suffix.startsWith('//')) {
    throw new Error('A pivitlab link must start with a single slash.');
  }
  return publicAppOrigin(overrides) + suffix;
}

function sendPublicConfig(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ appOrigin: publicAppOrigin() });
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
  developmentFallbackOrigin,
  publicAppOrigin,
  appUrl,
  sendPublicConfig,
  canonicalOrigin,
  canonicalUrl,
  applyCanonical,
  canonicalHtmlMiddleware,
};
