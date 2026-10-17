# Sign-up and sign-in (Sprint 1b)

Invite-only. An agency Owner enters a work email and a website, then signs in from a link or a 6-digit code. There is no agency password. The Owner signs in day to day the same way, by email at info@heclr.com. The owner password (`ADMIN_API_KEY`) stays as a fallback, on the unlisted page `/owner`. That page is not linked from sign-in, is noindexed, and is left out of `robots.txt`. The public sign-in page is email sign-in and viewer login. The session cookie is `pivit.sid` (in production, `__Host-pivit.sid`). Do not rotate `SESSION_SECRET`.

The names on screen are **Platform admin**, **Agency** (with roles **Owner** and **Member**) and **Viewer**. In the database and the API those are still `users.is_superadmin`, the `accounts` table, membership roles `owner` and `member`, and the `clients` table with session `role` `client`. The Viewer sign-in address stays `/login.html?role=client`. The sign-in page calls it Viewer login. The viewer page stays `/client.html`. The screens are in [help.md](help.md).

Agency #1 stays **Heclr**. The platform admin is **info@heclr.com** (`is_superadmin`). The first email sign-in sets `verified_at`.

## What you set on Railway

Set this on the app service:

| Variable | Required | Value |
|---|---|---|
| `POSTMARK_SERVER_TOKEN` | Yes, to send mail | The Postmark server API token. With it unset, the app logs the email and does not send it. |
| `EMAIL_FROM` | No | From address. A bare address is sent as `"pivitlab" <that address>`. Default `"pivitlab" <no-reply@pivitlab.com>`. |
| `EMAIL_REPLY_TO` | No | Reply-To on every message. Default `info@heclr.com`. pivitlab.com can receive mail. Replies still go to this address. |
| `POSTMARK_STREAM` | No | Postmark message stream. Default `outbound`. |
| `POSTMARK_WEBHOOK_TOKEN` | No | Only if you turn on the bounce webhook. Postmark must send the same value in the `X-Postmark-Token` header. Leave unset and `POST /api/webhooks/postmark` stays closed. |
| `TURNSTILE_SITE_KEY` | No | Leave unset. Public site key. Turnstile stays off unless this and `TURNSTILE_SECRET_KEY` are both set. |
| `TURNSTILE_SECRET_KEY` | No | Leave unset. Secret key. Both keys are required before the widget or the check runs. |
| `ACCESS_REQUESTS_ENABLED` | No | Leave unset. The landing-page form stores nothing until this is `true`, `1`, `yes` or `on`. `/privacy.html` is still a placeholder, so leave the form off until that page has real wording. |
| `ACCESS_REQUEST_EMAIL` | No | Inbox for each access request. Defaults to `EMAIL_REPLY_TO` (`info@heclr.com`). |

Do not change `SESSION_SECRET` or `DATABASE_URL`. You do not set the cookie name: production sends `__Host-pivit.sid` on its own. Changing `ADMIN_API_KEY` signs out emergency-password sessions. Magic-link and viewer sessions stay.

Mail is sent with Postmark's HTTPS API (`https://api.postmarkapp.com/email`), not SMTP. Railway Hobby blocks outbound SMTP. Each message has a plain-text part and a simple HTML part, with the pivitlab name and a button when there is a link. Postmark gets a tag for the email type (`login-link`, `signup-link`, `agency-invite`, `access-request`, `conclusion-approved`, `review-request`). The message stream is `POSTMARK_STREAM`, or `outbound` when that is unset. These messages do not set List-Unsubscribe.

## DNS

Postmark DKIM and the Return-Path CNAME for pivitlab.com are already live. No new DNS records are needed for this release.

pivitlab.com can receive mail. Every outgoing message still sets Reply-To to `EMAIL_REPLY_TO` (default `info@heclr.com`), so replies land in that inbox.

## How an agency gets in

1. A platform admin creates an invite code on the home screen. It is shown once, works once, and expires after 14 days. Revoke stops it.
2. The person opens `/signup.html?code=…`, enters a work email and a website, and agrees to the terms version `beta-2026-10-09`. The terms page is a placeholder for Lyle to replace.
3. The email contains a link and a 6-digit code. Both expire after 15 minutes. Either one works once. The link opens `/sign-in.html`, which does not sign them in until they press **Sign in**, so a mail scanner that only fetches the link does not use it up. The code allows 5 tries.
4. That first sign-in is the email verification. The agency is named after the domain. The site is not verified yet.
5. The home screen shows a first-run checklist above the experiments: add the site, install the snippet (the status uses the install-check note), create a test, open the page with `?pivit_qa=1`, then start the test. Each step ticks from the agency's own data. The list can be hidden, and it hides itself once every step has ticked. A test can be built before the snippet has been seen, and cannot be started until that check has passed. If a visit from the site arrives with no site key, or with a key that is not this agency's, the snippet step says so. The public snippet response stays an empty list, the same as a host that is not allowed.

## How a colleague joins an existing agency

An invite code creates a new agency. It does not add a person to one that already exists. An Owner uses **Team** for that.

1. Open **Team**, under **Invite someone**. Enter their work email and choose Member or Owner.
2. Choose **Email the invite**, or **Create a link**. The link is shown once, works once, lasts 7 days, and can be revoked. Opening it does not use it up.
3. They press **Join this agency**. That adds them to this agency. If they already use pivitlab, they are added. It does not create an agency or a site.
4. **Pending invites** lists the ones still open. **Resend** emails a new link and replaces the previous one.

A suspended or deleted address cannot be invited. Someone already in the agency cannot be invited again. A Member can see Team and cannot send invites. See [help.md](help.md).

## Who signs in how

1. A Platform admin, an Owner and a Member use the sign-in page. They enter a work email and choose **Email me a sign-in link**. The email has a link and a 6-digit code. Each lasts 15 minutes and works once. The link opens a page where they press **Sign in**.
2. A Platform admin session lasts 12 hours from sign-in and is not renewed. An Owner or a Member stays signed in for 30 days of use, and never more than 90 days from sign-in.
3. A Viewer chooses **Viewer login** on the sign-in page, or opens `/login.html?role=client`, and enters the username and password their agency gave them. There is no email sign-in for a Viewer. An Owner resets the password from Team.
4. The fallback password at `/owner` is only for the platform admin. It is not linked from the sign-in page. Day to day, sign in by email.

**Suspend** signs the person out at once and refuses the next sign-in. **Archive** hides them from lists and does not, on its own, stop sign-in. A deleted person cannot sign in. Asking for an email link still answers "If that address can be used, we've sent a link." Nothing is sent. A Viewer whose password is right, but who is suspended or deleted, sees "That sign-in isn't available."

The reply to "email me a link" is always "If that address can be used, we've sent a link." Asking for a link, signing up (including an invite code) and the access-request form are limited in Postgres: 5 per email address per hour, and 20 per IP per hour (10 per IP per hour for an access request). The owner page at `/owner` and the emergency password are limited too, as is viewer password sign-in (5 failures, then 60 seconds). A limit answers 429 with `Retry-After` and "Please wait a moment and try again." The counters survive a redeploy and are shared by every instance. `POST /api/event` keeps a separate limit of 60 events a minute per IP, also in Postgres. A normal visit stays under it, the reply stays 204 so the live snippet is unchanged, and a limiter error does not drop the event.

An agency session lasts 30 days of use (idle) and never more than 90 days from sign-in (absolute), even if they keep coming back. Both deadlines are stored in the session row in Postgres. A platform admin session, including the emergency password, lasts 12 hours from sign-in and is not renewed. Signing in does not end other sessions. **Sign out everywhere** does, for an Owner on the dashboard and for a viewer on their page. Changing a viewer's password, or deleting that viewer, ends their sessions. Changing `ADMIN_API_KEY` ends emergency-password sessions only. Each sign-in replaces the session id, and so does starting or stopping view-as.

In production the cookie is `__Host-pivit.sid`: HttpOnly, Secure, SameSite=Lax, Path=/, and no Domain. That prefix is only safe over HTTPS, so local development and the tests keep `pivit.sid`.

State-changing requests must come from https://pivitlab.com, from `APP_ORIGIN`, or from an origin listed in `APP_ORIGINS`. The check uses Origin, or Referer when Origin was not sent. A request Host that is not one of those origins is not enough, so a Railway hostname or pivit.click cannot post into an agency. Outside production the request's own origin is also allowed, so localhost works. The snippet's event endpoint, the visual editor, and the Postmark webhook are exempt, because they are not browser calls from pivitlab.com. The live tag on cantsaythat still posts `/api/event`.

## Audit log

`audit_log` records sign-up, sign-in (magic link, Viewer password, and the emergency password as `emergency_signin`), sign-out everywhere, failed codes, invites (including an agency invite created, resent, revoked or accepted), sites, verification, Reveal early, test-traffic remove and restore, role changes, removing someone from an agency, Viewer create, edit, password reset and delete, and platform-admin suspend, unsuspend, archive, restore and delete. An Owner or a Member sees only that agency's rows. A platform admin sees the same limit: their own agency, or the agency they are viewing. View-as stays read-only, and starting or stopping it is written here. A Viewer cannot open the log. The Audit log screen is on the dashboard. If the audit table is missing, those actions still succeed. Stored `actor_label` values such as `superadmin` and `client` are unchanged; the screen shows them as Platform admin and Viewer.

The user filter is current people in the agency, plus names already written on a row. Archived and deleted people are left out of that filter, so old names do not pile up. The rows stay. After a delete, those rows name the person as "Deleted user" and a short code, not their email or username. See [help.md](help.md).

The experiment screen still reads `test_traffic_audit`. New remove, restore and Reveal rows are written there and to `audit_log`. Rows that already existed are copied by migration 002. Migration 014 copies any that were missed. The old table is kept.

## Access requests

The landing page at `/` is public. Logged-in Owners and Members are redirected to `/index.html`. Viewer sessions go to `/client.html`.

The request form (name, work email, website) is off until `ACCESS_REQUESTS_ENABLED` is set. Until then the page says to email info@pivitlab.com, and `POST /api/access-requests` returns 404 and stores nothing.

When the form is on, a request is stored in `access_requests` (migration 004, next to invite codes) and an email is sent through Postmark to `ACCESS_REQUEST_EMAIL`, or to `EMAIL_REPLY_TO` when that is unset. If Postmark does not accept the message, the row is kept and a notice is added on the owner home page. A honeypot field and a rate limit (5 per email address and 10 per IP, each hour) sit in front of it. The sign-in page, the sign-up page, the owner page and this form can show a Cloudflare Turnstile widget. It stays off unless both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set. With either one missing, those pages do not load the Turnstile script and the check is skipped.

The platform admin invite card on the dashboard lists the requests. **Create invite code** makes one code for that person, with their name, email and website in the note, and shows the code once. A second click does not make another code. Do not turn the form on until `/privacy.html` has Lyle's wording. That page is a placeholder.
