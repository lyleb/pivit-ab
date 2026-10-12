// The session cookie stays pivit.sid. In production it is prefixed __Host-,
// which browsers only store when the cookie is Secure, Path=/, and has no
// Domain. That is safe on https://pivitlab.com (Railway terminates TLS and
// the app trusts the proxy). Over plain HTTP the browser would drop a
// __Host- cookie, so local development and the test suite keep pivit.sid.

const COOKIE_NAME = 'pivit.sid';

function sessionCookieSecure() {
  return process.env.NODE_ENV === 'production';
}

function sessionCookieName() {
  return sessionCookieSecure() ? `__Host-${COOKIE_NAME}` : COOKIE_NAME;
}

// Fixed at load so Set-Cookie and clearCookie cannot drift if NODE_ENV is
// changed later in the same process.
const ACTIVE_COOKIE_NAME = sessionCookieName();

function sessionCookieClearOptions() {
  return {
    path: '/',
    httpOnly: true,
    secure: sessionCookieSecure(),
    sameSite: 'lax',
  };
}

function clearSessionCookie(res) {
  if (res && typeof res.clearCookie === 'function') {
    res.clearCookie(ACTIVE_COOKIE_NAME, sessionCookieClearOptions());
  }
}

module.exports = {
  COOKIE_NAME,
  ACTIVE_COOKIE_NAME,
  sessionCookieSecure,
  sessionCookieName,
  sessionCookieClearOptions,
  clearSessionCookie,
};
