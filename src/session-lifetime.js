// Customers stay signed in for 30 days, and an active visit renews that.
// Superadmin sessions, including the emergency password, last 12 hours from
// sign-in and are not renewed. The cookie name stays pivit.sid.

const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SUPERADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const RENEW_WHEN_UNDER_MS = CUSTOMER_SESSION_MS - (12 * 60 * 60 * 1000);

function isSuperadminSession(session) {
  if (!session || !session.role) return false;
  if (session.superadmin === true) return true;
  return session.role === 'owner' && session.customer !== true;
}

function sessionLifetime(req, res, next) {
  const session = req.session;
  if (!session || !session.role) return next();
  if (isSuperadminSession(session)) {
    if (!session.signedInAt) session.signedInAt = Date.now();
    const end = Number(session.signedInAt) + SUPERADMIN_SESSION_MS;
    if (Date.now() >= end) {
      return session.destroy(() => {
        res.clearCookie('pivit.sid');
        next();
      });
    }
    return next();
  }
  if (session.cookie) {
    const left = Number(session.cookie.maxAge) || 0;
    if (left < RENEW_WHEN_UNDER_MS) session.cookie.maxAge = CUSTOMER_SESSION_MS;
  }
  return next();
}

module.exports = {
  CUSTOMER_SESSION_MS,
  SUPERADMIN_SESSION_MS,
  sessionLifetime,
  isSuperadminSession,
};
