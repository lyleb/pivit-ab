const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const { getSessionSecret } = require('./session-secret');
const {
  ACTIVE_COOKIE_NAME,
  sessionCookieSecure,
} = require('./session-cookie');

// In production a missing or short SESSION_SECRET refuses to boot (see
// src/session-secret.js). Outside production a dev-only fallback is used and
// a warning is logged. The same secret signs edit and preview tokens.
const secret = getSessionSecret();

// Sessions are stored in Postgres (not memory), so logging in survives a Railway
// redeploy — a plain in-memory session store would log everyone out on every
// deploy, which given how often this app gets redeployed would be constant friction.
// Migration 007 creates the table. createTableIfMissing stays on so a database
// that has not applied 007 yet can still sign in; 007 itself only adds indexes
// once the table exists.
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
  name: ACTIVE_COOKIE_NAME,
  cookie: {
    httpOnly: true,
    secure: sessionCookieSecure(), // HTTPS-only cookie in production; plain HTTP locally
    sameSite: 'lax', // sent on the dashboard's own same-site requests, but NOT on cross-site requests from client sites running the snippet — so a site running the tracking snippet can never piggyback the owner's session cookie
    path: '/',
    // Sign-in replaces this. Customers get 30 days of idle time, capped at
    // 90 days from sign-in. A superadmin session, including the emergency
    // password, gets 12 hours and is not renewed.
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
