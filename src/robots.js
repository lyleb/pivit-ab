// X-Robots-Tag on every response except the public landing page (/) and
// /sitemap.xml. The dashboard, client portal, snippet, /api, /health and
// /owner stay noindex. The header does not set Cache-Control or CORS.

const { canonicalUrl } = require('./app-origin');

const ROBOTS_TAG = 'noindex, nofollow';
const INDEXABLE = new Set(['/', '/sitemap.xml']);

function indexablePath(req) {
  const path = req && typeof req.path === 'string' ? req.path : '';
  return INDEXABLE.has(path);
}

function robotsTagMiddleware(req, res, next) {
  if (!indexablePath(req)) res.setHeader('X-Robots-Tag', ROBOTS_TAG);
  next();
}

// Leave the HTML pages crawlable so Google can fetch them and see either
// the landing page or the noindex on everything else. Disallow: /
// would stop that. /api, /snippet and /owner are not documents to crawl.
// The sitemap lists only the landing page.
const ROBOTS_TXT = [
  'User-agent: *',
  'Disallow: /api/',
  'Disallow: /snippet/',
  'Disallow: /owner',
  'Sitemap: https://pivitlab.com/sitemap.xml',
  '',
].join('\n');

function sendRobotsTxt(req, res) {
  res.type('text/plain');
  res.send(ROBOTS_TXT);
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[ch]));
}

function sendSitemap(req, res) {
  const loc = canonicalUrl('/');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${escapeXml(loc)}</loc></url>`,
    '</urlset>',
    '',
  ].join('\n');
  res.type('application/xml');
  res.set('Cache-Control', 'public, max-age=0');
  res.send(xml);
}

module.exports = {
  ROBOTS_TAG,
  ROBOTS_TXT,
  INDEXABLE,
  indexablePath,
  robotsTagMiddleware,
  sendRobotsTxt,
  sendSitemap,
};
