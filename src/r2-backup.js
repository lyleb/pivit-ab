// Nightly logical backup of DATABASE_URL to Cloudflare R2.
//
// The web process does not load this module. A Railway cron service runs
// `node scripts/backup.js`, which exits as soon as the upload finishes.
// R2 is the S3-compatible API at https://<accountid>.r2.cloudflarestorage.com.
// The AWS SDK's default checksum mode is rejected by R2, so checksums are
// sent only when an operation requires them.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const R2_ENV_NAMES = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const DAY_MS = 24 * 60 * 60 * 1000;
const DELETE_BATCH = 1000;
const BACKUP_NAME = /^pivitlab-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.(dump|sha256)$/;

function readRetentionDays(raw) {
  if (raw == null || String(raw).trim() === '') return { days: 30 };
  const text = String(raw).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    return { error: 'BACKUP_RETENTION_DAYS must be a positive whole number of days.' };
  }
  return { days: Number(text) };
}

function readR2Config(env) {
  const missing = R2_ENV_NAMES.filter((name) => !String(env[name] || '').trim());
  if (missing.length) return { enabled: false, missing };
  const retention = readRetentionDays(env.BACKUP_RETENTION_DAYS);
  return {
    enabled: true,
    accountId: String(env.R2_ACCOUNT_ID).trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
    bucket: String(env.R2_BUCKET).trim(),
    retentionDays: retention.days,
    retentionError: retention.error || null,
  };
}

function createR2Client(config) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function databaseSecrets(databaseUrl) {
  const values = [];
  if (!databaseUrl) return values;
  values.push(String(databaseUrl));
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.password) {
      values.push(parsed.password);
      values.push(decodeURIComponent(parsed.password));
    }
  } catch (err) {
    // The raw URL is still redacted when it shows up in a client error.
  }
  return values;
}

function secretsFromEnv(env) {
  return [
    ...databaseSecrets(env.DATABASE_URL),
    env.R2_ACCESS_KEY_ID,
    env.R2_SECRET_ACCESS_KEY,
    env.R2_ACCOUNT_ID,
  ];
}

function redactSecrets(text, secrets) {
  let out = String(text == null ? '' : text);
  const values = [];
  for (const secret of secrets || []) {
    if (secret == null) continue;
    const value = String(secret);
    if (value.length < 4) continue;
    values.push(value);
  }
  values.sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (!out.includes(value)) continue;
    out = out.split(value).join('[redacted]');
  }
  return out;
}

function backupObjectName(date) {
  const stamp = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(stamp.getTime())) throw new Error('backup time is invalid');
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}`;
  const hm = `${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}`;
  return `pivitlab-${ymd}-${hm}.dump`;
}

function shaObjectName(dumpKey) {
  if (!String(dumpKey).endsWith('.dump')) throw new Error('backup object name must end in .dump');
  return `${dumpKey.slice(0, -'.dump'.length)}.sha256`;
}

function shaSidecar(dumpKey, hex) {
  return `${hex}  ${dumpKey}\n`;
}

function backupStamp(key) {
  const match = BACKUP_NAME.exec(String(key));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) return null;
  return date;
}

function keysToPrune(keys, { now, retentionDays }) {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const doomed = [];
  for (const key of keys) {
    const stamp = backupStamp(key);
    if (!stamp) continue;
    if (stamp.getTime() < cutoff) doomed.push(key);
  }
  return doomed;
}

function selectLatestDumpKey(keys) {
  const dumps = [];
  for (const key of keys) {
    if (!String(key).endsWith('.dump')) continue;
    if (!backupStamp(key)) continue;
    dumps.push(key);
  }
  dumps.sort();
  return dumps.length ? dumps[dumps.length - 1] : null;
}

function parseSha256Sidecar(text) {
  const line = String(text).trim().split(/\r?\n/).find((row) => row.trim()) || '';
  const match = /^([a-f0-9]{64})(?:\s+.*)?$/i.exec(line.trim());
  if (!match) {
    const err = new Error('sha256 sidecar is not a 64-character hex digest');
    err.exitCode = 1;
    throw err;
  }
  return match[1].toLowerCase();
}

function readBody(body) {
  if (body == null) return Promise.resolve(Buffer.alloc(0));
  if (Buffer.isBuffer(body)) return Promise.resolve(body);
  if (typeof body === 'string') return Promise.resolve(Buffer.from(body));
  if (body instanceof Uint8Array) return Promise.resolve(Buffer.from(body));
  if (typeof body.transformToByteArray === 'function') {
    return body.transformToByteArray().then((bytes) => Buffer.from(bytes));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    body.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    body.on('end', () => resolve(Buffer.concat(chunks)));
    body.on('error', reject);
  });
}

async function listAllKeys(client, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const item of page.Contents || []) {
      if (item.Key) keys.push(item.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteKeys(client, bucket, keys, batchSize = DELETE_BATCH) {
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: batch.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));
  }
}

async function pruneOldBackups({ client, bucket, retentionDays, now, batchSize }) {
  const keys = await listAllKeys(client, bucket, 'pivitlab-');
  const doomed = keysToPrune(keys, { now, retentionDays });
  if (doomed.length) await deleteKeys(client, bucket, doomed, batchSize);
  return doomed;
}

function skippedMessage(missing) {
  const verb = missing.length === 1 ? 'is' : 'are';
  return `R2 backup skipped: ${missing.join(', ')} ${verb} not set.`;
}

function fail(message, exitCode, error) {
  const err = new Error(message);
  err.exitCode = exitCode;
  err.logged = true;
  if (error) error(message);
  return err;
}

function defaultDump(databaseUrl, file) {
  return require('../scripts/backup').dumpDatabase(databaseUrl, file);
}

async function runBackup({
  env = process.env,
  now = new Date(),
  client,
  dump = defaultDump,
  log = console.log,
  error = console.error,
} = {}) {
  const config = readR2Config(env);
  if (!config.enabled) {
    log(skippedMessage(config.missing));
    return { skipped: true, missing: config.missing };
  }
  if (config.retentionError) throw fail(config.retentionError, 1, error);
  if (!String(env.DATABASE_URL || '').trim()) throw fail('DATABASE_URL is required.', 1, error);

  const s3 = client || createR2Client(config);
  const key = backupObjectName(now);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivitlab-backup-'));
  const file = path.join(dir, key);
  try {
    dump(env.DATABASE_URL, file);
    const body = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const shaKey = shaObjectName(key);
    await s3.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
    }));
    try {
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: shaKey,
        Body: shaSidecar(key, sha256),
        ContentType: 'text/plain; charset=utf-8',
      }));
    } catch (err) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: { Objects: [{ Key: key }], Quiet: true },
      })).catch(() => {});
      throw err;
    }
    const pruned = await pruneOldBackups({
      client: s3,
      bucket: config.bucket,
      retentionDays: config.retentionDays,
      now,
    });
    log(`Uploaded ${key} (${body.length} bytes, sha256 ${sha256}).`);
    log(`Pruned ${pruned.length} object(s) older than ${config.retentionDays} day(s).`);
    return { skipped: false, key, sha256, bytes: body.length, pruned };
  } catch (err) {
    if (err.logged) throw err;
    const clean = fail(
      redactSecrets(err.message || 'Backup failed.', secretsFromEnv(env)),
      err.exitCode || (err.code === 'ENOENT' ? 127 : (err.status || 1)),
      error
    );
    throw clean;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function listDumpArchive(file, spawn = spawnSync) {
  const result = spawn('pg_restore', ['--list', file], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    const err = new Error('pg_restore is not installed.');
    err.code = 'ENOENT';
    err.exitCode = 127;
    throw err;
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error((result.stderr || result.stdout || 'pg_restore --list failed').trim());
    err.exitCode = result.status || 1;
    throw err;
  }
  return result.stdout || '';
}

async function runLatestRestoreCheck({ client, bucket, spawn } = {}) {
  const keys = await listAllKeys(client, bucket, 'pivitlab-');
  const key = selectLatestDumpKey(keys);
  if (!key) {
    const err = new Error('No pivitlab backup objects found.');
    err.exitCode = 1;
    throw err;
  }
  const dumpRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const dumpBytes = await readBody(dumpRes.Body);
  const shaKey = shaObjectName(key);
  let sidecarBytes;
  try {
    const shaRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: shaKey }));
    sidecarBytes = await readBody(shaRes.Body);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      const missing = new Error(`Missing sha256 object ${shaKey}.`);
      missing.exitCode = 1;
      throw missing;
    }
    throw err;
  }
  const expected = parseSha256Sidecar(sidecarBytes.toString('utf8'));
  const actual = crypto.createHash('sha256').update(dumpBytes).digest('hex');
  if (actual !== expected) {
    const mismatch = new Error(`sha256 mismatch for ${key}.`);
    mismatch.exitCode = 1;
    throw mismatch;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivitlab-restore-'));
  const file = path.join(dir, key);
  try {
    fs.writeFileSync(file, dumpBytes, { mode: 0o600 });
    const listing = listDumpArchive(file, spawn);
    return { key, sha256: actual, listing };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  R2_ENV_NAMES,
  readR2Config,
  createR2Client,
  databaseSecrets,
  secretsFromEnv,
  redactSecrets,
  backupObjectName,
  shaObjectName,
  shaSidecar,
  backupStamp,
  keysToPrune,
  selectLatestDumpKey,
  parseSha256Sidecar,
  readBody,
  listAllKeys,
  pruneOldBackups,
  runBackup,
  listDumpArchive,
  runLatestRestoreCheck,
};
