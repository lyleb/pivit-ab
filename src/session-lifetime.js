// Customers stay signed in for 30 days of activity (idle), and no session
// lasts more than 90 days from sign-in (absolute), even if they keep using
// it. Superadmin sessions, including the emergency password, last 12 hours
// from sign-in and are not renewed. Both deadlines are stored in the session
// row in Postgres. The cookie name stays pivit.sid (with the __Host- prefix
// in production).

const crypto = require('crypto');
const { clearSessionCookie } = require('./session-cookie');

const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CUSTOMER_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const SUPERADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

function isSuperadminSession(session) {
  if (!session || !session.role) return false;
  if (session.superadmin === true) return true;
  return session.role === 'owner' && session.customer !== true;
}

function limitsFor(session) {
  if (isSuperadminSession(session)) {
    return { idleMs: SUPERADMIN_SESSION_MS, absoluteMs: SUPERADMIN_SESSION_MS, rolling: false };
  }
  return { idleMs: CUSTOMER_SESSION_MS, absoluteMs: CUSTOMER_ABSOLUTE_MS, rolling: true };
}

function emergencyKeyId() {
  const key = process.env.ADMIN_API_KEY || '';
  if (!key) return '';
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

// Fills the deadlines on a new session. Does not rotate the id.
function stampSessionLifetime(session, now = Date.now()) {
  const limits = limitsFor(session);
  session.signedInAt = now;
  session.lastSeenAt = now;
  session.absoluteExpiresAt = now + limits.absoluteMs;
  if (session.cookie) session.cookie.maxAge = limits.idleMs;
  if (session.emergency) session.emergencyKeyId = emergencyKeyId();
  else if (session.emergencyKeyId) delete session.emergencyKeyId;
  return limits;
}

// Returns 'idle', 'absolute', or 'emergency-key' when the session must end.
// A live customer session has its idle window renewed, capped by the absolute
// deadline. A superadmin session is not renewed. Missing timestamps on an
// older row are filled from signedInAt so a deploy does not invent a new
// absolute clock.
function sessionExpiryReason(session, now = Date.now()) {
  if (!session || !session.role) return null;
  const limits = limitsFor(session);
  if (!session.signedInAt) session.signedInAt = now;
  if (!session.absoluteExpiresAt) {
    session.absoluteExpiresAt = Number(session.signedInAt) + limits.absoluteMs;
  }
  if (!session.lastSeenAt) session.lastSeenAt = Number(session.signedInAt);
  if (now >= Number(session.absoluteExpiresAt)) return 'absolute';
  if (now >= Number(session.lastSeenAt) + limits.idleMs) return 'idle';
  if (session.emergency) {
    const current = emergencyKeyId();
    if (session.emergencyKeyId && session.emergencyKeyId !== current) return 'emergency-key';
    if (!session.emergencyKeyId && current) session.emergencyKeyId = current;
  }
  if (limits.rolling) {
    session.lastSeenAt = now;
    const remaining = Number(session.absoluteExpiresAt) - now;
    if (session.cookie) session.cookie.maxAge = Math.min(limits.idleMs, remaining);
  }
  return null;
}

function sessionLifetime(req, res, next) {
  const session = req.session;
  if (!session || !session.role) return next();
  const reason = sessionExpiryReason(session, Date.now());
  if (!reason) return next();
  if (typeof session.destroy !== 'function') {
    clearSessionCookie(res);
    req.session = null;
    return next();
  }
  return session.destroy(() => {
    clearSessionCookie(res);
    next();
  });
}

module.exports = {
  CUSTOMER_SESSION_MS,
  CUSTOMER_ABSOLUTE_MS,
  SUPERADMIN_SESSION_MS,
  sessionLifetime,
  isSuperadminSession,
  limitsFor,
  emergencyKeyId,
  stampSessionLifetime,
  sessionExpiryReason,
};
