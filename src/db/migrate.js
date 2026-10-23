// Numbered, one-way migrations. Version 000 is src/db/schema.sql (the baseline
// that already runs on the live database). Later versions run once, in order,
// inside a transaction, and are recorded in schema_migrations. A failure rolls
// that version back. The process can run them again safely.

const fs = require('fs');
const path = require('path');
const db = require('./index');
const { applyTenancy } = require('./tenancy');
const { applySignup } = require('./signup');
const { applyUrlMatchType } = require('./url-match-type');
const { applyAccessRequests } = require('./access-requests');
const { applyPortal } = require('./portal');
const { applyInstallCheck } = require('./install-check');
const { applySessions } = require('./sessions');
const { applyRateLimits } = require('./rate-limits');
const { applyFirstRun } = require('./first-run');
const { applyConclusion } = require('./conclusion');
const { applyChangeApplied } = require('./change-applied');
const { applyElementSelector } = require('./element-selector');
const { applyDemoTest } = require('./demo-test');
const { applyAuditBackfill } = require('./audit-backfill');
const { applyActiveSite } = require('./active-site');
const { applyPeopleState } = require('./people-state');
const { applyAccountInvites } = require('./account-invites');
const { applyGa4 } = require('./ga4');
const { applyActivation } = require('./activation');

const LOCK_KEY = 814021;

async function applyBaseline(client) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
}

const VERSIONS = [
  { version: '000', name: 'baseline', run: applyBaseline },
  { version: '001', name: 'tenancy', run: applyTenancy },
  { version: '002', name: 'signup', run: applySignup },
  { version: '003', name: 'url-match-type', run: applyUrlMatchType },
  // Access requests stay out of schema.sql. Version 000 is already recorded.
  { version: '004', name: 'access_requests', run: applyAccessRequests },
  // Portal snapshots and review requests stay out of schema.sql too.
  { version: '005', name: 'portal', run: applyPortal },
  // Install-check notes stay out of schema.sql too.
  { version: '006', name: 'install-check', run: applyInstallCheck },
  // Session lookup indexes stay out of schema.sql too.
  { version: '007', name: 'sessions', run: applySessions },
  // The rate-limit index stays out of schema.sql too.
  { version: '008', name: 'rate-limits', run: applyRateLimits },
  // First-run dismissal and the QA preview timestamp stay out of schema.sql too.
  { version: '009', name: 'first-run', run: applyFirstRun },
  // Conclusion PDFs and click-to-approve records stay out of schema.sql too.
  { version: '010', name: 'conclusion', run: applyConclusion },
  // Whether a view's element changes were on the page. Stays out of schema.sql.
  { version: '011', name: 'change-applied', run: applyChangeApplied },
  // Optional CSS selector. The test runs only when that element is on the page.
  // Stays out of schema.sql.
  { version: '012', name: 'element-selector', run: applyElementSelector },
  // Demo tests: test traffic only, a fixed sample, and no switch to live.
  // Stays out of schema.sql.
  { version: '013', name: 'demo-test', run: applyDemoTest },
  // Copy leftover test_traffic_audit rows into audit_log. The old table stays.
  // Stays out of schema.sql.
  { version: '014', name: 'audit-backfill', run: applyAuditBackfill },
  // The remembered setup site. Nullable, so existing accounts are left unset.
  // Stays out of schema.sql.
  { version: '015', name: 'active-site', run: applyActiveSite },
  // Suspended, archived and deleted marks, and removed memberships.
  // Nullable, so existing people stay active. Stays out of schema.sql.
  { version: '016', name: 'people-state', run: applyPeopleState },
  // Invites that add someone to an existing agency. The token is hashed.
  // Stays out of schema.sql.
  { version: '017', name: 'account-invites', run: applyAccountInvites },
  // Paid-plan flag and per-site GA4 measurement ID. Both default off.
  // Stays out of schema.sql.
  { version: '018', name: 'ga4', run: applyGa4 },
  // When the test starts. page_load is the default, so existing tests are
  // unchanged. The element start keeps its selector in activation_value.
  // Stays out of schema.sql.
  { version: '019', name: 'activation', run: applyActivation },
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
