// State-changing requests must come from this app's own origin. The check is
// the Origin header, or the Referer origin when Origin was not sent. A
// present but unusable Origin is rejected and is not rescued by Referer.
// Production allows https://pivitlab.com, APP_ORIGIN, and any comma-separated
// APP_ORIGINS. It does not trust the request Host, so a Railway or pivit.click
// page cannot post into an account. Outside production the request's own
// origin is also allowed, so localhost and the test suite can sign in.
//
// The public snippet posts /api/event from the customer's site. The visual
// editor posts /api/editor with an edit token, also from that site. Postmark
// calls /api/webhooks with no browser origin. Those paths are exempt. Every
// other POST, PUT, PATCH and DELETE is checked.

const { configuredAppOrigin } = require('./app-origin');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CANONICAL_ORIGIN = 'https://pivitlab.com';

function header(req, name) {
  if (req && typeof req.get === 'function') {
    const value = req.get(name);
    if (value) return Array.isArray(value) ? value[0] : value;
  }
  const headers = req && req.headers;
  if (!headers) return '';
  const raw = headers[String(name).toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || '';
  return raw || '';
}

function originOf(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    if (url.username || url.password) return '';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin.toLowerCase();
  } catch (err) {
    return '';
  }
}

function requestPath(req) {
  const raw = (req && (req.originalUrl || req.url || req.path)) || '';
  return String(raw).split('?')[0];
}

// Origin wins when the browser sent it, including the literal "null".
// Referer is only the fallback for clients that omit Origin entirely.
function requestOrigin(req) {
  const originHeader = header(req, 'origin');
  if (originHeader) return originOf(originHeader);
  return originOf(header(req, 'referer') || header(req, 'referrer'));
}

function configuredOrigins() {
  const list = [CANONICAL_ORIGIN];
  const app = configuredAppOrigin();
  if (app) list.push(String(app).toLowerCase());
  const extra = process.env.APP_ORIGINS || '';
  for (const part of String(extra).split(',')) {
    const origin = originOf(part);
    if (origin) list.push(origin);
  }
  return [...new Set(list)];
}

function allowedOrigins(req) {
  const list = configuredOrigins();
  // Outside production, accept the host the request actually arrived on.
  // Production does not: only pivitlab.com and configured origins.
  if (process.env.NODE_ENV !== 'production') {
    const host = header(req, 'host');
    const proto = (req && req.protocol) || 'http';
    if (host && (proto === 'http' || proto === 'https')) {
      list.push(`${proto}://${String(host).toLowerCase()}`);
    }
  }
  return list;
}

function exempt(req) {
  const path = requestPath(req);
  if (path === '/api/event' || path.startsWith('/api/event/')) return true;
  if (path === '/api/editor' || path.startsWith('/api/editor/')) return true;
  if (path === '/api/webhooks' || path.startsWith('/api/webhooks/')) return true;
  return false;
}

function originAllowed(req) {
  if (!req || !UNSAFE.has(String(req.method || '').toUpperCase())) return true;
  if (exempt(req)) return true;
  const origin = requestOrigin(req);
  if (!origin) return false;
  return allowedOrigins(req).includes(origin);
}

function csrfMiddleware(req, res, next) {
  if (originAllowed(req)) return next();
  return res.status(403).json({ error: 'This request was blocked.' });
}

module.exports = {
  originAllowed,
  csrfMiddleware,
  allowedOrigins,
  requestOrigin,
  configuredOrigins,
  CANONICAL_ORIGIN,
};
