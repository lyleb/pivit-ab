const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const {
  readR2Config,
  createR2Client,
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
  runLatestRestoreCheck,
} = require('../src/r2-backup');
const { dumpDatabase } = require('./backup');

const SECRET_URL = 'postgres://pivit:super-secret-password@db.internal:5432/pivit';
const ACCOUNT_ID = 'account-id-should-not-appear';
const ACCESS_KEY = 'access-key-should-not-appear';
const SECRET_KEY = 'secret-key-should-not-appear';
const SECRETS = [SECRET_URL, 'super-secret-password', ACCOUNT_ID, ACCESS_KEY, SECRET_KEY];

function r2Env(extra = {}) {
  return {
    DATABASE_URL: SECRET_URL,
    R2_ACCOUNT_ID: ACCOUNT_ID,
    R2_ACCESS_KEY_ID: ACCESS_KEY,
    R2_SECRET_ACCESS_KEY: SECRET_KEY,
    R2_BUCKET: 'pivitlab-backups',
    ...extra,
  };
}

function assertNoSecrets(text) {
  for (const secret of SECRETS) {
    assert.ok(!String(text).includes(secret), 'output contained a secret value');
  }
}

function mockS3(seed = {}) {
  const objects = new Map(Object.entries(seed).map(([key, value]) => [key, Buffer.from(value)]));
  const calls = [];
  return {
    objects,
    calls,
    async send(command) {
      calls.push(command);
      const input = command.input;
      if (command instanceof PutObjectCommand) {
        objects.set(input.Key, await readBody(input.Body));
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = input.Prefix || '';
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      if (command instanceof GetObjectCommand) {
        if (!objects.has(input.Key)) {
          const err = new Error('The specified key does not exist.');
          err.name = 'NoSuchKey';
          throw err;
        }
        return { Body: Readable.from(objects.get(input.Key)) };
      }
      if (command instanceof DeleteObjectsCommand) {
        for (const item of input.Delete.Objects) objects.delete(item.Key);
        return { Deleted: input.Delete.Objects };
      }
      throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    },
  };
}

function capture() {
  const lines = [];
  const write = (line) => lines.push(String(line));
  return { lines, write, text: () => lines.join('\n') };
}

function runScript(script, args, env) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: os.tmpdir(),
      NODE_ENV: 'test',
      ...env,
    },
    encoding: 'utf8',
  });
}

function testNamesAndRetention() {
  assert.strictEqual(
    backupObjectName(new Date('2026-01-02T03:04:59.000Z')),
    'pivitlab-20260102-0304.dump'
  );
  assert.strictEqual(shaObjectName('pivitlab-20260102-0304.dump'), 'pivitlab-20260102-0304.sha256');
  assert.strictEqual(backupStamp('pivitlab-20260231-0000.dump'), null);
  assert.strictEqual(backupStamp('notes.txt'), null);
  assert.strictEqual(
    selectLatestDumpKey([
      'pivitlab-20261012-0809.dump',
      'pivitlab-20261013-0809.sha256',
      'pivitlab-20261013-0809.dump',
      'pivitlab-20260231-0000.dump',
      'notes.txt',
    ]),
    'pivitlab-20261013-0809.dump'
  );

  const now = new Date('2026-10-13T08:09:00.000Z');
  const doomed = keysToPrune([
    'pivitlab-20260913-0808.dump',
    'pivitlab-20260913-0808.sha256',
    'pivitlab-20260913-0809.dump',
    'pivitlab-20260913-0809.sha256',
    'pivitlab-notes.txt',
    'notes.txt',
  ], { now, retentionDays: 30 });
  assert.deepStrictEqual(doomed.sort(), [
    'pivitlab-20260913-0808.dump',
    'pivitlab-20260913-0808.sha256',
  ]);

  const unset = readR2Config({});
  assert.strictEqual(unset.enabled, false);
  assert.deepStrictEqual(unset.missing, [
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET',
  ]);
  const partial = readR2Config({ R2_ACCOUNT_ID: '  ', R2_BUCKET: 'b' });
  assert.strictEqual(partial.enabled, false);
  assert.ok(partial.missing.includes('R2_ACCOUNT_ID'));
  assert.strictEqual(readR2Config(r2Env()).retentionDays, 30);
  assert.strictEqual(readR2Config(r2Env({ BACKUP_RETENTION_DAYS: '' })).retentionDays, 30);
  assert.strictEqual(readR2Config(r2Env({ BACKUP_RETENTION_DAYS: ' 7 ' })).retentionDays, 7);
  assert.ok(readR2Config(r2Env({ BACKUP_RETENTION_DAYS: '0' })).retentionError);
  assert.ok(readR2Config(r2Env({ BACKUP_RETENTION_DAYS: '30days' })).retentionError);

  const sidecar = shaSidecar('pivitlab-20261013-0809.dump', 'a'.repeat(64));
  assert.strictEqual(parseSha256Sidecar(sidecar), 'a'.repeat(64));
  assert.throws(() => parseSha256Sidecar('nope'), /64-character/);
}

async function testUploadPruneAndSecrets() {
  const now = new Date('2026-10-13T08:09:00.000Z');
  const client = mockS3({
    'pivitlab-20260913-0808.dump': 'old-dump',
    'pivitlab-20260913-0808.sha256': 'old-sha',
    'pivitlab-20260913-0809.dump': 'boundary-dump',
    'pivitlab-20260913-0809.sha256': 'boundary-sha',
    'pivitlab-notes.txt': 'leave-me',
    'notes.txt': 'not-ours',
  });
  const logs = capture();
  let dumpPath = null;
  const result = await runBackup({
    env: r2Env({ BACKUP_RETENTION_DAYS: '30' }),
    now,
    client,
    log: logs.write,
    error: logs.write,
    dump(url, file) {
      assert.strictEqual(url, SECRET_URL);
      dumpPath = file;
      assert.ok(file.endsWith(`${path.sep}pivitlab-20261013-0809.dump`));
      fs.writeFileSync(file, Buffer.from('custom-format'));
    },
  });
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.key, 'pivitlab-20261013-0809.dump');
  assert.strictEqual(result.bytes, Buffer.byteLength('custom-format'));
  const dump = client.objects.get(result.key);
  const expected = crypto.createHash('sha256').update(dump).digest('hex');
  assert.strictEqual(result.sha256, expected);
  assert.strictEqual(
    client.objects.get('pivitlab-20261013-0809.sha256').toString('utf8'),
    shaSidecar(result.key, expected)
  );
  assert.ok(!client.objects.has('pivitlab-20260913-0808.dump'));
  assert.ok(!client.objects.has('pivitlab-20260913-0808.sha256'));
  assert.strictEqual(client.objects.get('pivitlab-20260913-0809.dump').toString(), 'boundary-dump');
  assert.strictEqual(client.objects.get('pivitlab-notes.txt').toString(), 'leave-me');
  assert.strictEqual(client.objects.get('notes.txt').toString(), 'not-ours');
  assert.ok(dumpPath && !fs.existsSync(dumpPath));
  assert.deepStrictEqual(
    result.pruned.sort(),
    ['pivitlab-20260913-0808.dump', 'pivitlab-20260913-0808.sha256']
  );
  assertNoSecrets(logs.text());
  assert.match(logs.text(), /Uploaded pivitlab-20261013-0809.dump/);
  assert.match(logs.text(), /Pruned 2 object/);

  const puts = client.calls.filter((command) => command instanceof PutObjectCommand);
  assert.strictEqual(puts.length, 2);
  assert.strictEqual(puts[0].input.Bucket, 'pivitlab-backups');
  assert.strictEqual(puts[0].input.Key, 'pivitlab-20261013-0809.dump');
  assert.strictEqual(puts[1].input.Key, 'pivitlab-20261013-0809.sha256');
}

async function testSkipDoesNotTouchStorage() {
  const client = mockS3();
  client.send = async () => { throw new Error('S3 was called'); };
  const logs = capture();
  let dumped = false;
  const result = await runBackup({
    env: { DATABASE_URL: SECRET_URL, R2_BUCKET: 'only-one', BACKUP_DIR: '/tmp/unused' },
    client,
    log: logs.write,
    error: logs.write,
    dump() { dumped = true; },
  });
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(dumped, false);
  assert.match(logs.text(), /R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are not set/);
  assertNoSecrets(logs.text());
}

async function testFailurePaths() {
  const logs = capture();
  await assert.rejects(
    () => runBackup({
      env: r2Env({ BACKUP_RETENTION_DAYS: 'nope' }),
      log: logs.write,
      error: logs.write,
      dump() { throw new Error('should not dump'); },
    }),
    (err) => err.exitCode === 1 && /positive whole number/.test(err.message)
  );

  await assert.rejects(
    () => runBackup({
      env: r2Env({ DATABASE_URL: '  ' }),
      log: logs.write,
      error: logs.write,
      dump() { throw new Error('should not dump'); },
    }),
    (err) => err.exitCode === 1 && err.message === 'DATABASE_URL is required.'
  );

  const missingTool = capture();
  await assert.rejects(
    () => runBackup({
      env: r2Env(),
      client: mockS3(),
      log: missingTool.write,
      error: missingTool.write,
      dump() {
        const err = new Error('pg_dump is not installed.');
        err.code = 'ENOENT';
        err.exitCode = 127;
        throw err;
      },
    }),
    (err) => err.exitCode === 127
  );

  const leaked = capture();
  const client = mockS3();
  await assert.rejects(
    () => runBackup({
      env: r2Env(),
      client,
      log: leaked.write,
      error: leaked.write,
      dump() {
        throw new Error(`pg_dump failed for ${SECRET_URL} with ${SECRET_KEY} ${ACCESS_KEY} ${ACCOUNT_ID}`);
      },
    }),
    (err) => {
      assert.ok(err.logged);
      assert.ok(!err.message.includes('super-secret-password'));
      assert.ok(err.message.includes('[redacted]'));
      return true;
    }
  );
  assertNoSecrets(leaked.text());
  assert.strictEqual(client.objects.size, 0);

  let puts = 0;
  const partial = mockS3();
  const originalSend = partial.send.bind(partial);
  partial.send = async (command) => {
    if (command instanceof PutObjectCommand) {
      puts += 1;
      if (puts === 2) throw new Error(`sidecar failed ${SECRET_KEY}`);
    }
    return originalSend(command);
  };
  const sidecarLog = capture();
  await assert.rejects(
    () => runBackup({
      env: r2Env(),
      now: new Date('2026-10-13T08:09:00.000Z'),
      client: partial,
      log: sidecarLog.write,
      error: sidecarLog.write,
      dump(url, file) { fs.writeFileSync(file, Buffer.from('bytes')); },
    }),
    (err) => err.exitCode === 1 && !err.message.includes(SECRET_KEY)
  );
  assert.ok(!partial.objects.has('pivitlab-20261013-0809.dump'));
  assertNoSecrets(sidecarLog.text());
}

async function testPruneBatchesAndPaging() {
  const objects = {};
  for (let i = 0; i < 5; i += 1) {
    const key = `pivitlab-2020010${i + 1}-0000.dump`;
    objects[key] = 'x';
  }
  const client = mockS3(objects);
  const pruned = await pruneOldBackups({
    client,
    bucket: 'pivitlab-backups',
    retentionDays: 30,
    now: new Date('2026-10-13T08:09:00.000Z'),
    batchSize: 2,
  });
  assert.strictEqual(pruned.length, 5);
  assert.strictEqual(client.objects.size, 0);
  const deletes = client.calls.filter((command) => command instanceof DeleteObjectsCommand);
  assert.strictEqual(deletes.length, 3);
  assert.strictEqual(deletes[0].input.Delete.Objects.length, 2);
  assert.strictEqual(deletes[2].input.Delete.Objects.length, 1);

  let calls = 0;
  const paged = {
    async send(command) {
      assert.ok(command instanceof ListObjectsV2Command);
      assert.strictEqual(command.input.Prefix, 'pivitlab-');
      calls += 1;
      if (calls === 1) {
        return {
          Contents: [{ Key: 'pivitlab-20260101-0000.dump' }],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        };
      }
      assert.strictEqual(command.input.ContinuationToken, 'page-2');
      return { Contents: [{ Key: 'pivitlab-20260102-0000.dump' }], IsTruncated: false };
    },
  };
  const keys = await listAllKeys(paged, 'pivitlab-backups', 'pivitlab-');
  assert.deepStrictEqual(keys, ['pivitlab-20260101-0000.dump', 'pivitlab-20260102-0000.dump']);
}

async function testRestoreCheckUsesPgRestoreList() {
  const now = new Date('2026-10-13T08:10:00.000Z');
  const client = mockS3({
    'pivitlab-20261012-0809.dump': 'older',
    'pivitlab-20261012-0809.sha256': shaSidecar(
      'pivitlab-20261012-0809.dump',
      crypto.createHash('sha256').update('older').digest('hex')
    ),
  });
  await runBackup({
    env: r2Env(),
    now,
    client,
    log() {},
    error() {},
    dump(url, file) { fs.writeFileSync(file, Buffer.from('newest-dump')); },
  });

  let listed = null;
  const result = await runLatestRestoreCheck({
    client,
    bucket: 'pivitlab-backups',
    spawn(cmd, args) {
      listed = { cmd, args, exists: fs.existsSync(args[1]), bytes: fs.readFileSync(args[1]).toString() };
      return { status: 0, stdout: '; TOC Entries: 1\n' };
    },
  });
  assert.strictEqual(listed.cmd, 'pg_restore');
  assert.deepStrictEqual(listed.args.slice(0, 1), ['--list']);
  assert.strictEqual(listed.exists, true);
  assert.strictEqual(listed.bytes, 'newest-dump');
  assert.strictEqual(result.key, 'pivitlab-20261013-0810.dump');
  assert.match(result.listing, /TOC Entries/);
  assert.ok(!fs.existsSync(listed.args[1]));

  const mismatch = mockS3({
    'pivitlab-20261013-0810.dump': 'newest-dump',
    'pivitlab-20261013-0810.sha256': `${'b'.repeat(64)}  pivitlab-20261013-0810.dump\n`,
  });
  let spawned = false;
  await assert.rejects(
    () => runLatestRestoreCheck({
      client: mismatch,
      bucket: 'pivitlab-backups',
      spawn() { spawned = true; return { status: 0, stdout: '' }; },
    }),
    /sha256 mismatch/
  );
  assert.strictEqual(spawned, false);

  const noSha = mockS3({ 'pivitlab-20261013-0810.dump': 'newest-dump' });
  await assert.rejects(
    () => runLatestRestoreCheck({
      client: noSha,
      bucket: 'pivitlab-backups',
      spawn() { spawned = true; return { status: 0, stdout: '' }; },
    }),
    /Missing sha256 object pivitlab-20261013-0810.sha256/
  );
  assert.strictEqual(spawned, false);

  await assert.rejects(
    () => runLatestRestoreCheck({ client: mockS3(), bucket: 'pivitlab-backups' }),
    /No pivitlab backup objects found/
  );
}

function testDumpArgsAndRedaction() {
  const file = path.join(os.tmpdir(), `pivit-args-${Date.now()}.dump`);
  let seen = null;
  dumpDatabase(SECRET_URL, file, (cmd, args, options) => {
    seen = { cmd, args, env: options.env };
    return { status: 0 };
  });
  assert.strictEqual(seen.cmd, 'pg_dump');
  assert.deepStrictEqual(seen.args, ['-Fc', '--no-owner', '--no-acl', '--file', file]);
  assert.ok(!seen.args.some((arg) => String(arg).includes('super-secret-password')));
  assert.strictEqual(seen.env.PGHOST, 'db.internal');
  assert.strictEqual(seen.env.PGPORT, '5432');
  assert.strictEqual(seen.env.PGUSER, 'pivit');
  assert.strictEqual(seen.env.PGDATABASE, 'pivit');
  assert.strictEqual(seen.env.PGPASSWORD, 'super-secret-password');
  assert.strictEqual(seen.env.PGSSLMODE, undefined);

  const sslFile = path.join(os.tmpdir(), `pivit-ssl-${Date.now()}.dump`);
  dumpDatabase('postgresql://postgres:s3cret@postgres.railway.internal:7432/railway?sslmode=require', sslFile, (cmd, args, options) => {
    seen = { cmd, args, env: options.env };
    return { status: 0 };
  });
  assert.strictEqual(seen.env.PGHOST, 'postgres.railway.internal');
  assert.strictEqual(seen.env.PGPORT, '7432');
  assert.strictEqual(seen.env.PGUSER, 'postgres');
  assert.strictEqual(seen.env.PGDATABASE, 'railway');
  assert.strictEqual(seen.env.PGPASSWORD, 's3cret');
  assert.strictEqual(seen.env.PGSSLMODE, 'require');
  assert.ok(!seen.args.some((arg) => String(arg).includes('s3cret')));

  dumpDatabase('postgres://ubuntu@/pivit_socket?host=/var/run/postgresql', file, (cmd, args, options) => {
    seen = { env: options.env };
    return { status: 0 };
  });
  assert.strictEqual(seen.env.PGHOST, '/var/run/postgresql');
  assert.strictEqual(seen.env.PGUSER, 'ubuntu');
  assert.strictEqual(seen.env.PGDATABASE, 'pivit_socket');
  assert.strictEqual(seen.env.PGPASSWORD, undefined);

  dumpDatabase('postgres://user:p%40ss@localhost/db', file, (cmd, args, options) => {
    seen = { env: options.env };
    return { status: 0 };
  });
  assert.strictEqual(seen.env.PGPASSWORD, 'p@ss');

  assert.throws(
    () => dumpDatabase(SECRET_URL, file, () => ({
      status: 1,
      stderr: `connection to ${SECRET_URL} failed: password super-secret-password`,
      stdout: '',
    })),
    (err) => {
      assert.strictEqual(err.exitCode, 1);
      assertNoSecrets(err.message);
      assert.ok(err.message.includes('[redacted]'));
      return true;
    }
  );

  assert.throws(
    () => dumpDatabase(SECRET_URL, file, () => ({
      error: Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' }),
    })),
    (err) => err.code === 'ENOENT' && err.exitCode === 127 && /not installed/.test(err.message)
  );
}

function testSidecarMatchesSha256sum() {
  const sha256sum = spawnSync('sha256sum', ['--version'], { encoding: 'utf8' });
  if (sha256sum.status !== 0) {
    console.log('sha256sum check skipped: sha256sum is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivitlab-sha-'));
  const name = 'pivitlab-20261013-0809.dump';
  try {
    fs.writeFileSync(path.join(dir, name), Buffer.from('custom-format'));
    const hex = crypto.createHash('sha256').update('custom-format').digest('hex');
    fs.writeFileSync(path.join(dir, shaObjectName(name)), shaSidecar(name, hex));
    const check = spawnSync('sha256sum', ['-c', shaObjectName(name)], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testClientEndpoint() {
  const client = createR2Client({
    accountId: 'abc123example',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });
  const endpoint = await client.config.endpoint();
  assert.strictEqual(endpoint.protocol, 'https:');
  assert.strictEqual(endpoint.hostname, 'abc123example.r2.cloudflarestorage.com');
  client.destroy();
}

function testCli() {
  const backupDir = path.join(os.tmpdir(), `pivit-no-backup-${Date.now()}`);
  const skipped = runScript('backup.js', [], {
    DATABASE_URL: SECRET_URL,
    BACKUP_DIR: backupDir,
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_BUCKET: '',
  });
  assert.strictEqual(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /R2 backup skipped: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET are not set\./);
  assertNoSecrets(skipped.stdout + skipped.stderr);
  assert.strictEqual(fs.existsSync(backupDir), false);

  const bad = runScript('backup.js', [], {
    ...r2Env(),
    BACKUP_RETENTION_DAYS: '0',
  });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /BACKUP_RETENTION_DAYS must be a positive whole number of days\./);
  assertNoSecrets(bad.stdout + bad.stderr);

  const noDb = runScript('backup.js', [], {
    ...r2Env(),
    DATABASE_URL: '',
  });
  assert.strictEqual(noDb.status, 1);
  assert.match(noDb.stderr, /DATABASE_URL is required\./);
  assertNoSecrets(noDb.stdout + noDb.stderr);

  const local = runScript('backup.js', ['--local'], {
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_BUCKET: '',
  });
  assert.strictEqual(local.status, 1);
  assert.match(local.stderr, /DATABASE_URL is required\./);

  const check = runScript('restore-check.js', ['--latest'], {
    DATABASE_URL: SECRET_URL,
    R2_SECRET_ACCESS_KEY: SECRET_KEY,
  });
  assert.strictEqual(check.status, 1);
  assert.match(check.stderr, /R2 restore check needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_BUCKET\./);
  assertNoSecrets(check.stdout + check.stderr);
}

async function testRealDumpRoundTrip() {
  const pg = require('./test-postgres');
  const { pgDumpAvailable } = require('./backup');
  if (!pgDumpAvailable()) {
    console.log('r2 round-trip skipped: pg_dump is not installed');
    return;
  }
  const admin = await pg.connectAdmin();
  if (!admin) {
    console.log('r2 round-trip skipped: postgres not reachable');
    return;
  }
  const dbName = `pivit_r2_${Date.now().toString(36)}`;
  await pg.createDatabase(admin, dbName);
  await admin.end();
  const client = mockS3();
  try {
    const result = await runBackup({
      env: r2Env({ DATABASE_URL: pg.databaseUrl(dbName) }),
      now: new Date('2026-10-13T08:11:00.000Z'),
      client,
      log() {},
      error() {},
      dump: dumpDatabase,
    });
    assert.strictEqual(result.key, 'pivitlab-20261013-0811.dump');
    const check = await runLatestRestoreCheck({
      client,
      bucket: 'pivitlab-backups',
    });
    assert.strictEqual(check.key, result.key);
    assert.strictEqual(check.sha256, result.sha256);
    assert.match(check.listing, /TOC Entries:/);
    assert.match(check.listing, /^;/m);
  } finally {
    await pg.dropDatabase(dbName);
  }
}

async function main() {
  testNamesAndRetention();
  await testUploadPruneAndSecrets();
  await testSkipDoesNotTouchStorage();
  await testFailurePaths();
  await testPruneBatchesAndPaging();
  await testRestoreCheckUsesPgRestoreList();
  testDumpArgsAndRedaction();
  testSidecarMatchesSha256sum();
  await testClientEndpoint();
  testCli();
  await testRealDumpRoundTrip();
  console.log('r2 backup tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
