const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway/most hosts need SSL in production; disable for local dev.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Without this, an error on an idle connection (e.g. the host dropping it) is an
// unhandled 'error' event, which crashes the whole Node process — a likely cause
// of unexplained 502s on hosted Postgres. Log it instead; the pool recovers on its own.
pool.on('error', (err) => console.error('Unexpected error on idle Postgres client:', err));

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
