// Unlisted owner-password page. Not linked from the public sign-in page.
// The password is still checked by POST /api/auth/login, which keeps its
// existing lockout. This page has its own limit so the URL cannot be hammered.

const fs = require('fs');
const path = require('path');
const { hit } = require('./rate-limit');
const { applyCanonical, canonicalUrl } = require('./app-origin');

const HTML = fs.readFileSync(path.join(__dirname, 'pages', 'owner.html'), 'utf8');
const WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 30;

function ownerPageLimit() {
  const n = Number(process.env.OWNER_PAGE_LIMIT);
  if (Number.isFinite(n) && n >= 1) return Math.round(n);
  return DEFAULT_LIMIT;
}

async function sendOwnerPage(req, res) {
  try {
    const limited = await hit(`page:owner:${req.ip || 'unknown'}`, ownerPageLimit(), WINDOW_MS);
    if (!limited.ok) {
      res.set('Retry-After', String(limited.retryAfter));
      res.status(429).type('text/plain').send('Please wait a moment and try again.');
      return;
    }
  } catch (err) {
    console.error('[owner] rate limit check failed', err);
  }
  res.set('Cache-Control', 'no-store');
  res.type('html').send(applyCanonical(HTML, canonicalUrl('/owner')));
}

module.exports = { sendOwnerPage, ownerPageLimit, WINDOW_MS };
