# Accounts migration (Sprint 1a)

This is the foundations half of customer accounts. There is no sign-up screen, no magic-link email, and no Stripe. The owner still signs in with `ADMIN_API_KEY`. The session cookie is still `pivit.sid`. `SESSION_SECRET` is not rotated.

Account #1 is named **Heclr**. The superadmin user is **info@heclr.com**, with `verified_at` left empty because email sign-in is Sprint 1b. The membership role is owner. `accounts.legacy` is true, and only one legacy account is allowed.

## What runs on startup

`src/db/migrate.js` takes an advisory lock and applies any missing version inside its own transaction. The version row is inserted in that same transaction.

| Version | What it does |
|---|---|
| 000 | `src/db/schema.sql`, the baseline that already matches the live database. Safe to re-run. It does not delete `events` or `host_hits`. |
| 001 | `src/db/tenancy.js`. Creates accounts, users, memberships and sites, attaches existing rows to Heclr, then checks totals. |
| 002 | `src/db/signup.js`. Invite codes, sign-in tokens, rate limits and the audit log. See [signup.md](signup.md). |

On a database that has already been through 000 and 001, startup logs `Database schema is up to date.` and does nothing else. Running `npm run migrate` does the same thing.

001 counts, before it changes ownership and again before it commits:

- experiments, variants, events, clients, test-traffic audit rows
- events with `is_test`, events with `excluded_at`
- events per experiment
- experiment identity: id, name, status, url_match, allowed_hosts, client_id
- variant identity, event identity, and each client's username and password hash

If any of those differ, it throws and the transaction rolls back. Password hashes are not written to the log. The check message only contains the counts that disagreed.

Child rows (variants, events, event drops, test-traffic audit) copy `account_id` from their experiment on insert, via a trigger. Experiments and clients do not default to Heclr. A forgotten insert fails instead of landing on the wrong account. `host_hits.account_id` does default to Heclr, because the existing counter inserts omit the column and the primary key cannot yet include the account. See the judgement notes below.

## What happens to today's data

- Every experiment with a non-empty `allowed_hosts` list is attached to Heclr and to a site whose domains are that list, normalised and sorted. The experiment's own `allowed_hosts` value is not rewritten.
- Distinct host lists become distinct sites, so one test cannot widen another test's serve list.
- An experiment with an empty list stays on Heclr with `site_id` null and `needs_site` true. Nothing is dropped.
- A verified site named `cantsaythat.co.uk` is always created, including when no current test uses only that host.
- Client logins keep their username, password hash and experiment assignments. They gain `account_id` for Heclr.
- Existing snippet tags, including ones that still point at pivit.click and send no site key, resolve only to Heclr, then use the same host rules as today. A missing, invalid or unknown key does not fall back to Heclr. A real `site_…` key serves that site only.
- Edit and preview tokens that were minted before this change keep working until they expire. New tokens also carry the account id and the site id.

Public snippet calls that do not match an account return an empty experiment list, or `204` for an event. They do not return 404. That is the same shape as a host that is not on the list, so an installed tag does not start erroring. Owner and client routes return **404** for another account's id (`no experiment found with that id`, or the same wording already used for a missing client). They do not return 403.

## What you do on Railway

1. Take a backup first, from a machine that can reach Postgres, and check that it restores. See [backups.md](backups.md). Store the dump off Railway.
2. Do not rotate `SESSION_SECRET`. Do not rename `pivit.sid`. Do not change `ADMIN_API_KEY`. No new variable is required for the app to boot.
3. Deploy this release. Startup applies 001 and logs `Tenancy check passed` with the counts, then `Applied migration 001 (tenancy).` The next boot applies nothing.
4. Sign in with the existing owner password. The response is still `{ "role": "owner" }`. The dashboard snippet tag for Heclr now includes `data-site`. Swapping the tag on cantsaythat.co.uk is optional and is the same edit as PIV-007. The tag that is already installed keeps working.
5. Nightly off-host backups stay with Hosting Malarky. The commands in [backups.md](backups.md) are what that job should run.

A failed 001 rolls back. The process then exits, so Railway does not serve traffic against a half-applied schema. Redeploy the previous release. You do not need to restore the backup for that case: the data is still in the pre-account shape.

If 001 **committed** and you need to undo it, restore the backup. Rolling only the git release back is not enough. `experiments.account_id` is `NOT NULL` and has no default, so the previous release cannot insert an experiment. Reads of the old columns would still work; writes would not.

## New route checklist

Isolation has to live in the query. A new owner, client or public route should:

- take the account from `req.account.id` (set by `requireAuth`), not from the body or the query string
- use `ownedExperiment` or an `account_id = $n` predicate, and return 404 when the row is missing
- for a public snippet call, use `publicScope` and serve nothing when the key is invalid or unknown
- put `account_id` and `site_id` on any new edit or preview token
- add a case to `scripts/isolation-db.test.js`

`src/metrics.js` is still unscoped. The HTTP results routes check ownership before they call it. A new caller must do the same.

## Judgement calls, where the plan and the code differ

- **View as, and the audit log.** PIV-022's audited superadmin view is Sprint 1b, because it depends on PIV-108. The user row stores `is_superadmin`. There is no view-as screen, so the owner login response and the dashboard do not change.
- **Install check does not block Start.** Marking a site verified, and refusing to start a test until a hit arrives, is PIV-052. Migrated sites are marked verified because they already have traffic. A new site may have `verified_at` null. Starting still requires a non-empty `allowed_hosts` list, which is the rule that shipped with host scoping.
- **`allowed_hosts` is not copied from the site.** The plan says a site drives `allowed_hosts`. Overwriting that column during the migration could add a host the experiment does not serve today, or drop one it does. Site domains are the normalised host set used to group tests. Serving still uses the experiment's own list plus the existing host check.
- **`host_hits` stays one row per day, host and origin.** The primary key is unchanged, so the existing upsert and the metrics tests keep working. `account_id` is `NOT NULL` with a default of Heclr, and the admin reading filters on it. The box-tester exclusion windows are shown only to the legacy account. Hits for a later account cannot be told apart until the snippet sends a site key and the primary key includes the account. That is a Sprint 1b change, not this one.
- **A failed migration stops the process.** Previously a schema error was logged and the server still listened. It now exits with status 1 after the rollback. That is fail-closed: a bad migration cannot serve traffic.
