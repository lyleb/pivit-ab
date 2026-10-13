// Nightly backup of the app database, run by a Railway cron service:
//
//   node scripts/backup.js
//
// With R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET
// set, this runs `pg_dump -Fc` of DATABASE_URL, uploads
// pivitlab-YYYYMMDD-HHMM.dump plus a sha256 sidecar to Cloudflare R2, and
// deletes objects older than BACKUP_RETENTION_DAYS (default 30). When those
// R2 variables are missing it logs that and exits 0. It does not start the
// web server, and the web image does not need pg_dump.
//
// A one-off local dump, for a machine that can already reach Postgres:
//
//   DATABASE_URL=postgres://… BACKUP_DIR=/secure/off-host node scripts/backup.js --local

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// libpq reads the connection from the child environment. The URL is not an
// argument, so a process listing or a pg_dump error does not have to repeat it.
// The local test URL is `postgres://user@/dbname?host=/var/run/postgresql`,
// which the WHATWG parser rejects, so that shape is read separately.
function libpqEnv(databaseUrl, baseEnv = process.env) {
  const env = { ...baseEnv };
  let parsed = null;
  try {
    parsed = new URL(databaseUrl);
  } catch (err) {
    parsed = null;
  }
  if (!parsed) {
    const socket = /^postgres(?:ql)?:\/\/([^:/?#@]*)(?::([^@]*))?@\/([^?]+)\?(?:[^#]*&)?host=([^&#]+)/.exec(databaseUrl);
    if (!socket) {
      const err = new Error('DATABASE_URL is not a postgres connection URL.');
      err.exitCode = 1;
      throw err;
    }
    env.PGUSER = decodeURIComponent(socket[1]);
    env.PGHOST = decodeURIComponent(socket[4]);
    env.PGPORT = '5432';
    env.PGDATABASE = decodeURIComponent(socket[3]);
    if (socket[2]) env.PGPASSWORD = decodeURIComponent(socket[2]);
    else delete env.PGPASSWORD;
    delete env.PGSSLMODE;
    return env;
  }
  const socketHost = parsed.searchParams.get('host');
  env.PGHOST = socketHost || parsed.hostname;
  env.PGPORT = parsed.port || '5432';
  env.PGUSER = decodeURIComponent(parsed.username || '');
  env.PGDATABASE = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  else delete env.PGPASSWORD;
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  else delete env.PGSSLMODE;
  return env;
}

function dumpDatabase(databaseUrl, file, spawn = spawnSync) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-Fc', '--no-owner', '--no-acl', '--file', file];
  const result = spawn('pg_dump', args, { encoding: 'utf8', env: libpqEnv(databaseUrl) });
  if (result.error && result.error.code === 'ENOENT') {
    const err = new Error('pg_dump is not installed. Install the Postgres client tools on the machine that takes the backup. The app does not need pg_dump to boot.');
    err.code = 'ENOENT';
    err.exitCode = 127;
    throw err;
  }
  if (!result.error && result.status !== 0) {
    const { redactSecrets, databaseSecrets } = require('../src/r2-backup');
    const err = new Error(redactSecrets(
      (result.stderr || result.stdout || 'pg_dump failed').trim(),
      databaseSecrets(databaseUrl)
    ));
    err.status = result.status;
    err.exitCode = result.status || 1;
    throw err;
  }
  if (result.error) throw result.error;
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    // The caller still has the dump. The temp directory is already private.
  }
  return file;
}

function pgDumpAvailable() {
  const result = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function runLocalBackup() {
  const { redactSecrets, secretsFromEnv } = require('../src/r2-backup');
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
    console.error(redactSecrets(err.message, secretsFromEnv(process.env)));
    process.exit(err.exitCode || (err.code === 'ENOENT' ? 127 : (err.status || 1)));
  }
  console.log(file);
}

async function main() {
  require('dotenv').config();
  if (process.argv[2] === '--local') {
    runLocalBackup();
    return;
  }
  const { runBackup, secretsFromEnv, redactSecrets } = require('../src/r2-backup');
  try {
    await runBackup();
  } catch (err) {
    if (!err.logged) {
      console.error(redactSecrets(err.message || 'Backup failed.', secretsFromEnv(process.env)));
    }
    process.exit(err.exitCode || 1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || 'Backup failed.');
    process.exit(err.exitCode || 1);
  });
}

module.exports = { dumpDatabase, pgDumpAvailable, libpqEnv };
