# Agencies migration (Sprint 1a)

On screen, an account is an **agency**. The person who can see every agency is a **platform admin** (`users.is_superadmin`). People in an agency are an **Owner** or a **Member** (`memberships.role` is still `owner` or `member`). A view-only login is a **Viewer**. The table is still `clients`, the session role is still `client`, and the page is still `/client.html`. Who can do what today is in [help.md](help.md).

This page is the foundations half of agencies, as it was when migration 001 ran. Sign-up, email sign-in, the Users screen and agency invites came later. See [signup.md](signup.md) and [help.md](help.md). The session cookie is still `pivit.sid`. `SESSION_SECRET` is not rotated.

Agency #1 is named **Heclr**. The platform admin is **info@heclr.com**, with `verified_at` left empty because email sign-in is Sprint 1b. The membership role is `owner`. `accounts.legacy` is true, and only one legacy agency is allowed.

## What runs on startup

`src/db/migrate.js` takes an advisory lock and applies any missing version inside its own transaction. The version row is inserted in that same transaction.

| Version | What it does |
|---|---|
| 000 | `src/db/schema.sql`, the baseline that already matches the live database. Safe to re-run. It does not delete `events` or `host_hits`. |
| 001 | `src/db/tenancy.js`. Creates accounts, users, memberships and sites, attaches existing rows to Heclr, then checks totals. |
| 002 | `src/db/signup.js`. Invite codes, sign-in tokens, rate limits and the audit log. See [signup.md](signup.md). |
| 003 | `src/db/url-match-type.js`. Adds `experiments.url_match_type`, default `contains`. Does not rewrite existing rows. |
| 004 | `src/db/access-requests.js`. The public landing-page access-request table. Not added to `schema.sql`. |
| 005 | `src/db/portal.js`. Optional `experiments.hypothesis`, daily `status_snapshots`, and `review_requests`. Not added to `schema.sql`. |
| 006 | `src/db/install-check.js`. Optional note on an unverified site when a visit from its domain arrives without that site's key. Not added to `schema.sql`. Existing verified sites, including cantsaythat.co.uk, are left alone. |
| 007 | `src/db/sessions.js`. Lookup indexes on the session table. Not added to `schema.sql`. |
| 008 | `src/db/rate-limits.js`. Index on `rate_limits.window_start`. Does not change existing counters. Not added to `schema.sql`. |
| 009 | `src/db/first-run.js`. Nullable `accounts.checklist_dismissed_at` and `sites.qa_seen_at`. Does not backfill. Not added to `schema.sql`. |

Once every version above is recorded, startup logs `Database schema is up to date.` and does nothing else. A statement added only to `schema.sql` after 000 is recorded does not run; it needs a new version. Running `npm run migrate` does the same thing.

001 counts, before it changes ownership and again before it commits:

- experiments, variants, events, clients, test-traffic audit rows
- events with `is_test`, events with `excluded_at`
- events per experiment
- experiment identity: id, name, status, url_match, allowed_hosts, client_id
- variant identity, event identity, and each viewer's username and password hash

If any of those differ, it throws and the transaction rolls back. Password hashes are not written to the log. The check message only contains the counts that disagreed.

Child rows (variants, events, event drops, test-traffic audit) copy `account_id` from their experiment on insert, via a trigger. Experiments and clients do not default to Heclr. A forgotten insert fails instead of landing on the wrong account. `host_hits.account_id` does default to Heclr, because the existing counter inserts omit the column and the primary key cannot yet include the account. See the judgement notes below.

## What happens to today's data

- Every experiment with a non-empty `allowed_hosts` list is attached to Heclr and to a site whose domains are that list, normalised and sorted. The experiment's own `allowed_hosts` value is not rewritten.
- Distinct host lists become distinct sites, so one test cannot widen another test's serve list.
- An experiment with an empty list stays on Heclr with `site_id` null and `needs_site` true. Nothing is dropped.
- A verified site named `cantsaythat.co.uk` is always created, including when no current test uses only that host.
- Viewer logins (rows in `clients`) keep their username, password hash and experiment assignments. They gain `account_id` for Heclr.
- Existing snippet tags, including ones that still point at pivit.click and send no site key, resolve only to Heclr, then use the same host rules as today. A missing, invalid or unknown key does not fall back to Heclr. A real `site_…` key serves that site only.
- Edit and preview tokens that were minted before this change keep working until they expire. New tokens also carry the account id and the site id.

Public snippet calls that do not match an agency return an empty experiment list, or `204` for an event. They do not return 404. That is the same shape as a host that is not on the list, so an installed tag does not start erroring. Owner and viewer routes return **404** for another agency's id (`no experiment found with that id`, or `no viewer found with that id`). They do not return 403. The routes are still `/api/clients` and `/api/client`.

## What you do on Railway

1. Take a backup first, from a machine that can reach Postgres, and check that it restores. See [BACKUPS.md](BACKUPS.md). Store the dump off Railway.
2. Do not rotate `SESSION_SECRET`. Do not rename `pivit.sid`. Do not change `ADMIN_API_KEY`. No new variable is required for the app to boot.
3. Deploy this release. Startup applies 001 and logs `Tenancy check passed` with the counts, then `Applied migration 001 (tenancy).` The next boot applies nothing.
4. Sign in with the existing owner password. The response is still `{ "role": "owner" }`. The dashboard snippet tag for Heclr now includes `data-site`. Swapping the tag on cantsaythat.co.uk is optional and is the same edit as PIV-007. The tag that is already installed keeps working.
5. Nightly off-site backups are the Railway cron service in [BACKUPS.md](BACKUPS.md). That job copies the database to Cloudflare R2.

A failed 001 rolls back. The process then exits, so Railway does not serve traffic against a half-applied schema. Redeploy the previous release. You do not need to restore the backup for that case: the data is still in the pre-account shape.

If 001 **committed** and you need to undo it, restore the backup. Rolling only the git release back is not enough. `experiments.account_id` is `NOT NULL` and has no default, so the previous release cannot insert an experiment. Reads of the old columns would still work; writes would not.

## New route checklist

Isolation has to live in the query. A new Owner, viewer or public route should:

- take the account from `req.account.id` (set by `requireAuth`), not from the body or the query string
- use `ownedExperiment` or an `account_id = $n` predicate, and return 404 when the row is missing
- for a public snippet call, use `publicScope` and serve nothing when the key is invalid or unknown
- put `account_id` and `site_id` on any new edit or preview token
- add a case to `scripts/isolation-db.test.js` (legacy agency) or `scripts/cross-account.test.js` (two agencies)

`src/metrics.js` is still unscoped. The HTTP results routes check ownership before they call it. A new caller must do the same.

## Judgement calls, where the plan and the code differ

- **View as, and the audit log.** The user row stores `is_superadmin`. A platform admin can open a read-only support view of another agency from the dashboard. Starting and stopping that view is written to the audit log. See [help.md](help.md).
- **Install check blocks Start.** A snippet call with the site key, from an Origin on that site's domain list, sets `verified_at`. Starting is refused until then. Migrated sites, including cantsaythat.co.uk, are marked verified because they already have traffic. A new site may have `verified_at` null. Starting still requires a non-empty `allowed_hosts` list. A duplicate domain sets `sites.conflict` and an audit row. A separate notice to Lyle is not built.
- **`allowed_hosts` is not copied from the site.** The plan says a site drives `allowed_hosts`. Overwriting that column during the migration could add a host the experiment does not serve today, or drop one it does. Site domains are the normalised host set used to group tests. Serving still uses the experiment's own list plus the existing host check.
- **`host_hits` stays one row per day, host and origin.** The primary key is unchanged, so the existing upsert and the metrics tests keep working. `account_id` is `NOT NULL` with a default of Heclr, and the admin reading filters on it. The box-tester exclusion windows are shown only to the legacy account. Hits for a later account cannot be told apart until the snippet sends a site key and the primary key includes the account. That is a Sprint 1b change, not this one.
- **A failed migration stops the process.** Previously a schema error was logged and the server still listened. It now exits with status 1 after the rollback. That is fail-closed: a bad migration cannot serve traffic.
