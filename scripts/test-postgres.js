// Shared Postgres access for the database tests.
//
// Never reads DATABASE_URL. That variable is the app's own connection, and on
// a developer machine it might point at a hosted database. Tests use the local
// socket unless TEST_DATABASE_URL is set (CI). A failed connection skips when
// the socket is missing, and fails when TEST_DATABASE_URL is set, so CI cannot
// pass by silently skipping the isolation tests.

const { Client } = require('pg');

const NAME_RE = /^[a-z0-9_]+$/;

function usingTestDatabaseUrl() {
  return Boolean(String(process.env.TEST_DATABASE_URL || '').trim());
}

function adminUrl() {
  if (usingTestDatabaseUrl()) return String(process.env.TEST_DATABASE_URL).trim();
  return 'postgres://ubuntu@/postgres?host=/var/run/postgresql';
}

function databaseUrl(database) {
  assertName(database);
  if (!usingTestDatabaseUrl()) {
    return `postgres://ubuntu@/${database}?host=/var/run/postgresql`;
  }
  const url = new URL(String(process.env.TEST_DATABASE_URL).trim());
  url.pathname = '/' + database;
  return url.toString();
}

function assertName(database) {
  if (!NAME_RE.test(database)) throw new Error('unsafe database name');
}

async function connectAdmin() {
  const admin = new Client({ connectionString: adminUrl() });
  try {
    await admin.connect();
    return admin;
  } catch (err) {
    if (usingTestDatabaseUrl()) throw err;
    return null;
  }
}

async function createDatabase(admin, name) {
  assertName(name);
  await admin.query(`CREATE DATABASE ${name}`);
}

async function dropDatabase(name) {
  assertName(name);
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

module.exports = {
  usingTestDatabaseUrl,
  adminUrl,
  databaseUrl,
  connectAdmin,
  createDatabase,
  dropDatabase,
};
