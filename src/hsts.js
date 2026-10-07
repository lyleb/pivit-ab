// Strict-Transport-Security for every HTTPS response.
//
// Railway's edge already sends plain-HTTP visitors a 301 to https, but without
// HSTS a browser still makes that first unencrypted request every time someone
// types the bare domain or follows an old http:// link or bookmark. HSTS tells
// the browser to go straight to https on later visits, so the page never shows
// "Not secure" on the way in.
//
// The header is only sent when the request reached us over HTTPS (req.secure
// relies on app.set('trust proxy', 1) and Railway's X-Forwarded-Proto). Local
// http development never gets it, which matches the spec: browsers ignore HSTS
// on plain HTTP anyway.
//
// Deliberately no includeSubDomains and no preload. Both are hard to undo and
// cover hosts this app does not serve. HSTS_MAX_AGE (seconds) overrides the
// default; HSTS_MAX_AGE=0 sends max-age=0, which tells browsers to forget the
// policy if it ever needs rolling back.

const DEFAULT_MAX_AGE = 15552000; // 180 days

function hstsMaxAge(env = process.env) {
  const raw = env.HSTS_MAX_AGE;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_AGE;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0) return DEFAULT_MAX_AGE;
  return value;
}

function hstsMiddleware(env = process.env) {
  const header = `max-age=${hstsMaxAge(env)}`;
  return function hsts(req, res, next) {
    if (req.secure) res.setHeader('Strict-Transport-Security', header);
    next();
  };
}

module.exports = { hstsMiddleware, hstsMaxAge, DEFAULT_MAX_AGE };
