const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');
const { pool } = require('./db');

// express-session throws at construction time if secret is missing, which would
// crash the whole server at boot — the same "fail loudly instead of silently
// running unprotected" instinct as elsewhere in this app, but here it can't be
// deferred to per-request time. Falling back to a random secret keeps the server
// up (consistent with everything else here preferring availability), at the cost
// of logging everyone out on every restart until SESSION_SECRET is actually set.
let secret = process.env.SESSION_SECRET;
if (!secret) {
  console.error('[session] SESSION_SECRET is not set — using a random one-time secret. Sessions will not survive a server restart until you set SESSION_SECRET.');
  secret = crypto.randomBytes(32).toString('hex');
}

// Sessions are stored in Postgres (not memory), so logging in survives a Railway
// redeploy — a plain in-memory session store would log everyone out on every
// deploy, which given how often this app gets redeployed would be constant friction.
// createTableIfMissing matches the same auto-migration pattern as schema.sql: the
// "session" table appears automatically on first run, no manual step needed.
const store = new pgSession({
  pool,
  tableName: 'session',
  createTableIfMissing: true,
});

module.exports = session({
  store,
  secret,
  resave: false,
  saveUninitialized: false,
  name: 'pivit.sid',
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // matches the pg SSL pattern — HTTPS-only cookie in production, plain http locally
    sameSite: 'lax', // sent on the dashboard's own same-site requests, but NOT on cross-site requests from client sites running the snippet — so a site running the tracking snippet can never piggyback the owner's session cookie
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — long enough to not be constantly re-logging in, short enough to not be forever
  },
});
