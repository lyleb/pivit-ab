# Sign-up and sign-in (Sprint 1b)

Invite-only. A customer enters a work email and a website, then signs in from a link or a 6-digit code. There is no customer password. The emergency owner password (`ADMIN_API_KEY`) still works. The session cookie is still `pivit.sid`. Do not rotate `SESSION_SECRET`.

Account #1 stays **Heclr**. The superadmin is **info@heclr.com**. The first email sign-in sets `verified_at`.

## What you set on Railway

Set this on the app service:

| Variable | Required | Value |
|---|---|---|
| `POSTMARK_SERVER_TOKEN` | Yes, to send mail | The Postmark server API token. With it unset, the app logs the email and does not send it. |
| `EMAIL_FROM` | No | From address. Default `no-reply@pivitlab.com`. |
| `EMAIL_REPLY_TO` | No | Reply-To on every message. Default `info@heclr.com`. pivitlab.com has a null MX, so replies cannot go to the from address. |
| `POSTMARK_WEBHOOK_TOKEN` | No | Only if you turn on the bounce webhook. Postmark must send the same value in the `X-Postmark-Token` header. Leave unset and `POST /api/webhooks/postmark` stays closed. |
| `TURNSTILE_SECRET_KEY` | No | Leave unset. Turnstile runs only when this is set. Sign-up stays invite-only. |

Do not change `ADMIN_API_KEY`, `SESSION_SECRET`, `DATABASE_URL`, or the cookie name.

Mail is sent with Postmark's HTTPS API (`https://api.postmarkapp.com/email`), not SMTP. Railway Hobby blocks outbound SMTP.

## DNS

Postmark DKIM and the Return-Path CNAME for pivitlab.com are already live. No new DNS records are needed for this release.

pivitlab.com still has a null MX, so the domain does not receive mail. Every outgoing message sets Reply-To to `EMAIL_REPLY_TO` (default `info@heclr.com`).

## How a customer gets in

1. A superadmin creates an invite code on the home screen. It is shown once, works once, and expires after 14 days. Revoke stops it.
2. The person opens `/signup.html?code=…`, enters a work email and a website, and agrees to the terms version `beta-2026-10-09`. The terms page is a placeholder for Lyle to replace.
3. The email contains a link and a 6-digit code. Both expire after 15 minutes. Either one works once. The link opens `/sign-in.html`, which does not sign them in until they press **Sign in**, so a mail scanner that only fetches the link does not use it up. The code allows 5 tries.
4. That first sign-in is the email verification. The account is named after the domain. The site is not verified yet.
5. The empty home screen is the first-run checklist: the site, the snippet (with `data-site`), and a check that ticks when a page on that domain loads the snippet. A test can be built before that, and cannot be started until the check has passed.

The reply to "email me a link" is always "If that address can be used, we've sent a link." Sign-up and that request are limited to 5 per email address per hour and 20 per IP per hour. The limits and the password lockout (5 tries, then 60 seconds) are in Postgres.

A customer session lasts 30 days and is renewed while they use the app. A superadmin session, including the emergency password, lasts 12 hours. Signing in does not end other sessions. **Sign out everywhere** does. Each sign-in replaces the session id.

State-changing requests must come from this app's origin. The snippet and the visual editor are exempt, because they run on the customer's site.

## Audit log

`audit_log` records sign-up, sign-in, failed codes, invites, sites, verification, Reveal early, test-traffic remove and restore, and superadmin view-as. An account owner sees their own rows. A superadmin sees the whole log, except while using view-as, which is limited to that account and cannot change anything.

The experiment screen still reads `test_traffic_audit`. New remove, restore and Reveal rows are written there and copied into `audit_log`. Rows that already existed are copied once by migration 002.
