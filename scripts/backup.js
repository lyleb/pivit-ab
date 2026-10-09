// Offline backup of the app database. The web process does not run this, and
// it does not need pg_dump installed in the image that serves pivitlab.
// Hosting Malarky owns the nightly copy that lives off the host. Run this
// yourself before a migration deploy, from a machine that can reach Postgres.
//
//   DATABASE_URL=postgres://… node scripts/backup.js
//   BACKUP_DIR=/var/backups/pivitlab node scripts/backup.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function dumpDatabase(databaseUrl, file) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const result = spawnSync('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--file', file,
    databaseUrl,
  ], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    const err = new Error('pg_dump is not installed. Install the Postgres client tools on the machine that takes the backup. The app does not need pg_dump to boot.');
    err.code = 'ENOENT';
    throw err;
  }
  if (result.status !== 0) {
    const err = new Error((result.stderr || result.stdout || 'pg_dump failed').trim());
    err.status = result.status;
    throw err;
  }
  return file;
}

function pgDumpAvailable() {
  const result = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function main() {
  require('dotenv').config();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const dir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `pivitlab-${stamp}.dump`);
  try {
    dumpDatabase(databaseUrl, file);
  } catch (err) {
    console.error(err.message);
    process.exit(err.code === 'ENOENT' ? 127 : (err.status || 1));
  }
  console.log(file);
}

if (require.main === module) main();

module.exports = { dumpDatabase, pgDumpAvailable };
