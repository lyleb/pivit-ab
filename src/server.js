require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const sessionMiddleware = require('./session');

const experimentsRouter = require('./routes/experiments');
const eventsRouter = require('./routes/events');
const resultsRouter = require('./routes/results');
const { router: goalsRouter } = require('./routes/goals');
const authRouter = require('./routes/auth');
const clientsRouter = require('./routes/clients');
const clientRouter = require('./routes/client');

const app = express();
// Railway (like most hosts) sits behind a reverse proxy. Without this, Express
// never sees the connection as "secure" (it only sees the proxy's internal HTTP
// hop), so a cookie flagged secure: true would silently never get set — and
// req.ip (used for the login throttle) would show the proxy's IP for everyone.
app.set('trust proxy', 1);

// origin: true reflects whatever site is actually calling (rather than a fixed
// wildcard '*'), and credentials: true allows it — both are required together
// because navigator.sendBeacon (used to log view/conversion events) always sends
// requests in credentialed mode, and CORS forbids pairing that with a wildcard
// Access-Control-Allow-Origin. This still permits the snippet on ANY client site,
// it's just no longer a literal '*' in the response header.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(sessionMiddleware);

// Serve the built snippet + the admin dashboard as static files
app.use('/snippet', express.static(path.join(__dirname, '../snippet')));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth', authRouter);
app.use('/api/experiments', experimentsRouter);
app.use('/api/event', eventsRouter);
app.use('/api/results', resultsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/client', clientRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

// Safety net: catch anything that slips past a route's own try/catch instead
// of returning a raw HTML stack trace (or, for a truly unhandled rejection,
// crashing the whole process — see the process-level handlers below).
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  res.status(500).json({ error: 'internal error', detail: err.message });
});

// Last-resort safety net. Route handlers should all have their own try/catch,
// but if something still throws outside of that, log it rather than let Node's
// default behaviour (crashing the process — the cause of the 502s we saw) kick in.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// Auto-migrate on startup: schema.sql uses CREATE TABLE/EXTENSION IF NOT EXISTS,
// so this is safe to run every time the server boots — no separate CLI step needed.
// This means a pure browser-based deploy (no terminal) works end to end.
async function runMigrations() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    await db.query(sql);
    console.log('Database schema is up to date.');
  } catch (err) {
    console.error('Migration on startup failed:', err);
  }
}

const PORT = process.env.PORT || 3000;
runMigrations().then(() => {
  app.listen(PORT, () => console.log(`AB platform running on port ${PORT}`));
});
