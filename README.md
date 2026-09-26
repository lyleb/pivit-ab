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

## Finding your experiments again

The dashboard's **"Your Experiments"** section (right at the top, under the API key field) lists every experiment you've created — name, status, URL match, variant count, created date — pulled fresh from the database, so nothing needs to be written down or remembered. It loads automatically once you paste your API key, or click "Refresh List" any time. Each row has a **"Use ↓"** button that fills the Experiment ID into every section below it in one click, so you don't need to copy-paste IDs around manually.

## Change format (`changes` field on a variant)

The dashboard's "Add Variant" section now builds this for you via a form (selector + dropdown + value) — you shouldn't need to hand-write this JSON anymore. Documented here for reference / if you ever call the API directly:

```json
[
  { "selector": "#cta-button", "type": "text", "value": "Get Started Free" },
  { "selector": ".old-banner", "type": "hide" },
  { "selector": ".cta", "type": "style", "value": { "backgroundColor": "#1AB7C8" } },
  { "selector": "a.buy", "type": "attr", "attr": "href", "value": "/checkout-v2" },
  { "selector": "#signup-form", "type": "js", "value": "el.addEventListener('submit', () => console.log('tracked'));" }
]
```

Supported `type` values: `text`, `html`, `hide`, `show`, `style`, `attr`, `js`.

**On `js`**: this runs exactly what you type, against the matched element, on the client's live page. There's no sandboxing — treat it like writing to the client's site directly, because that's what it is. Since only you (holder of `ADMIN_API_KEY`) can create variants, the risk is the same as any other code you'd deploy to that site; there's no path for a client's visitors to inject their own JS through this. Use it for genuinely custom behaviour the other types can't cover — most banner/button tests won't need it.

## Finding a selector on the client's page

Hand-picking CSS selectors via devtools is tedious, especially on sites with auto-generated IDs (Wix, Squarespace, etc. often produce these). The dashboard has an **"AB Selector Picker"** link — drag it to your bookmarks bar once. Then, on the actual client page:

1. Click the bookmark
2. Click the element you want to target
3. Its selector is copied to your clipboard (and shown in a prompt as a fallback if clipboard access is blocked)
4. Paste it into the Selector field on the dashboard

This is a standalone tool (`snippet/picker-bookmarklet.js`) — it's not part of the tracking snippet and doesn't get deployed to client sites.

## Goals (conversion tracking, optional per variant)

The dashboard has a "Goals" section alongside "Changes" when adding a variant, with two goal types:

- **Click on element** — fires when the visitor clicks anything matching the selector. Works on any element, not just `<button>` — a `div`, `span`, link, whatever you point it at.
- **Visited a URL** — fires when the visitor later loads any page whose URL contains the text you give (e.g. `/thank-you`). This works even though that page is completely different from the one the experiment's changes run on — the snippet checks every page load against every experiment you've ever been assigned to, not just the one currently "running" there. Each goal only ever counts once per visitor.

Any goal firing sends a `convert` event back to the API (distinct from the automatic `view` event). The results table counts these under "conversions" and calculates the rate as conversions ÷ visitors.

## Reducing flicker

The "Copy Snippet" popover now shows two snippets, not one:

1. **In `<head>`** (new, optional but recommended) — a tiny inline snippet that hides the page the instant it starts loading, before the browser paints anything.
2. **Just before `</body>`** — the existing tracking snippet, unchanged.

Why two: true flicker prevention requires hiding the page before first paint, which only code running in `<head>` can do — by the time a script at the end of `<body>` runs, the browser has often already shown the original content for a moment. The `<head>` snippet hides the page via a CSS class, and `ab.js` removes that class the instant it's applied any DOM changes (or determined none apply) — normally well under a second. If something goes wrong (the API is slow or down), a 3-second timeout built into the `<head>` snippet reveals the page regardless, so a backend problem can never leave a visitor looking at a permanently blank page.

The trade-off: instead of a flash of the *original* content before it swaps to the variant, visitors see a brief blank page. That's the standard approach (Optimizely and Google Optimize both work the same way) — there's no way to show the final content instantly, since which variant to show depends on an API call that takes some non-zero time.

## Running experiments across multiple sites

One deployment of this app can run experiments on as many different domains as you like at once. `url_match` is just a substring check against whatever page the snippet loads on — it has nothing to do with which site it's running on. Install the same snippet tag (see "Your Snippet" at the top of the dashboard) once per site, and the server figures out which experiments apply based on the current page's URL every time it loads. No per-site configuration needed beyond pasting the tag in.

## Previewing a variant

Use the **"Preview & Manage Variants"** section: enter the Experiment ID and the actual page URL you're testing on, click Load, then hit **Preview** on any variant. It opens that variant in a new tab via `?ab_preview=<variant_id>` appended to the URL. This works even for a draft/paused experiment or a paused variant, and it never logs a view/conversion event — previewing never touches your real results.

## Pausing or deleting a variant

Same section as above:
- **Pause** stops a variant from being shown to new visitors but keeps all its recorded history — use this to stop a losing variant while still being able to look back at its numbers.
- **Delete** removes the variant permanently, including its recorded events (`ON DELETE CASCADE`). No undo — pause instead if you're not certain.

## Editing a variant

Same section: **Edit** loads that variant's name, traffic split, changes, and goals back into the "Add Variant" form above and switches it into edit mode (a red banner confirms this). Saving updates the existing variant instead of creating a new one — including for a variant that's currently live, so changes take effect for visitors immediately. There's no staged/draft version; if you want to test a change safely first, use Preview before saving, or pause the variant while you edit it. "Cancel edit" resets the form back to create-new mode.

## Reusing goals

The "Add Variant" section shows your 5 most-used goals as quick-pick buttons above the goals list — click one to add it to the current variant instead of retyping the selector or URL. Usage is tracked automatically every time you create or edit a variant with goals attached; no separate setup needed.

## Finding an experiment quickly

Every "Experiment" field is now a dropdown (Add Variant, Manage Variants, Status, Results) built from the same list as "Your Experiments" at the top — showing each one's name and status, not just a raw ID. Selecting an experiment in the Results or Manage Variants dropdown loads its data immediately; no extra click needed. The dropdowns refresh automatically whenever the list does (after creating an experiment, changing status, or clicking Refresh List).

## Data freshness

There's no caching or batch/polling delay anywhere — every view and conversion event is written to the database the instant it happens on a visitor's browser, and every "Load Results" click queries live. A **🔄 Refresh Results** button appears under the results table once you've loaded something, for a quick re-pull without scrolling back up.

## Exporting and deleting an experiment

Once an experiment is **archived**, "Your Experiments" shows two extra buttons on that row: **Export CSV** (every raw event — timestamp, type, variant, goal, visitor id, and new/returning label) and **Delete** (permanent — removes the experiment, its variants, and all events; the server refuses this unless the experiment is archived, as a guard rail). Export first if you want to keep the data before deleting.

## New vs returning visitors

A visitor counts as **new** on the calendar day of their first-ever view of an experiment, and **returning** on any later day they come back — a second pageview in the same sitting (a refresh, browsing to another page and back) doesn't count as "returning," only an actual later visit does. The Results table shows both counts alongside the total, and the **Visitors** filter above it (All / New only / Returning only) restricts the table and bar chart to just that segment. The CSV export includes a `visitor_type` column with this same classification per event.



## Results & performance charts

The "View Results" section now draws two charts alongside the table: a bar chart of conversion rate per variant, and a line chart of cumulative visitors over time per variant, so you can see a trend rather than just a single snapshot.

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
