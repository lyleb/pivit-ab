// Daily rollup of hits to the snippet and the public API, so the move off
// pivit.click can be watched until that host goes quiet. One row per day,
// request host, and customer-site origin — upserted, not one row per hit.
// A failure here must never affect /snippet, /api, or /health.

const db = require('./db');
const { requestIsTestTraffic } = require('./test-traffic');

const UPSERT_SQL = `INSERT INTO host_hits (day, host, referrer_origin, hit_count)
  VALUES ($1::date, $2, $3, 1)
  ON CONFLICT (day, host, referrer_origin)
  DO UPDATE SET hit_count = host_hits.hit_count + 1`;

const MAX_HOST_LENGTH = 253;
const MAX_ORIGIN_LENGTH = 200;

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function windowStartDay(days = 30, now = new Date()) {
  const span = Math.min(Math.max(Number(days) || 30, 1), 366);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (span - 1));
  return { days: span, start: start.toISOString().slice(0, 10) };
}

function headerValue(req, name) {
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

function requestHost(req) {
  const host = (req && req.hostname ? String(req.hostname) : '').trim().toLowerCase();
  if (!host) return '(unknown)';
  return host.slice(0, MAX_HOST_LENGTH);
}

function toOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin.toLowerCase().slice(0, MAX_ORIGIN_LENGTH);
  } catch (err) {
    return '';
  }
}

// Customer site: Origin first (fetch and sendBeacon), then Referer (script tag).
function referrerOriginFromRequest(req) {
  const fromOrigin = toOrigin(headerValue(req, 'origin'));
  if (fromOrigin) return fromOrigin;
  return toOrigin(headerValue(req, 'referer') || headerValue(req, 'referrer'));
}

function requestPath(req) {
  const raw = (req && (req.path || req.url)) || '';
  return String(raw).split('?')[0];
}

// Snippet assets and the public endpoints the snippet calls. Not /health,
// not the admin UI, not owner or client dashboard APIs.
function shouldCountRequest(req) {
  const path = requestPath(req);
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (path === '/health' || path === '/health/') return false;
  // The admin page fetches this for the bookmarklet. It is not the installed snippet.
  if (path === '/snippet/picker-bookmarklet.js') return false;
  if (path === '/snippet' || path.startsWith('/snippet/')) return true;
  if (method === 'GET' && (path === '/api/experiments' || path === '/api/experiments/')) return true;
  if (method === 'GET' && path === '/api/experiments/by-ids') return true;
  if (method === 'POST' && (path === '/api/event' || path === '/api/event/')) return true;
  return false;
}

function hostHitFromRequest(req, now = new Date()) {
  return {
    day: utcDay(now),
    host: requestHost(req),
    referrer_origin: referrerOriginFromRequest(req),
  };
}

function summariseHostHits(rows) {
  const byHost = new Map();
  for (const row of rows || []) {
    const host = row.host || '(unknown)';
    const count = Number(row.hit_count) || 0;
    byHost.set(host, (byHost.get(host) || 0) + count);
  }
  return [...byHost.entries()]
    .map(([host, hit_count]) => ({ host, hit_count }))
    .sort((a, b) => b.hit_count - a.hit_count || a.host.localeCompare(b.host));
}

// Fire-and-forget. Synchronous throws and rejected upserts are logged only.
function utcDateOnly(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

// A stored daily row overlaps a recorded tester window for the same API host
// and customer origin. The hit_count is left as it was.
function rowOverlapsExclusion(row, windows) {
  const day = utcDateOnly(row && row.day);
  if (!day) return false;
  return (windows || []).some((window) => {
    if (String(window.host || '') !== String(row.host || '')) return false;
    if (String(window.referrer_origin || '') !== String(row.referrer_origin || '')) return false;
    const start = utcDateOnly(window.started_at);
    const end = utcDateOnly(window.ended_at);
    return !!(start && end && day >= start && day <= end);
  });
}

function scheduleHostHit(req, queryFn = db.query.bind(db), now = new Date()) {
  try {
    if (!shouldCountRequest(req)) return Promise.resolve();
    // Test traffic is not counted from now on. Past rows stay; see host_hit_exclusions.
    if (requestIsTestTraffic(req)) return Promise.resolve();
    const row = hostHitFromRequest(req, now);
    return Promise.resolve(queryFn(UPSERT_SQL, [row.day, row.host, row.referrer_origin])).catch((err) => {
      console.error('[host-hits] counter failed:', err && err.message ? err.message : err);
    });
  } catch (err) {
    console.error('[host-hits] counter failed:', err && err.message ? err.message : err);
    return Promise.resolve();
  }
}

function hostHitMiddleware(req, res, next) {
  scheduleHostHit(req);
  next();
}

module.exports = {
  UPSERT_SQL,
  utcDay,
  windowStartDay,
  requestHost,
  referrerOriginFromRequest,
  shouldCountRequest,
  hostHitFromRequest,
  summariseHostHits,
  utcDateOnly,
  rowOverlapsExclusion,
  scheduleHostHit,
  hostHitMiddleware,
};
