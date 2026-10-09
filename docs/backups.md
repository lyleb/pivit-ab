# Backups before a migration

PIV-081, the nightly copy that lives off Railway, is Hosting Malarky's job. This repository supplies the commands and a restore check. The web process does not take backups, and the image that serves pivitlab does not need `pg_dump` installed. A missing client tool must not stop the site from booting.

## Before you deploy the accounts migration

Take the backup from a machine that can reach the database, not from the request path.

```bash
DATABASE_URL='postgres://…' BACKUP_DIR=/secure/off-host node scripts/backup.js
DATABASE_URL='postgres://…' node scripts/restore-check.js /secure/off-host/pivitlab-….dump
```

`scripts/backup.js` writes a custom-format dump (`pg_dump --format=custom --no-owner --no-acl`). `scripts/restore-check.js` loads that dump into a new scratch database, compares experiment, variant, event and client counts with the source, then drops the scratch database. It does not write to the source.

Keep the dump off Railway. A backup that sits on the same disk as the database is not a restore plan.

`BACKUP_DIR` is only read by `scripts/backup.js`. Do not set it on the web service unless you want the default `./backups` directory left unused. There is no new required variable.

## If you have to put the data back

```bash
# Create an empty database, then:
pg_restore --no-owner --no-acl --dbname "$DATABASE_URL" /secure/off-host/pivitlab-….dump
```

`pg_restore` exits 1 when it only printed warnings. Check the counts, or run `scripts/restore-check.js`, before you point the app at the restored database.

Do not commit dump files.
