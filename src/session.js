const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const { getSessionSecret } = require('./session-secret');

// In production a missing or short SESSION_SECRET refuses to boot (see
// src/session-secret.js). Outside production a dev-only fallback is used and
// a warning is logged. The same secret signs edit and preview tokens.
const secret = getSessionSecret();

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
    // Sign-in replaces this. Customers get 30 days (renewed while active) and
    // a superadmin session, including the emergency password, gets 12 hours.
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
