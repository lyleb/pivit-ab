# AB Platform — v0.1

Basic A/B testing platform: snippet + API + results dashboard.

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env` and set `DATABASE_URL` (any Postgres instance works — local, Railway, Supabase, etc.)
3. Generate an admin key and set it as `ADMIN_API_KEY` in `.env`:
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
4. `npm run dev` — starts the server on `http://localhost:3000`. Startup applies any missing database versions (see [docs/tenancy.md](docs/tenancy.md)). A failed migration rolls back and the process exits.
5. Open `http://localhost:3000` for the public landing page. The admin dashboard is at `http://localhost:3000/index.html` (it asks you to sign in). Logged-in Owners and Members who open `/` are sent to the dashboard. Viewer sessions are sent to `/client.html`. On screen the roles are Platform admin, Agency (Owner or Member) and Viewer. The database and API names (`accounts`, `clients`, `role=client`) stay as they are. Help in the sidebar opens the same steps as [docs/help.md](docs/help.md).

## Deploying (recommended: Railway)

1. Push this repo to GitHub
2. Create a new Railway project → "Deploy from GitHub repo" → select this repo
3. Add a Postgres database: in your Railway project, click "+ New" → "Database" → "Add PostgreSQL". Railway auto-connects it and injects `DATABASE_URL` into your app service.
4. On your app service, set `NODE_ENV=production`, `ADMIN_API_KEY` (a generated secret — see step 3 in Local setup) and `SESSION_SECRET` (at least 32 characters, any character set — see `.env.example`) in the Variables tab. If `NODE_ENV=production` and `SESSION_SECRET` is missing or shorter than 32 characters, the process exits at startup and the site will not boot. Set it before deploying. Do not rotate an existing secret that is already long enough. Sign-in email also needs `POSTMARK_SERVER_TOKEN`. The from address and reply-to have defaults. See [docs/signup.md](signup.md).
5. Take a database backup before deploying a migration, and keep it off Railway. Nightly copies upload to Cloudflare R2 from a cron service. See [docs/BACKUPS.md](docs/BACKUPS.md). Deploy — missing database versions run on startup. If a version fails, that version rolls back and the process exits; redeploy the previous release. Do not rotate `SESSION_SECRET` or rename the `pivit.sid` cookie. Agency #1 and the site key are described in [docs/tenancy.md](docs/tenancy.md).

## Search indexing

The public landing page at `/` is the only page that should be indexed, together with `/sitemap.xml`. It sends no `X-Robots-Tag`, and its robots meta is `index, follow`. The canonical link is `https://pivitlab.com/` (or `APP_ORIGIN` when that is set). The title, description and Open Graph tags are on that page. The share image is `/assets/og-pivitlab.png`.

Every other response, including `/index.html` (the dashboard), `/login.html`, `/privacy.html`, `/legal.html`, the viewer page (`/client.html`), `/owner`, `/api`, `/snippet` and `/health`, sends `X-Robots-Tag: noindex, nofollow`. The app HTML pages repeat that in a robots meta tag. `robots.txt` disallows `/api/`, `/snippet/` and `/owner`, so the HTML stays crawlable and Google can read the noindex. It also has one sitemap line: `Sitemap: https://pivitlab.com/sitemap.xml`. The sitemap lists only `https://pivitlab.com/`.

The landing page form does not collect anything until `ACCESS_REQUESTS_ENABLED` is set (see `.env.example` and [docs/signup.md](docs/signup.md)). Until then it asks people to email info@pivitlab.com. `/privacy.html` is a placeholder for Lyle's wording.

## How it works

1. **Create an experiment** via the dashboard — give it a name and a `url_match` (a substring the page URL must contain, e.g. `/pricing`).
2. **Add variants** — each variant has a `traffic_split` (%) and a `changes` array describing DOM edits.
3. **Set status to `running`.**
4. **The agency adds the snippet** to their site:
   ```html
   <script src="https://your-app.up.railway.app/snippet/ab.js"
           data-api="https://your-app.up.railway.app"></script>
   ```
5. On page load, the snippet asks the API which experiments apply to the current URL, picks a variant per visitor (sticky via `localStorage`), applies the DOM changes, and logs a `view` event. **Start the test when…** can instead wait until a CSS selector appears (for the whole visit, not the four-second element rule). The visitor is assigned, the variant is applied, and the view is sent only then. Visitors who never see the element are not counted. On a single-page app, a later address change is checked again: a test that newly matches is applied, and a test already applied on that page stays applied until the next full load. Add `data-spa="off"` to the snippet tag to keep that check on full loads only.
6. Add `goals` to a variant (see below) to track clicks as conversions.
7. **View results** on the dashboard by experiment ID.

## Finding your experiments again

The dashboard's **"Your Experiments"** section (right at the top, under the API key field) lists every experiment you've created — name, status, URL match, variant count, created date — pulled fresh from the database, so nothing needs to be written down or remembered. It loads automatically once you paste your API key, or click "Refresh List" any time. Each row has a **"Use ↓"** button that fills the Experiment ID into every section below it in one click, so you don't need to copy-paste IDs around manually.

## Change format (`changes` field on a variant)

Changes are authored in the visual editor (Preview & manage → 🎯 Make Edits) — you shouldn't need to hand-write this JSON. Documented here for reference / if you ever call the API directly:

```json
[
  { "selector": "#cta-button", "type": "text", "value": "Get Started Free" },
  { "selector": ".old-banner", "type": "hide" },
  { "selector": ".cta", "type": "style", "value": { "backgroundColor": "#1AB7C8" } },
  { "selector": "a.buy", "type": "attr", "attr": "href", "value": "/checkout-v2" },
  { "selector": "#signup-form", "type": "js", "value": "el.addEventListener('submit', () => console.log('tracked'));" },
  { "selector": "#hero", "type": "stylesheet", "value": "#hero { z-index: 999 !important; } #hero:hover { opacity: .8 !important; }" },
  { "selector": "#cta", "type": "replace", "value": "<a id=\"cta\" href=\"/buy\">Buy now</a>" },
  { "selector": "#price", "type": "insert_after", "value": "<p>Free shipping</p>" }
]
```

Supported `type` values: `text`, `html`, `hide`, `show`, `style`, `attr`, `js`, `remove`, `duplicate`, `insert_before`, `insert_after`, `replace`, `stylesheet`, `page_css`, `page_js`, `banner`.

- `html` replaces what's *inside* the element; `replace` swaps the *whole* element.
- `style` sets inline styles from an object. `stylesheet` is raw CSS text injected as its own `<style>` tag — it isn't tied to the matched element (the `selector` is kept for the Changes list's description), so it supports `!important`, `:hover`, media queries, and anything else a stylesheet does. Each `stylesheet` change gets its own tag, so a typo in one block can't break the others. (Named `stylesheet`, not `css`, deliberately: the old form used "css" as a UI label for inline styles.)
- `page_css` is CSS for the whole page. The snippet adds one `<style>` in the head and, if that change is applied again, updates the same tag instead of adding another. `page_js` is JavaScript for the whole page. It runs once per page view, not once per element, including when an SPA re-renders or the mutation observer applies other changes again. An error in `page_js` is caught so the rest of the page still runs. Neither type needs a selector. Element `html`, `stylesheet` and `js` are unchanged.
- `banner` is one bar for the page. It does not need a selector. The text, colours, top or bottom position, sticky flag and optional link are fields on the change. `countdown` is `none`, `midnight` (the next Europe/London midnight, including when the clocks change) or `fixed` with an `end` instant. The snippet keeps a single bar if the change is applied again or the page is re-rendered, and it adds padding so the bar does not cover the page. A viewport up to 640px wide uses a smaller type size.
- `remove` deletes the element from the DOM (unlike `hide`, which only sets `display:none`).

**On `js`** (and `html`, `replace`, `insert_*`, which can carry inline handlers): this runs exactly what you type, against the matched element, on the live page. There's no sandboxing — treat it like writing to the site directly, because that's what it is. Since only you (holder of `ADMIN_API_KEY`) can create variants, the risk is the same as any other code you'd deploy to that site; there's no path for a visitor to inject their own JS through this. Use it for genuinely custom behaviour the other types can't cover — most banner/button tests won't need it.

## Finding a selector for a click goal

The easiest way is the visual editor: **🎯 Make Edits → Select element → Set as goal** (see below) — no selector to find or type. The bookmarklet below is only for typing a selector into the dashboard's Add Goals form by hand. Drag its **"Selector Picker"** link to your bookmarks bar once. Then, on the page you are testing:

1. Click the bookmark
2. Click the element you want to target
3. Its selector is copied to your clipboard (and shown in a prompt as a fallback if clipboard access is blocked)
4. Paste it into the goal's Selector field on the dashboard

This is a standalone tool (`snippet/picker-bookmarklet.js`) — it's not part of the tracking snippet and doesn't get deployed to the sites you test.

## Goals (conversion tracking, optional per variant)

The dashboard has a "Goals" section alongside "Changes" when adding a variant, with two goal types:

- **Click on element** — fires when the visitor clicks anything matching the selector. Works on any element, not just `<button>` — a `div`, `span`, link, whatever you point it at.
- **Visited a URL** — fires when the visitor later loads any page whose URL contains the text you give (e.g. `/thank-you`). This works even though that page is completely different from the one the experiment's changes run on — the snippet checks every page load against every experiment you've ever been assigned to, not just the one currently "running" there. Each goal only ever counts once per visitor.

Any goal firing sends a `convert` event back to the API (distinct from the automatic `view` event). The results table counts these under "conversions" and calculates the rate as conversions ÷ visitors.

**Goals belong to each variant separately.** A visitor's snippet only tracks the goals of the variant they were assigned to, so a variant with no goal can never record a conversion — its rate reads 0% however it really performs. That includes the automatic Control, which starts with no goals. So every variant in an experiment needs the same goal (same label; the selector may differ if, say, a button was replaced). Preview & manage shows an amber warning whenever the active variants don't share the same goal labels, naming who has what. Goals made from the editor use a suggested label derived from the element (`cta_click`), which comes out the same on each variant if the element is the same.

## Reducing flicker

The "Copy Snippet" popover now shows two snippets, not one:

1. **In `<head>`** (new, optional but recommended) — a tiny inline snippet that hides the page the instant it starts loading, before the browser paints anything.
2. **Just before `</body>`** — the existing tracking snippet, unchanged.

Why two: true flicker prevention requires hiding the page before first paint, which only code running in `<head>` can do — by the time a script at the end of `<body>` runs, the browser has often already shown the original content for a moment. The `<head>` snippet hides the page via a CSS class, and `ab.js` removes that class the instant it's applied any DOM changes (or determined none apply) — normally well under a second. If something goes wrong (the API is slow or down), a 3-second timeout built into the `<head>` snippet reveals the page regardless, so a backend problem can never leave a visitor looking at a permanently blank page.

The trade-off: instead of a flash of the *original* content before it swaps to the variant, visitors see a brief blank page. That's the standard approach (Optimizely and Google Optimize both work the same way) — there's no way to show the final content instantly, since which variant to show depends on an API call that takes some non-zero time.

## Cookie / consent handling

The snippet writes to `localStorage` to recognize a visitor, which generally isn't "strictly necessary" for a site to function — it exists to support the A/B test — so under UK PECR and UK/EU GDPR it typically needs consent first, the same rule that governs analytics tools like GA4. This is worth checking with a lawyer or the site's data protection officer for a definitive answer on any given site; the general shape of the requirement is well-established, but I'm not able to certify compliance.

Before doing anything, the snippet checks for consent in this order:
1. A manual `window.pivitConsent = true/false` — set this yourself if a site uses a consent tool not covered below, or a custom banner
2. **Cookiebot** — checks `window.Cookiebot.consent.statistics`
3. **OneTrust** — checks `window.OnetrustActiveGroups` for the `C0002` (Performance Cookies) category, OneTrust's standard default template ID. A custom OneTrust template with different category IDs won't be caught by this — use the manual override instead
4. **CookieYes** — checks the `cookieyes-consent` cookie for `analytics:yes`

If **none** of the above are present at all, the snippet runs as it always has (unchanged behavior) — there's no consent signal to gate on, and whether that's appropriate is a call for whoever runs the site. If consent is denied (or not yet decided, for a CMP that's installed but hasn't recorded an answer), the snippet does nothing at all for that visitor — no localStorage write, no experiments fetched, no DOM changes applied, no events sent. They simply see the page as if the snippet weren't there. An authorised preview (a signed `ab_preview_token`) skips the consent check because it does not track. A preview parameter without a valid token does not.

## Running experiments across multiple sites

One deployment can still run experiments on many domains, and the snippet tag is the same on every site. `url_match` is unchanged: it is a substring check against the page URL the snippet already sends (`?url=`). You do not reinstall the snippet for this.

Each experiment also has one or more **site domains**. The server only returns that experiment when the page's host is one of those domains, after lower-casing and removing a port, a trailing dot, and a single leading `www.`. `shop.example.com` does not match `example.com` — list every host the test should run on. Set them in the create wizard (required to continue) or later under Settings. Starting or resuming an experiment with no domain is refused.

Experiments saved with an empty list are **not scoped**. `HOST_SCOPING=transition` (the default) still serves them, and logs them at startup and the first time each one is served for a host. Set `HOST_SCOPING=enforce` once every live experiment has a domain: unscoped experiments are then never served, and their events are dropped. An experiment that already has domains is strict in both modes.

Settings shows **Seen on since last deploy** — hosts that have asked for that experiment since the process started — so you can see what to add before you turn enforce on. The list is in memory and resets when the server restarts.

## Visual editor

"Preview & Manage Variants" has a **🎯 Make Edits** button per variant (needs the page URL filled in, same as Preview). Clicking it opens the real live page in a new tab with an in-page editing overlay active:

- The toolbar has a **Browse / Select** switch, and a line that says which mode is on. **Browse** lets clicks go to the site, so you can move through a checkout. **Select** picks an element. After a pick, the editor returns to Browse. **Whole page** and **Insert banner** do not need a selected element
- **Steps note** is a short reminder on the variant, such as "Click Continue twice". It is shown in the editor and in previews. Save writes it with the changes. The column is `variants.steps_note` (migration 020). An empty note is the default
- A quick-actions menu appears: **Edit element**, **Whole page**, **Add above**, **Add below**, **Duplicate**, **Remove**
- **Whole page** opens CSS and JS tabs for the page itself. CSS is saved as `page_css` (one style tag in the head, added once). JS is saved as `page_js` (once per page view, not once per element). An error in that JS is caught. Element HTML, CSS and JS stay on their own entries and are not rewritten by this panel
- **Insert banner** opens a short form: banner text, a countdown (none, UK midnight daily, or a fixed end time), background and text colours, top or bottom, sticky on or off, and an optional link. It saves one `banner` change. A sale bar such as "Sale ends in" counting down to UK midnight needs no code. Desktop, tablet and mobile preview run that saved bar inside the device frame
- **Edit element** opens a panel with **HTML / CSS / JS** tabs. HTML is pre-filled with the element's current markup (edit it, or paste new markup to replace it); CSS is pre-filled with a ready-made rule for the element; JS runs once with `el` set to the element. Only the parts you actually change are saved, each as its own entry (`replace`, `stylesheet`, `js`), applied in that order so your CSS and JS see the new markup. The CSS is plain page-wide CSS — add `!important` to override the site's own styles (this is the fix for "my inserted element is hidden behind something": set a `z-index`).
- **Set as goal** marks a click on the element as a conversion for this variant. If you pick the text or icon inside a button or link, the goal goes on the button/link itself (that's what visitors click). You choose a label (suggested for you); the Goals list in the toolbar shows and removes them. Goals are saved together with changes by the same **Save** button. URL ("visited a page") goals aren't element-based, so those are still added in the dashboard's Add Goals form — but they appear in the editor's Goals list too.
- **Add above / Add below** open a small HTML input — whatever you enter is inserted immediately so you see the result live
- **💾 Save** persists everything to that variant's `changes`, same data model the dashboard's own "Make Changes" step produces — this is a different way to author the same thing, not a separate system
- **Changes (N)** expands a list of every change on the variant, saved earlier or made this session, each described in plain English ("Duplicate #cta-button", "Insert HTML below #headline"). **Remove** is on every entry; **Edit** appears on the insert-HTML entries (the only type with a simple editable value so far) and reopens the HTML panel pre-filled
- The toolbar shows **● Unsaved changes** or **✓ All changes saved**, based on a comparison with what's actually on the server
- **Desktop / Tablet / Mobile** buttons open the live preview (`?ab_preview=` plus a signed token minted from the edit link) inside a device frame. The frame loads the page the same way a visitor does, so CSS, HTML and JavaScript changes all run, including element JavaScript, a banner, and whole-page CSS and JavaScript. Switching device or refreshing loads the page again and applies them again. The frame shows the last *saved* state — not unsaved edits still sitting in the current tab

**Why editing or removing an existing change can reload the page**: there's no generic way to reverse an arbitrary DOM mutation (an innerHTML overwrite or a removed node can't be reliably restored in place). On a single-page app, Edit or Remove on an existing entry offers **Apply without reloading** (run the change list again on this screen, so you stay on this step) and **Reload the page** (a clean replay, which goes back to the first step). The editor says so. A page with `data-spa="off"` still reloads straight away. The working list is kept in `sessionStorage` (per variant) across that reload, so unsaved work isn't lost; it's cleared on a successful Save, after which the editor loads from the server again. Adding a *new* change doesn't need a reload and applies live.

**Edit links on a single-page app**: the site may call `history.pushState` or `history.replaceState` and drop the query string. The snippet puts `ab_edit` and `token` back on that address, so the editor stays open. A preview address is not rewritten.

**Why a new tab, not an embedded frame**: the browser's same-origin policy blocks reading or modifying a cross-origin iframe's DOM entirely. Opening the real page directly means the tracking snippet already running there (`ab.js`) can hand off to the editor with full same-origin access — the same approach tools like Optimizely and VWO use.

**Authentication**: the new tab lives on the website's own domain, not `pivit.click`, so your normal login session (deliberately never sent cross-site) can't travel with it. Clicking "Make Edits" instead mints a signed, time-limited token scoped to that one variant (`src/edit-token.js`) — good for about an hour, useless for anything except saving changes to that specific variant. This is also what makes a future restricted viewer version of this feature straightforward: same mechanism, issued to a viewer instead of the Owner.

**Re-editing an element's HTML/CSS/JS**: click **Edit** on any of its `replace` / `stylesheet` / `js` entries in the Changes list — or just pick the element again and choose Edit element — and the same three-tab panel opens pre-filled with everything currently saved for that element. Change only the HTML and the CSS and JS entries are left exactly as they were; nothing is re-added. **Clear a tab to remove that part** (clearing HTML puts the page's original element back). Adding a part that didn't exist yet slots it into the right place (replace → stylesheet → js). Entries are matched by selector, one per type; if older data has look-alike duplicates, the tab for the entry you clicked edits that exact entry. Editing existing entries reloads the page onto a clean copy and replays (see above); creating a brand-new set applies live. If no HTML entry exists, the HTML tab shows the element's *live* markup — including the effect of any other changes you've made to it — and says so.

**Edit on other Changes-list entries** (`text`, `html`, `insert_before`, `insert_after`) opens a single-field panel pre-filled with the stored value. `remove`, `duplicate`, `hide`, `show` have no content to edit, and the older `style` / `attr` types don't fit a single text box — those are Remove-only (remove, then re-add the effect with CSS or JS).

**Things to know about the JS box**: it runs once per element matching the selector, with no sandboxing, on the real site — the same trust level as any code you'd deploy there. If you change an element's HTML so its id/classes no longer match the selector, the CSS and JS that target that selector won't find it; update the selector in the CSS, or keep the id.

**Owner-only for now**; a viewer rollout comes later, reusing the same token mechanism. One thing to settle before that: an edit link can save CSS/JS/HTML that runs for every real visitor of the site, so a viewer token should probably be restricted to a safer subset (e.g. text and CSS only) rather than carry the full power the Owner's does.

## The automatic Control variant

Creating an experiment also creates a **"Control"** variant automatically — no changes, 50% traffic — in the same atomic step (both inserts happen in one database transaction, so you never end up with an experiment and no Control if something goes wrong partway through). This means a single variant you add yourself is never your *only* variant; it's compared against an unmodified baseline by default, without having to remember to set one up.

If a given test genuinely doesn't need a Control (e.g. a 100%-traffic rollout), Control is just a variant like any other — pause, edit, or delete it from "Preview & Manage Variants" same as you would any variant.

## Previewing a variant

Use the **"Preview & Manage Variants"** section: enter the Experiment ID and the actual page URL you're testing on, click Load, then hit **Preview** on any variant. The server mints a signed link, `?ab_preview=<variant_id>&ab_preview_token=<token>`, because the preview opens on the customer's site and the login cookie is not sent there. The token lasts about an hour and is scoped to that variant. It works for a draft or paused experiment, and for a paused variant. Previewing never logs a view or a conversion, and it does not assign the visitor. A link with no token, or an expired token, does not serve draft or paused experiments — those stay hidden, and a running experiment on the same page behaves as a normal visit. Host scoping still applies: the page's domain has to be allowed.

## Pausing or deleting a variant

Same section as above:
- **Pause** stops a variant from being shown to new visitors but keeps all its recorded history — use this to stop a losing variant while still being able to look back at its numbers.
- **Delete** removes the variant permanently, including its recorded events (`ON DELETE CASCADE`). No undo — pause instead if you're not certain.

## Editing a variant

In Preview & manage, **Edit** takes you to the Create experiment page with that variant's name, traffic split and goals loaded into the "Add Variant" form, in edit mode (a red banner confirms this). It deliberately does **not** load or touch the variant's changes — those belong to the visual editor (🎯 Make Edits), and the server leaves a variant's changes alone when a save from this form omits them. (Earlier versions let this form edit changes too; it couldn't represent the visual editor's newer change types, so saving from it could silently corrupt or drop them.) Saving updates the existing variant instead of creating a new one — including for a variant that's currently live, so it takes effect for visitors immediately. There's no staged/draft version; if you want to test a change safely first, use Preview before saving, or pause the variant while you edit it. "Cancel edit" resets the form back to create-new mode.

## Reusing goals

The "Add Variant" section shows your 5 most-used goals as quick-pick buttons above the goals list — click one to add it to the current variant instead of retyping the selector or URL. Usage is tracked automatically every time you create or edit a variant with goals attached; no separate setup needed.

## Finding an experiment quickly

Every "Experiment" field is now a dropdown (Add Variant, Manage Variants, Status, Results) built from the same list as "Your Experiments" at the top — showing each one's name and status, not just a raw ID. Selecting an experiment in the Results or Manage Variants dropdown loads its data immediately; no extra click needed. The dropdowns refresh automatically whenever the list does (after creating an experiment, changing status, or clicking Refresh List).

## Data freshness

There's no caching or batch/polling delay anywhere — every view and conversion event is written to the database the instant it happens on a visitor's browser, and every "Load Results" click queries live. A **🔄 Refresh Results** button appears under the results table once you've loaded something, for a quick re-pull without scrolling back up.

## Exporting and deleting an experiment

Once an experiment is **archived**, "Your Experiments" shows two extra buttons on that row: **Export CSV** (every raw event — timestamp, type, variant, goal, visitor id, new/returning label, and `unique_conversion`) and **Delete** (permanent — removes the experiment, its variants, and all events; the server refuses this unless the experiment is archived, as a guard rail). `unique_conversion` is `1` on the first convert for that visitor, variant and goal, and `0` on repeats, so summing the column is the unique-converter count. Export first if you want to keep the data before deleting.

## New vs returning visitors

A visitor counts as **new** on the calendar day of their first-ever view of an experiment, and **returning** on any later day they come back — a second pageview in the same sitting (a refresh, browsing to another page and back) doesn't count as "returning," only an actual later visit does. The Results table shows both counts alongside the total, and the **Visitors** filter above it (All / New only / Returning only) restricts the table and bar chart to just that segment. The CSV export includes a `visitor_type` column with this same classification per event.



## Results & performance charts

The "View Results" section now draws two charts alongside the table: a bar chart of conversion rate per variant, and a line chart of cumulative visitors over time per variant, so you can see a trend rather than just a single snapshot.

## Sample Ratio Mismatch (SRM) check

Above the Bayesian panel in "View Results" is a Sample Ratio Check — a chi-square goodness-of-fit test comparing actual visitor counts per variant against what each variant's configured `traffic_split` would predict. If a 50/50 split is coming in at, say, 65/35, that's usually not normal random variance — it's a sign something is actually wrong (a bug in assignment, bot contamination skewing one variant, a caching or redirect issue), and it can fully explain an apparent "winner" on its own. When this fires, the message says so explicitly: treat the Bayesian numbers below it with caution until the mismatch is understood, regardless of how convincing they look.

The threshold (p < 0.01) is stricter than the usual 0.05, so ordinary noise stays quiet and a clearly uneven split is flagged. See `src/srm.js` for the statistical method (tested against known textbook chi-square critical values before being wired in).

If active variants' traffic splits don't sum to 100%, "Preview & Manage Variants" also shows a separate warning — not because anything breaks (every visitor still gets assigned to one of them; splits are used as relative weights, not literal percentages), but because the actual effective split then differs from what the raw numbers suggest at a glance. The warning shows you the real effective percentages.

## Basic bot / abuse filtering

`POST /api/event` — the endpoint every visitor's browser calls to log a view/conversion — now filters out obvious bots and scripted floods before anything reaches the database:

- **Known bot/crawler User-Agents** (Googlebot, AhrefsBot, SemrushBot, UptimeRobot, Pingdom, and similar) are silently ignored
- **A per-IP rate limit** (60 events/minute), stored in Postgres so a redeploy does not clear it and every instance shares it. A normal visit stays well under that. If the limiter cannot be checked, the event is still recorded.

Filtered requests still get a normal `204` response — nothing about what the caller sees reveals that filtering happened, and the live snippet is unchanged. This is heuristic protection, not a complete bot-detection system (nothing simple is), but it stops the obvious cases from quietly skewing results. See `src/bot-filter.js` and `src/rate-limit.js`.

## Bayesian analysis

Below the results table and charts is a "Bayesian Analysis" panel — the answer to "is this difference real, or just noise?" It models each variant's true (unknown) conversion rate as a distribution rather than a single number, using a standard Beta-Binomial approach, and shows:

- **Est. Rate (95% range)** — the likely true conversion rate and how wide the uncertainty around it still is. A wide range (e.g. 4%–64%) means "we genuinely don't know yet," not "the number is wrong."
- **Probability Best** — the chance that variant is actually the top performer, computed by simulating the posterior distributions against each other 20,000 times (see `src/bayesian.js` for the exact method). A 🏆 marks a variant at 90%+.

A low-traffic warning appears whenever any variant has under 30 visitors, since the estimate is still wide at that point and can swing a lot with the next handful of visitors. This panel loads automatically alongside the main results — no separate button. The viewer page shows a short one-sentence version of the same model instead of the full table.

## The trend chart

The line chart under the bar chart plots **conversion rate over time**, not raw visitor count, with a toggle between two modes. Both use unique converting visitors, so the rate does not go above 100%.

- **Cumulative** — running unique visitors and unique converters up to that day (not a sum of each day's uniques, which would count a returning visitor twice)
- **Daily** — that day's own unique visitors and the ones who also converted that day

Same chart, same toggle, on both the admin dashboard and the viewer page.

## Viewer credentials, on-page

Creating a viewer or resetting their password shows a persistent, copyable box on the page itself (username + password, with a "Copy both" button), since a dialog that disappears cannot be copied cleanly. The password itself is never stored in retrievable form — if you navigate away without copying it, reset it again from Team.

## Owner login

There's a real login screen now at `/login.html` (branded, matching the dashboard), backed by proper sessions instead of a key pasted into a field:

- Agency Owners and Members sign in with an emailed link or a 6-digit code. There is no agency password. Sign-up is invite-only. See [docs/signup.md](docs/signup.md).
- Day to day, the owner signs in by email at info@heclr.com (a link or a 6-digit code). The owner password is still the existing `ADMIN_API_KEY` value, and it stays available only as a fallback at the unlisted address `/owner` (not linked from the sign-in page). Do not rotate it.
- Sessions are signed cookies stored in Postgres (not memory), so a later redeploy does not clear them. The cookie is `pivit.sid` locally. In production it is `__Host-pivit.sid` (HttpOnly, Secure, SameSite=Lax). The first deploy of that name signs everyone out once, because the browser will not send the old `pivit.sid` cookie under the new name. Agency sessions idle out after 30 days and end 90 days after sign-in. Platform admin and emergency-password sessions last 12 hours and are not renewed. See [docs/signup.md](docs/signup.md).
- A required env var: `SESSION_SECRET` (see `.env.example`). It must be at least 32 characters. Any character set is accepted — it does not have to be hex or base64. When `NODE_ENV=production`, a missing or shorter secret aborts startup with a log line and the process does not boot. Outside production, a dev-only fallback is used and a warning is logged. Set the production value on the host before deploying, and do not rotate one that is already long enough.
- 5 failed password attempts locks that IP out for 60 seconds. The lockout is stored in Postgres, so a redeploy does not clear it. The reply is 429 with `Retry-After`.
- Every admin route now requires an active owner session; the old `x-api-key` header no longer does anything.

## Viewer sign-in

A second, separate sign-in exists for Viewers — read-only, scoped to only the experiments you've explicitly assigned them. The screen says Viewer. The address is still `/login.html?role=client`, and the page is still `/client.html`. The sign-in page calls this Viewer login.

- **Creating a viewer**: dashboard → **Team** → **Add a Viewer** (display name, username, password). Give them the sign-in address (`/login.html?role=client`), their username, and the password. The password is shown once. Home → **Viewers** can also create one, reset the password, or delete the login.
- **Assigning experiments**: the experiment list and Settings have a Viewer field — pick a viewer to give them access to that experiment's results, or leave it internal-only. This is manual, per-experiment, on purpose — there's no automatic assignment by domain or URL.
- **What viewers see**: their own page at `/client.html`, listing only their assigned experiments (grouped by URL), with results (table + charts) for whichever one they click. No creation, editing, variant management, goals, CSV export, or any other admin control — it's read-only.
- **Enforcement is server-side, not just hidden UI**: every viewer route under `/api/client` double-checks that the requested experiment's `client_id` actually matches the logged-in viewer's session before returning anything. A viewer can't see another viewer's data by guessing or editing an experiment ID.
- Deleting a viewer from Home → **Viewers** never deletes their experiments or results — it unassigns them. Suspending or archiving a Viewer is done from Team. A Platform admin can do the same from Users, and can delete them only after they are suspended or archived. See [docs/help.md](docs/help.md).

## Admin authentication

The public snippet endpoints (`GET /api/experiments`, `POST /api/event`, `GET /api/experiments/by-ids`) stay open on purpose — they're called from any visitor's browser and have no sensitive data to protect (just "which experiments run on this URL" and "log this event"). Those responses do not include the site-domain list. A public fetch is filtered by the page host (the `url` query, then `Origin`, then `Referer` — never this server's own hostname). `POST /api/event` checks that the variant belongs to the experiment, then drops the event with a normal 204 when the `Origin` or `Referer` host is known and not in the experiment's domains, and drops events for an experiment with no domains when `HOST_SCOPING=enforce`.

`GET /api/experiments/host-report` and `PATCH /api/experiments/:id/hosts` are owner-only. `GET /api/host-hits` is owner-only too: a daily rollup of hits to the snippet and the public API (`/snippet`, `GET /api/experiments`, `GET /api/experiments/by-ids`, `POST /api/event`), keyed by the request host and the customer-site origin. `/health` and `/robots.txt` are not counted. The counter is an upsert and never blocks or fails the request. The home page shows the last 30 days. Rows are kept until you delete them. Everything else requires an active session. An Owner or a Member uses the dashboard. A Viewer uses the viewer page. The session role is still `owner` or `client`, enforced per-route.

A conversion in results, the Bayesian panel, the viewer page, the trend chart and the CSV `unique_conversion` column is a unique visitor per variant (and per goal, when goals are listed separately). Repeat clicks stay visible on the owner results table as **Conversion events**. The rate uses the unique count, so it cannot exceed 100%. The Bayesian calculation itself is unchanged; it is only fed that unique count.

## Test traffic

QA and synthetic visitors can be flagged, left out of the numbers, and hidden without deleting them. Two live tests keep working: an event body without `is_test` is still a normal visitor, and `GET /health` is still `{ ok: true }`.

An event is test traffic when any of these is true:

- the visitor id starts with `v_pt` (the existing fake-traffic prefix, including `v_ptmuyez2tm_`)
- the JSON body has `"is_test": true` (also `1` or `"1"`)
- the request has `?pivit_qa=1`, or a `Referer` whose query has `pivit_qa=1`
- the request header `X-Pivit-Test` is `1`, `true`, or `yes`

**What the box tester should send.** On the customer site, open the page with `?pivit_qa=1` (for example `https://cantsaythat.co.uk/?pivit_qa=1`). The snippet stores that in `localStorage` under `pivit_qa` and in a first-party cookie `pivit_qa=1`. Later visits from that browser stay marked until the page is opened with `?pivit_qa=0`, which clears both. While the flag is on, each beacon is the usual JSON body plus `"is_test": true`, and the snippet’s own calls to `/api/experiments` add `pivit_qa=1`. The snippet does not send `X-Pivit-Test`. `navigator.sendBeacon` cannot set a request header, and today’s beacons must stay sendBeacon calls. A direct client that can set headers (curl, or the tester posting to `/api/event` itself) may send `X-Pivit-Test: 1` instead of the field. A visitor id starting with `v_pt` is enough on its own. A normal beacon omits `is_test`.

Example for a direct post:

```json
{ "experiment_id": "…", "variant_id": "…", "visitor_id": "v_pt…", "event_type": "view", "is_test": true }
```

Test traffic is excluded from the owner results table, the Bayesian inputs (the maths in `src/bayesian.js` are unchanged), the trend, the sample-ratio check, the viewer page, the CSV, and recent activity. The results tab has an owner-only **Include test traffic** control that puts it back. The viewer page ignores that flag. The Health panel shows how many test visitors there are and whether they are excluded.

**Remove test traffic** (owner only) previews the visitor and event counts per variant, then hides the matching rows by setting `excluded_at`. **Restore** clears it. Nothing is deleted. The same actions accept a visitor-id prefix, matched literally, so `v_ptmuyez2tm_` does not treat `_` as a wildcard. Every remove and restore is written to `test_traffic_audit` (who, when, experiment, criteria, counts), shown on the results tab. These routes are not on the viewer page. This change does not itself remove the synthetic `v_ptmuyez2tm_` visitors; the owner does that from the new control after deploy.

**Clear test traffic** on the results tab, including a demo test, hides every `pivit_qa`, `is_test` and `v_pt` visitor in one step. It is the same soft exclude, after a confirm step, and it writes an audit log entry. **Undo** restores that same set. Nothing is deleted. An agency Owner or a platform admin can do this. A Member cannot, and another agency's test is missing. `POST /api/experiments/:id/test-traffic/clear` with `{ "confirm": true }`.

`is_test` is added on startup if the column is missing. Existing rows whose visitor id starts with `v_pt` are flagged in the same startup pass. That update does not set `excluded_at`, and it is safe to run on every boot.

Snippet and public API hits from test traffic are not added to `host_hits` from now on. The script-tag request that loads `ab.js` can still be counted, because that request has already happened before the snippet can add `pivit_qa=1`. Two tester windows on 7 Oct 2026 are recorded in `host_hit_exclusions` and are not deleted: 12:22–12:24 UTC and 18:01–18:27 UTC, from `54.201.40.3`, origin `https://cantsaythat.co.uk`, host `pivitlab.com`. The daily totals already stored for that day are kept. The home page lists the windows.

## How a test is decided

A running test that has a plan shows health, progress and the traffic split until each variant has the planned visitors and the minimum runtime has passed. The verdict is then Win, Loss or Inconclusive, read once. Probability best stays a secondary detail after that, not a live call. The sum, the automatic plan, Reveal early, and the simulation results are in [docs/how-pivitlab-decides.md](docs/how-pivitlab-decides.md).

## What's NOT in v1 (by design)

- Viewers still sign in with a username and password. Email sign-in for Viewers is not built.
- 50/50-style manual splits only, no auto traffic allocation
- No multi-page funnels
- The fallback owner password cannot be reset inside pivitlab. It is whatever `ADMIN_API_KEY` is set to. An Owner resets a Viewer password from Team.

## Next steps to consider

- Support for multiple goals per variant with individual conversion rates
- Retiring the selector-picker bookmarklet: the editor now covers click goals, so it's only needed for hand-typing a selector into the dashboard form. URL goals could get an editor action too.
- An "also set this goal on the other variants" option in the editor. Left out deliberately for now: an edit token is scoped to one variant, and widening it to write to siblings (whose selectors may legitimately differ) is a bigger trust decision than it looks — the shared-goals warning covers the risk meanwhile.
- A real code editor (e.g. CodeMirror) in place of the plain textareas in the visual editor's panel
- Edit support in the Changes list for the older `style` / `attr` types (Remove-only today)
- A restricted, viewer-facing version of the visual editor, using the same scoped edit-token mechanism
- Synthetic demo data for show-and-tell purposes on low-traffic sites — scoped out for now to keep things simpler, worth revisiting later
