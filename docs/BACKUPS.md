# Backups

Railway Hobby Postgres has no backup you can restore from. The nightly job dumps the database with `pg_dump -Fc` and uploads it to Cloudflare R2, which speaks the S3 API. The web process does not take backups, and the image that serves pivitlab does not need `pg_dump`. A missing client tool must not stop the site from booting.

Use a second Railway service from this same repo, with a cron schedule and the start command `node scripts/backup.js`. That service starts, uploads one dump, and exits. An in-app timer would put `pg_dump` in the site image and would run the dump inside the process that serves traffic. The status snapshot timer stays in the web process because it only writes rows the app already owns.

## Railway setup

1. In the Cloudflare dashboard, create an R2 bucket. Create an API token with Object Read & Write on that bucket only. Copy the Access Key ID, the Secret Access Key, and the account ID. The S3 endpoint is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. The secret is shown once.

2. In the Railway project, click **+ New** → **GitHub Repo** and select this repo. Name the service `pivitlab-backup`. Do not give it a public domain.

3. On `pivitlab-backup`, open **Settings → Deploy** and set:
   - Custom Start Command: `node scripts/backup.js`
   - Cron Schedule: `0 3 * * *` (03:00 UTC every night)
   - Restart Policy: **Never**

   Railway evaluates cron in UTC. The shortest interval is 5 minutes. If a run is still going when the next tick fires, Railway skips the new run. The process has to exit, which this command does.

4. On the same service, set the builder to **Dockerfile** and the Dockerfile path to `Dockerfile.backup`. The service variable for that path is `RAILWAY_DOCKERFILE_PATH=Dockerfile.backup`. If the build log says Railpack, the builder is still the web service's builder: switch this service to Dockerfile and redeploy. Leave the web service on Railpack. Do not set this variable there.

5. Open **Variables** on `pivitlab-backup` and set the names below. Add `DATABASE_URL` with **Add Reference** and choose the Postgres service's `DATABASE_URL` (the picker writes `${{Postgres.DATABASE_URL}}`, using the Postgres service's real name). That reference uses Railway's private network, so the dump is not billed as database egress.

6. Deploy `pivitlab-backup`. You can deploy it before the R2 variables exist: a run with those variables unset logs the missing names and exits 0, and uploads nothing. After the variables are set, redeploy or wait for 03:00 UTC. The log line `Uploaded pivitlab-YYYYMMDD-HHMM.dump` is the success line. It includes the byte size and the sha256 hex. It does not include `DATABASE_URL`, the access key, the secret, or the account id.

7. In the R2 bucket, confirm the pair `pivitlab-YYYYMMDD-HHMM.dump` and `pivitlab-YYYYMMDD-HHMM.sha256`. Then run the restore check in the section below.

Do not set the R2 variables or `RAILWAY_DOCKERFILE_PATH` on the web service. Its start command stays `npm start`.

## Environment variables

Set these on the backup service:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Reference to the Postgres service's `DATABASE_URL`. |
| `R2_ACCOUNT_ID` | yes | Cloudflare account id. Used only to build the R2 endpoint. |
| `R2_ACCESS_KEY_ID` | yes | R2 S3 access key id. |
| `R2_SECRET_ACCESS_KEY` | yes | R2 S3 secret. |
| `R2_BUCKET` | yes | Bucket name. |
| `BACKUP_RETENTION_DAYS` | no | Days to keep. Unset means 30. A non-integer or a value below 1 fails the run. |
| `PG_MAJOR` | yes, on this service | Postgres server major version. See below. Passed as a Docker build arg. |
| `RAILWAY_DOCKERFILE_PATH` | yes, on this service | `Dockerfile.backup` |

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` are the backup's own variables. If any one of them is unset or blank, the backup logs the missing names and exits 0.

## Make pg_dump match the server

`pg_dump` has to be the same major version as the Postgres server, or newer. An older client stops with `server version mismatch` and uploads nothing.

1. Open a shell on the **Postgres** service and run `postgres --version`. The first number is the major version (`postgres (PostgreSQL) 16.9` → `16`).
2. On **pivitlab-backup** only, set `PG_MAJOR` to that number (`14`, `15`, `16`, `17`, or `18`). `Dockerfile.backup` installs `postgresql-client-<PG_MAJOR>` from the PGDG apt repo. The default, when `PG_MAJOR` is unset, is 16.
3. Redeploy `pivitlab-backup`. The build log prints `pg_dump (PostgreSQL) <major>`. If a later run reports a server version mismatch, the server was upgraded: set `PG_MAJOR` to the new major version and redeploy.

The web service does not build this Dockerfile, so it still boots when `pg_dump` is absent.

## What a run stores

The object name is `pivitlab-YYYYMMDD-HHMM.dump`, UTC, from `pg_dump -Fc --no-owner --no-acl`. The sidecar `pivitlab-YYYYMMDD-HHMM.sha256` is the `sha256sum` line for that file (`<64 hex>  <dump name>`). Objects whose timestamp is older than `BACKUP_RETENTION_DAYS` are deleted, dump and sidecar together. Anything else in the bucket is left alone. A second run in the same UTC minute overwrites that minute's pair.

## Restore

Check the latest object without writing to a database. From a machine that has the same major `pg_restore` and the four R2 variables:

```bash
node scripts/restore-check.js --latest
```

That downloads the newest `pivitlab-*.dump`, checks it against the sidecar, runs `pg_restore --list`, prints the table of contents, and deletes its temp file.

To put the data back, download both objects from the R2 dashboard (or any S3 client pointed at `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`) into one directory, keeping the object names. Then:

```bash
sha256sum -c pivitlab-YYYYMMDD-HHMM.sha256
pg_restore --list pivitlab-YYYYMMDD-HHMM.dump
pg_restore --no-owner --no-acl --exit-on-error --dbname "$NEW_DATABASE_URL" pivitlab-YYYYMMDD-HHMM.dump
```

Restore into a new empty database. `pg_restore` exits 1 when it only printed warnings. Compare row counts before you point the app at the restored database.

A local custom-format file can also be loaded into a scratch database on the same server. This compares experiment, variant, event, and client counts with the source, then drops the scratch database. It does not write to the source database's tables. The role in `DATABASE_URL` needs permission to create a database.

```bash
DATABASE_URL='postgres://…' node scripts/restore-check.js /path/to/pivitlab-YYYYMMDD-HHMM.dump
```

## One-off local dump

Before a migration, from a machine that can reach Postgres and has a matching `pg_dump`:

```bash
DATABASE_URL='postgres://…' BACKUP_DIR=/secure/off-host node scripts/backup.js --local
```

`--local` writes a custom-format file under `BACKUP_DIR` (or `./backups`) and does not upload. The cron command does not pass `--local`. Do not commit dump files.

Logs from both commands include object names, sizes, and sha256 hex digests. They do not include `DATABASE_URL`, passwords, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, or `R2_ACCOUNT_ID`.
