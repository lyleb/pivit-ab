// State-changing requests must come from this app's own origin. The public
// snippet and the visual editor run on the customer's site, so those paths
// are exempt. A missing Origin is rejected: browsers send it on fetch().

const { configuredAppOrigin } = require('./app-origin');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin.toLowerCase();
  } catch (err) {
    return '';
  }
}

function requestOrigin(req) {
  return originOf(header(req, 'origin')) || originOf(header(req, 'referer') || header(req, 'referrer'));
}

function allowedOrigins(req) {
  const list = [];
  const host = header(req, 'host');
  const proto = (req && req.protocol) || 'http';
  if (host && (proto === 'http' || proto === 'https')) {
    list.push(`${proto}://${host}`.toLowerCase());
  }
  const app = configuredAppOrigin();
  if (app) list.push(String(app).toLowerCase());
  list.push('https://pivitlab.com');
  return list;
}

function exempt(req) {
  const path = String((req && req.path) || '').split('?')[0];
  if (path === '/api/event' || path === '/api/event/') return true;
  if (path.startsWith('/api/editor')) return true;
  if (path.startsWith('/api/webhooks')) return true;
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

module.exports = { originAllowed, csrfMiddleware, allowedOrigins, requestOrigin };
