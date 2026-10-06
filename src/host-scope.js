// Hostname scoping for experiments. The snippet already sends the page URL;
// this module decides whether that page's host is allowed to receive the
// experiment or to record an event. It does not look at req.hostname — that
// is the API host behind the proxy, not the visitor's page.
//
// HOST_SCOPING=transition (default): an experiment with no domains is served
// as before. HOST_SCOPING=enforce: an experiment with no domains is never
// served. An experiment that has domains is strict in both modes.

const MAX_SEEN_EXPERIMENTS = 500;
const MAX_SEEN_HOSTS = 24;

const seen = new Map(); // experiment id -> Map(host -> { count })
const seenSince = new Date().toISOString();

function hostScopingMode(mode) {
  const raw = mode === undefined || mode === null || mode === ''
    ? process.env.HOST_SCOPING
    : mode;
  if (raw == null || String(raw).trim() === '') return 'transition';
  const value = String(raw).trim().toLowerCase();
  if (value === 'enforce' || value === 'transition') return value;
  return 'transition';
}

// Lower-case, strip a port, one trailing dot, and a single leading "www.".
function normaliseHost(input) {
  if (input == null) return '';
  let host = String(input).trim().toLowerCase();
  if (!host) return '';
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (err) {
      return '';
    }
  }
  host = host.replace(/\.$/, '');
  host = host.replace(/:\d+$/, '');
  host = host.replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function isHost(host) {
  if (!host || host.length > 253 || host.includes('..')) return false;
  if (host === 'localhost') return true;
  if (/^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)) return true;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (labels[labels.length - 1].length < 2) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function hostFromUrlish(value) {
  if (value == null) return '';
  const text = String(Array.isArray(value) ? value[0] : value).trim();
  if (!text || !/^[a-z][a-z0-9+.-]*:/i.test(text)) return '';
  try {
    const hostname = new URL(text).hostname;
    return hostname ? normaliseHost(hostname) : '';
  } catch (err) {
    return '';
  }
}

function headerValue(req, name) {
  if (req && typeof req.get === 'function') {
    const value = req.get(name);
    if (value) return Array.isArray(value) ? value[0] : value;
  }
  const headers = req && req.headers;
  if (!headers) return '';
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || '';
  return raw || '';
}

// Page host for serving experiments: ?url= first (what ab.js sends), then
// Origin, then Referer. Never the API hostname.
function pageHostFromRequest(req) {
  if (!req) return '';
  const query = req.query || {};
  const fromUrl = hostFromUrlish(query.url);
  if (fromUrl) return fromUrl;
  const fromOrigin = hostFromUrlish(headerValue(req, 'origin'));
  if (fromOrigin) return fromOrigin;
  return hostFromUrlish(headerValue(req, 'referer') || headerValue(req, 'referrer'));
}

// Events have no page URL. Trust only Origin, then Referer — a ?url= on the
// beacon must not widen the experiment's domain list.
function originHostFromRequest(req) {
  if (!req) return '';
  const fromOrigin = hostFromUrlish(headerValue(req, 'origin'));
  if (fromOrigin) return fromOrigin;
  return hostFromUrlish(headerValue(req, 'referer') || headerValue(req, 'referrer'));
}

function allowedHostList(allowedHosts) {
  const allowed = [];
  const source = Array.isArray(allowedHosts) ? allowedHosts : [];
  for (const entry of source) {
    const host = normaliseHost(entry);
    if (host && !allowed.includes(host)) allowed.push(host);
  }
  return allowed;
}

// { serve, scoped, reason }
// reasons: unscoped-transition | unscoped-enforce | host-unknown | host-denied | allowed
function checkHost(allowedHosts, pageHost, mode) {
  const allowed = allowedHostList(allowedHosts);
  const host = normaliseHost(pageHost);
  const resolved = hostScopingMode(mode);

  if (allowed.length === 0) {
    if (resolved === 'enforce') return { serve: false, scoped: false, reason: 'unscoped-enforce' };
    return { serve: true, scoped: false, reason: 'unscoped-transition' };
  }
  if (!host) return { serve: false, scoped: true, reason: 'host-unknown' };
  if (allowed.includes(host)) return { serve: true, scoped: true, reason: 'allowed' };
  return { serve: false, scoped: true, reason: 'host-denied' };
}

// Accepts an array or a comma/whitespace separated string. Full URLs are
// reduced to a host. Empty input is a valid empty list.
function parseHostList(input) {
  if (input == null) return { ok: true, hosts: [] };
  let parts;
  if (Array.isArray(input)) parts = input.map((part) => String(part));
  else if (typeof input === 'string') parts = input.split(/[\s,]+/);
  else return { ok: false, error: 'allowed_hosts must be a list of domains' };

  const hosts = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let candidate = trimmed;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      try {
        candidate = new URL(trimmed).hostname;
      } catch (err) {
        return { ok: false, error: `Unrecognised site domain: ${trimmed}` };
      }
    } else if (trimmed.includes('/')) {
      candidate = trimmed.split('/')[0];
    }
    const host = normaliseHost(candidate);
    if (!isHost(host)) return { ok: false, error: `Unrecognised site domain: ${trimmed}` };
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length > 32) return { ok: false, error: 'List at most 32 site domains' };
  return { ok: true, hosts };
}

function recordSeen(experimentId, pageHost) {
  const id = String(experimentId || '').trim();
  const host = normaliseHost(pageHost);
  if (!id || !host) return;

  let bucket = seen.get(id);
  if (bucket) {
    seen.delete(id);
    seen.set(id, bucket);
  } else {
    if (seen.size >= MAX_SEEN_EXPERIMENTS) {
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
    }
    bucket = new Map();
    seen.set(id, bucket);
  }

  const existing = bucket.get(host);
  if (existing) {
    existing.count += 1;
    return;
  }
  if (bucket.size >= MAX_SEEN_HOSTS) return;
  bucket.set(host, { count: 1 });
}

function seenReport() {
  const experiments = {};
  for (const [id, hosts] of seen) {
    experiments[id] = [...hosts.entries()]
      .map(([host, info]) => ({ host, count: info.count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  }
  return { since: seenSince, experiments };
}

function clearSeen() {
  seen.clear();
}

module.exports = {
  normaliseHost,
  pageHostFromRequest,
  originHostFromRequest,
  checkHost,
  parseHostList,
  recordSeen,
  seenReport,
  clearSeen,
  hostScopingMode,
  MAX_SEEN_EXPERIMENTS,
  MAX_SEEN_HOSTS,
};
