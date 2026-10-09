// Numbered, one-way migrations. Version 000 is src/db/schema.sql (the baseline
// that already runs on the live database). Later versions run once, in order,
// inside a transaction, and are recorded in schema_migrations. A failure rolls
// that version back. The process can run them again safely.

const fs = require('fs');
const path = require('path');
const db = require('./index');
const { applyTenancy } = require('./tenancy');
const { applySignup } = require('./signup');

const LOCK_KEY = 814021;

async function applyBaseline(client) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
}

const VERSIONS = [
  { version: '000', name: 'baseline', run: applyBaseline },
  { version: '001', name: 'tenancy', run: applyTenancy },
  { version: '002', name: 'signup', run: applySignup },
];

async function ensureMigrationsTable(queryable) {
  await queryable.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(queryable) {
  const { rows } = await queryable.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  return rows.map((row) => row.version);
}

// Applies any missing versions. Returns the versions applied on this call.
async function migrate() {
  await ensureMigrationsTable(db);
  const applied = [];
  for (const step of VERSIONS) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const done = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [step.version]
      );
      if (done.rows.length === 0) {
        await step.run(client);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [step.version]
        );
        applied.push(step.version);
      }
      await client.query('COMMIT');
      if (applied[applied.length - 1] === step.version) {
        console.log(`Applied migration ${step.version} (${step.name}).`);
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already failing */ }
      const wrapped = new Error(
        `Migration ${step.version} (${step.name}) rolled back: ${err.message}`
      );
      wrapped.cause = err;
      throw wrapped;
    } finally {
      client.release();
    }
  }
  return applied;
}

module.exports = {
  VERSIONS,
  migrate,
  appliedVersions,
  ensureMigrationsTable,
};
