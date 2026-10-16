# Sign-up and sign-in (Sprint 1b)

Invite-only. A customer enters a work email and a website, then signs in from a link or a 6-digit code. There is no customer password. The owner signs in day to day the same way, by email at info@heclr.com. The owner password (`ADMIN_API_KEY`) stays as a fallback, on the unlisted page `/owner`. That page is not linked from sign-in, is noindexed, and is left out of `robots.txt`. The public sign-in page is email sign-in and client login. The session cookie is `pivit.sid` (in production, `__Host-pivit.sid`). Do not rotate `SESSION_SECRET`.

Account #1 stays **Heclr**. The superadmin is **info@heclr.com**. The first email sign-in sets `verified_at`.

## What you set on Railway

Set this on the app service:

| Variable | Required | Value |
|---|---|---|
| `POSTMARK_SERVER_TOKEN` | Yes, to send mail | The Postmark server API token. With it unset, the app logs the email and does not send it. |
| `EMAIL_FROM` | No | From address. Default `no-reply@pivitlab.com`. |
| `EMAIL_REPLY_TO` | No | Reply-To on every message. Default `info@heclr.com`. pivitlab.com has a null MX, so replies cannot go to the from address. |
| `POSTMARK_WEBHOOK_TOKEN` | No | Only if you turn on the bounce webhook. Postmark must send the same value in the `X-Postmark-Token` header. Leave unset and `POST /api/webhooks/postmark` stays closed. |
| `TURNSTILE_SITE_KEY` | No | Leave unset. Public site key. Turnstile stays off unless this and `TURNSTILE_SECRET_KEY` are both set. |
| `TURNSTILE_SECRET_KEY` | No | Leave unset. Secret key. Both keys are required before the widget or the check runs. |
| `ACCESS_REQUESTS_ENABLED` | No | Leave unset. The landing-page form stores nothing until this is `true`, `1`, `yes` or `on`. `/privacy.html` is still a placeholder, so leave the form off until that page has real wording. |
| `ACCESS_REQUEST_EMAIL` | No | Inbox for each access request. Defaults to `EMAIL_REPLY_TO` (`info@heclr.com`). |

Do not change `SESSION_SECRET` or `DATABASE_URL`. You do not set the cookie name: production sends `__Host-pivit.sid` on its own. Changing `ADMIN_API_KEY` signs out emergency-password sessions. Magic-link and client sessions stay.

Mail is sent with Postmark's HTTPS API (`https://api.postmarkapp.com/email`), not SMTP. Railway Hobby blocks outbound SMTP.

## DNS

Postmark DKIM and the Return-Path CNAME for pivitlab.com are already live. No new DNS records are needed for this release.

pivitlab.com still has a null MX, so the domain does not receive mail. Every outgoing message sets Reply-To to `EMAIL_REPLY_TO` (default `info@heclr.com`).

## How a customer gets in

1. A superadmin creates an invite code on the home screen. It is shown once, works once, and expires after 14 days. Revoke stops it.
2. The person opens `/signup.html?code=…`, enters a work email and a website, and agrees to the terms version `beta-2026-10-09`. The terms page is a placeholder for Lyle to replace.
3. The email contains a link and a 6-digit code. Both expire after 15 minutes. Either one works once. The link opens `/sign-in.html`, which does not sign them in until they press **Sign in**, so a mail scanner that only fetches the link does not use it up. The code allows 5 tries.
4. That first sign-in is the email verification. The account is named after the domain. The site is not verified yet.
5. The home screen shows a first-run checklist above the experiments: add the site, install the snippet (the status uses the install-check note), create a test, open the page with `?pivit_qa=1`, then start the test. Each step ticks from the account's own data. The list can be hidden, and it hides itself once every step has ticked. A test can be built before the snippet has been seen, and cannot be started until that check has passed. If a visit from the site arrives with no site key, or with a key that is not this account's, the snippet step says so. The public snippet response stays an empty list, the same as a host that is not allowed.

The reply to "email me a link" is always "If that address can be used, we've sent a link." Asking for a link, signing up (including an invite code) and the access-request form are limited in Postgres: 5 per email address per hour, and 20 per IP per hour (10 per IP per hour for an access request). The owner page at `/owner` and the emergency password are limited too, as is client password sign-in (5 failures, then 60 seconds). A limit answers 429 with `Retry-After` and "Please wait a moment and try again." The counters survive a redeploy and are shared by every instance. `POST /api/event` keeps a separate limit of 60 events a minute per IP, also in Postgres. A normal visit stays under it, the reply stays 204 so the live snippet is unchanged, and a limiter error does not drop the event.

A customer session lasts 30 days of use (idle) and never more than 90 days from sign-in (absolute), even if they keep coming back. Both deadlines are stored in the session row in Postgres. A superadmin session, including the emergency password, lasts 12 hours from sign-in and is not renewed. Signing in does not end other sessions. **Sign out everywhere** does, for an owner on the dashboard and for a client viewer on their portal. Changing a client viewer's password, or deleting that viewer, ends their sessions. Changing `ADMIN_API_KEY` ends emergency-password sessions only. Each sign-in replaces the session id, and so does starting or stopping view-as.

In production the cookie is `__Host-pivit.sid`: HttpOnly, Secure, SameSite=Lax, Path=/, and no Domain. That prefix is only safe over HTTPS, so local development and the tests keep `pivit.sid`.

State-changing requests must come from https://pivitlab.com, from `APP_ORIGIN`, or from an origin listed in `APP_ORIGINS`. The check uses Origin, or Referer when Origin was not sent. A request Host that is not one of those origins is not enough, so a Railway hostname or pivit.click cannot post into an account. Outside production the request's own origin is also allowed, so localhost works. The snippet's event endpoint, the visual editor, and the Postmark webhook are exempt, because they are not browser calls from pivitlab.com. The live tag on cantsaythat still posts `/api/event`.

## Audit log

`audit_log` records sign-up, sign-in (magic link, client password, and the emergency password as `emergency_signin`), sign-out everywhere, failed codes, invites, sites, verification, Reveal early, test-traffic remove and restore, role changes, and superadmin view-as start and stop. An owner sees only that account's rows. A superadmin sees the same limit: their own account, or the account they are viewing. View-as stays read-only. A client viewer cannot open the log. The Audit log screen is on the owner dashboard. If the audit table is missing, those actions still succeed.

The experiment screen still reads `test_traffic_audit`. New remove, restore and Reveal rows are written there and to `audit_log`. Rows that already existed are copied by migration 002. Migration 014 copies any that were missed. The old table is kept.

## Access requests

The landing page at `/` is public. Logged-in owners and customers are redirected to `/index.html`. Client sessions go to `/client.html`.

The request form (name, work email, website) is off until `ACCESS_REQUESTS_ENABLED` is set. Until then the page says to email info@pivitlab.com, and `POST /api/access-requests` returns 404 and stores nothing.

When the form is on, a request is stored in `access_requests` (migration 004, next to invite codes) and an email is sent through Postmark to `ACCESS_REQUEST_EMAIL`, or to `EMAIL_REPLY_TO` when that is unset. If Postmark does not accept the message, the row is kept and a notice is added on the owner home page. A honeypot field and a rate limit (5 per email address and 10 per IP, each hour) sit in front of it. The sign-in page, the sign-up page, the owner page and this form can show a Cloudflare Turnstile widget. It stays off unless both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set. With either one missing, those pages do not load the Turnstile script and the check is skipped.

The superadmin invite card on the dashboard lists the requests. **Create invite code** makes one code for that person, with their name, email and website in the note, and shows the code once. A second click does not make another code. Do not turn the form on until `/privacy.html` has Lyle's wording. That page is a placeholder.
