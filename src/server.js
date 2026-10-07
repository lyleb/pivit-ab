require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const sessionMiddleware = require('./session');

const { hostScopingMode } = require('./host-scope');
const { configuredAppOrigin, sendPublicConfig } = require('./app-origin');
const { hostHitMiddleware } = require('./host-hits');
const { PUBLIC_ERROR } = require('./public-error');
const experimentsRouter = require('./routes/experiments');
const eventsRouter = require('./routes/events');
const resultsRouter = require('./routes/results');
const { router: goalsRouter } = require('./routes/goals');
const authRouter = require('./routes/auth');
const clientsRouter = require('./routes/clients');
const clientRouter = require('./routes/client');
const editorRouter = require('./routes/editor');
const hostHitsRouter = require('./routes/host-hits');

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
// Count snippet and public API hits without delaying the response. /health
// is excluded inside the middleware. A counter failure is logged and ignored.
app.use(hostHitMiddleware);

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
app.use('/api/editor', editorRouter);
app.use('/api/host-hits', hostHitsRouter);

// Optional public origin for the admin UI. Null when APP_ORIGIN is unset or
// invalid, in which case the page keeps using location.origin. Does not
// redirect or change how /snippet, /api, or /health are served.
app.get('/api/config', sendPublicConfig);

app.get('/health', (req, res) => res.json({ ok: true }));

// Safety net: catch anything that slips past a route's own try/catch instead
// of returning a raw HTML stack trace (or, for a truly unhandled rejection,
// crashing the whole process — see the process-level handlers below).
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  const path = req.path || '';
  if (path.startsWith('/api/client') || path.startsWith('/api/auth')) {
    return res.status(500).json({ error: PUBLIC_ERROR });
  }
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

async function logHostScoping() {
  const configured = (process.env.HOST_SCOPING || '').trim();
  const mode = hostScopingMode();
  if (configured && configured.toLowerCase() !== mode) {
    console.warn(`HOST_SCOPING=${configured} is not recognised; using ${mode}.`);
  }
  console.log(`HOST_SCOPING=${mode}`);
  try {
    const { rows } = await db.query(
      `SELECT id, name, status
       FROM experiments
       WHERE status IN ('running', 'paused')
         AND cardinality(allowed_hosts) = 0
       ORDER BY created_at`
    );
    if (rows.length === 0) return;
    console.warn(`${rows.length} running or paused experiment(s) have no site domain:`);
    rows.forEach((row) => console.warn(`  ${row.status} ${row.id} ${row.name}`));
  } catch (err) {
    console.error('Could not list experiments with no site domain:', err.message);
  }
}

function logAppOrigin() {
  const raw = process.env.APP_ORIGIN;
  if (raw == null || String(raw).trim() === '') return;
  const origin = configuredAppOrigin();
  if (!origin) console.warn('APP_ORIGIN is set but is not a valid http(s) origin; ignoring it.');
  else console.log(`APP_ORIGIN=${origin}`);
}

const PORT = process.env.PORT || 3000;
logAppOrigin();
runMigrations().then(async () => {
  await logHostScoping();
  app.listen(PORT, () => console.log(`AB platform running on port ${PORT}`));
});
