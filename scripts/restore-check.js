// Restore a custom-format dump into a scratch database and compare row counts
// with the source. Drops the scratch database before it returns. Does not
// write to the source database.
//
//   DATABASE_URL=postgres://… node scripts/restore-check.js /path/to/pivitlab.dump

const { spawnSync } = require('child_process');
const { Client } = require('pg');

const COUNT_SQL = `
  SELECT
    (SELECT COUNT(*)::int FROM experiments) AS experiments,
    (SELECT COUNT(*)::int FROM variants) AS variants,
    (SELECT COUNT(*)::int FROM events) AS events,
    (SELECT COUNT(*)::int FROM clients) AS clients,
    (SELECT COUNT(*)::int FROM events WHERE is_test) AS test_events,
    (SELECT COUNT(*)::int FROM events WHERE excluded_at IS NOT NULL) AS excluded_events
`;

function assertName(name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unsafe database name');
}

function databaseUrlFor(adminUrl, database) {
  assertName(database);
  // The local test socket URL is not a normal host URL. Keep its query string
  // and only swap the database name.
  if (/host=(%2F|\/)var(%2F|\/)run(%2F|\/)postgresql/i.test(adminUrl)) {
    return `postgres://ubuntu@/${database}?host=/var/run/postgresql`;
  }
  const url = new URL(adminUrl);
  url.pathname = '/' + database;
  return url.toString();
}

async function tableCounts(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(COUNT_SQL);
    return rows[0];
  } finally {
    await client.end();
  }
}

function restoreDump(connectionString, dumpFile) {
  const result = spawnSync('pg_restore', [
    '--no-owner',
    '--no-acl',
    '--dbname', connectionString,
    dumpFile,
  ], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    const err = new Error('pg_restore is not installed.');
    err.code = 'ENOENT';
    throw err;
  }
  // pg_restore exits 1 when it only printed warnings. The count check decides
  // whether the restore is actually usable.
  if (result.status !== 0 && result.status !== 1) {
    const err = new Error((result.stderr || result.stdout || 'pg_restore failed').trim());
    err.status = result.status;
    throw err;
  }
  return result.stderr || '';
}

async function restoreAndCompare({ dumpFile, sourceUrl, adminUrl, scratchName }) {
  assertName(scratchName);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const scratchUrl = databaseUrlFor(adminUrl, scratchName);
  try {
    await admin.query(`CREATE DATABASE ${scratchName}`);
    restoreDump(scratchUrl, dumpFile);
    const source = await tableCounts(sourceUrl);
    const restored = await tableCounts(scratchUrl);
    const lines = [];
    for (const key of Object.keys(source)) {
      if (Number(source[key]) !== Number(restored[key])) {
        lines.push(`${key}: source ${source[key]}, restored ${restored[key]}`);
      }
    }
    return { ok: lines.length === 0, lines, source, restored };
  } finally {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [scratchName]
    ).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => {});
    await admin.end();
  }
}

async function main() {
  require('dotenv').config();
  const dumpFile = process.argv[2];
  const sourceUrl = process.env.DATABASE_URL;
  if (!dumpFile || !sourceUrl) {
    console.error('Usage: DATABASE_URL=postgres://… node scripts/restore-check.js <dump-file>');
    process.exit(1);
  }
  const scratchName = 'pivit_restore_' + Date.now().toString(36);
  const result = await restoreAndCompare({
    dumpFile,
    sourceUrl,
    adminUrl: sourceUrl,
    scratchName,
  });
  if (!result.ok) {
    console.error('Restore check failed.');
    result.lines.forEach((line) => console.error(line));
    process.exit(1);
  }
  console.log(
    `Restore check passed: ${result.source.experiments} experiments, ` +
    `${result.source.variants} variants, ${result.source.events} events, ` +
    `${result.source.clients} client logins.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { restoreAndCompare, restoreDump, tableCounts };
