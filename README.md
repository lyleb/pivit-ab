# AB Platform — v0.1

Basic A/B testing platform: snippet + API + results dashboard.

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env` and set `DATABASE_URL` (any Postgres instance works — local, Railway, Supabase, etc.)
3. Generate an admin key and set it as `ADMIN_API_KEY` in `.env`:
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
4. `npm run dev` — starts the server on `http://localhost:3000` (tables are created automatically on startup, no separate migrate step needed)
5. Open `http://localhost:3000` for the admin dashboard, paste your `ADMIN_API_KEY` into the "Admin API Key" field at the top before using anything else on the page

## Deploying (recommended: Railway)

1. Push this repo to GitHub
2. Create a new Railway project → "Deploy from GitHub repo" → select this repo
3. Add a Postgres database: in your Railway project, click "+ New" → "Database" → "Add PostgreSQL". Railway auto-connects it and injects `DATABASE_URL` into your app service.
4. On your app service, set `NODE_ENV=production` and `ADMIN_API_KEY` (a generated secret — see step 3 in Local setup) in the Variables tab
5. Deploy — tables are created automatically on first startup, no manual migration step

## How it works

1. **Create an experiment** via the dashboard — give it a name and a `url_match` (a substring the page URL must contain, e.g. `/pricing`).
2. **Add variants** — each variant has a `traffic_split` (%) and a `changes` array describing DOM edits.
3. **Set status to `running`.**
4. **Client adds the snippet** to their site:
   ```html
   <script src="https://your-app.up.railway.app/snippet/ab.js"
           data-api="https://your-app.up.railway.app"></script>
   ```
5. On page load, the snippet asks the API which experiments apply to the current URL, picks a variant per visitor (sticky via `localStorage`), applies the DOM changes, and logs a `view` event.
6. Add `goals` to a variant (see below) to track clicks as conversions.
7. **View results** on the dashboard by experiment ID.

## Change format (`changes` field on a variant)

```json
[
  { "selector": "#cta-button", "type": "text", "value": "Get Started Free" },
  { "selector": ".old-banner", "type": "hide" },
  { "selector": ".cta", "type": "style", "value": { "backgroundColor": "#1AB7C8" } },
  { "selector": "a.buy", "type": "attr", "attr": "href", "value": "/checkout-v2" }
]
```

Supported `type` values: `text`, `html`, `hide`, `show`, `style`, `attr`.

## Goals (conversion tracking, optional per variant)

The dashboard has a "Goals" field alongside "Changes" when adding a variant:

```json
[ { "selector": "#submit-form", "id": "form_submit" } ]
```

Any click on a goal's selector fires a `convert` event back to the API (distinct from the automatic `view` event and from plain `click` events, which aren't sent unless tied to a goal). The results table counts these under "conversions" and calculates the rate as conversions ÷ visitors.

## Admin authentication

Every route except the two the snippet calls (`GET /api/experiments`, `POST /api/event`) requires an `x-api-key` header matching your `ADMIN_API_KEY` env var. This covers creating experiments, adding variants, changing status, and viewing results.

- If `ADMIN_API_KEY` isn't set on the server, admin routes refuse everything (fails closed, so you can't accidentally run unprotected).
- The dashboard sends the key from the "Admin API Key" field at the top of the page — it's kept in that page's memory only, not persisted, so you'll need to re-paste it each time you reload the dashboard.
- The public snippet endpoints stay open on purpose — they're called from any visitor's browser and have no sensitive data to protect (just "which experiments run on this URL" and "log this event").

This is a single shared secret, not per-user accounts — fine for one person running this, but if you ever add teammates you'd want to move to real per-user auth.

## What's NOT in v1 (by design)

- Single shared API key, not per-user login — fine solo, not for a team
- No visual point-and-click editor — variants are defined via JSON
- No statistical significance calculation — raw counts and rate only
- 50/50-style manual splits only, no auto traffic allocation
- No multi-page funnels

## Next steps to consider

- Visual variant editor (click element → choose change type) instead of raw JSON
- Statistical significance indicator on results (e.g. simple z-test)
- Support for multiple goals per variant with individual conversion rates
- Per-user login if you ever bring on a teammate
