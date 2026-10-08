-- A/B Testing Platform — Schema v1

CREATE TABLE IF NOT EXISTS experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url_match TEXT NOT NULL,          -- substring or simple pattern the page URL must contain to run this experiment
  status TEXT NOT NULL DEFAULT 'draft', -- draft | running | paused | archived
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,               -- e.g. "control", "variant-b"
  traffic_split INTEGER NOT NULL DEFAULT 50, -- percentage weight, splits across variants should sum to 100
  changes JSONB NOT NULL DEFAULT '[]', -- array of DOM change instructions, see snippet/README for format
  goals JSONB NOT NULL DEFAULT '[]', -- array of {selector, id} — clicks on these fire a "convert" event
  enabled BOOLEAN NOT NULL DEFAULT true, -- false = paused: excluded from live traffic, but history is kept
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,         -- view | click | convert
  goal_id TEXT,                     -- optional label for which goal/selector was hit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_experiment ON events(experiment_id);
CREATE INDEX IF NOT EXISTS idx_events_variant ON events(variant_id);
CREATE INDEX IF NOT EXISTS idx_variants_experiment ON variants(experiment_id);

-- is_test: this event is QA / synthetic traffic. excluded_at: an owner hid it
-- (soft delete). Both are reversible. Never DELETE these rows from a migration.
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ;

-- Startup backfill. Existing v_pt rows (the fake-traffic tester prefix) become
-- is_test. Rows already flagged are left alone. excluded_at is not set, so
-- nothing is removed until an owner does it. Safe to re-run: the WHERE clause
-- matches zero rows once the backfill has caught up.
UPDATE events
SET is_test = true
WHERE is_test = false
  AND left(visitor_id, 4) = 'v_pt';

CREATE INDEX IF NOT EXISTS idx_events_experiment_test
  ON events (experiment_id)
  WHERE is_test OR excluded_at IS NOT NULL;

-- Additive migrations for columns added after the table already existed in production —
-- safe to re-run every startup, matching the CREATE TABLE IF NOT EXISTS pattern above.
ALTER TABLE variants ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

-- Tracks how often each distinct goal (type + selector/url_match + label) has been
-- used across all variants, so the dashboard can offer your most-used goals as
-- one-click quick-picks instead of retyping the same selector every time.
CREATE TABLE IF NOT EXISTS goal_templates (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,        -- 'click' or 'url'
  value TEXT NOT NULL,       -- the selector (click) or url_match text (url)
  label TEXT NOT NULL DEFAULT '', -- the goal's "id"/label field, e.g. "cta_click"
  usage_count INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, value, label)
);

-- Client accounts: read-only logins scoped to whichever experiments you manually
-- assign them (via experiments.client_id below). Not the same as the owner login —
-- clients have individual per-row credentials since there can be many of them.
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,             -- display name shown on their dashboard, e.g. "Can't Say That?"
  username TEXT NOT NULL UNIQUE,  -- login identifier, e.g. an email or a short slug
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive: which client (if any) an experiment belongs to. ON DELETE SET NULL —
-- deleting a client account never deletes their experiments/results, it just
-- un-assigns them back to owner-only.
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_experiments_client ON experiments(client_id);

-- Site domains this experiment may run on. Empty means not scoped yet:
-- HOST_SCOPING=transition (the default) still serves it; HOST_SCOPING=enforce does not.
-- A non-empty list is strict in both modes. www and the bare domain are stored the same.
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS allowed_hosts TEXT[] NOT NULL DEFAULT '{}';

-- Idempotent backfill from a full-URL url_match only. Path or substring matches stay
-- empty so a human chooses the domain. Rows that already have a domain are left alone,
-- and re-running this on startup does not overwrite them.
UPDATE experiments AS e
SET allowed_hosts = ARRAY[h.host]
FROM (
  SELECT id,
    regexp_replace(
      regexp_replace(
        lower(split_part(split_part(split_part(split_part(
          regexp_replace(btrim(url_match), '^[Hh][Tt][Tt][Pp][Ss]?://', ''),
        '/', 1), '?', 1), '#', 1), ':', 1)),
      '\.$', ''),
    '^www\.', '') AS host
  FROM experiments
  WHERE cardinality(allowed_hosts) = 0
    AND btrim(url_match) ~* '^https?://[^/\s]+'
) AS h
WHERE e.id = h.id
  AND h.host <> ''
  AND (h.host = 'localhost' OR h.host ~ '\.');

-- Daily rollup of hits to the snippet and the public API (not /health).
-- One row per UTC day, request host and customer-site origin. Rows are kept
-- until removed; the admin view reads the last 30 days.
CREATE TABLE IF NOT EXISTS host_hits (
  day DATE NOT NULL,
  host TEXT NOT NULL,
  referrer_origin TEXT NOT NULL DEFAULT '',
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, host, referrer_origin)
);

-- Goals live on the experiment and apply to every variant. id is stable and
-- is what events.goal_id stores; name is the label and can be renamed.
-- goals_scope = divergent means the variants were saved with different goals
-- and those per-variant lists are still the ones that run.
-- goals_migrated is set by the startup backfill (src/goals.js). New rows are
-- inserted with it already true. Existing rows start false and are migrated
-- once; identical goals are merged and keep the ids events already use.
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS goals JSONB NOT NULL DEFAULT '[]';
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS goals_scope TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS goals_migrated BOOLEAN NOT NULL DEFAULT false;

-- Windows of known tester traffic that were already rolled into host_hits.
-- The daily totals are kept (never deleted). New test hits are not counted.
-- These two rows are the 7 Oct 2026 box-tester runs against pivitlab.com.
CREATE TABLE IF NOT EXISTS host_hit_exclusions (
  id BIGSERIAL PRIMARY KEY,
  host TEXT NOT NULL,
  referrer_origin TEXT NOT NULL DEFAULT '',
  source_ip TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS host_hit_exclusions_window
  ON host_hit_exclusions (host, referrer_origin, started_at, ended_at);

INSERT INTO host_hit_exclusions (host, referrer_origin, source_ip, started_at, ended_at, note)
SELECT seed.host, seed.referrer_origin, seed.source_ip, seed.started_at, seed.ended_at, seed.note
FROM (VALUES
  (
    'pivitlab.com'::text,
    'https://cantsaythat.co.uk'::text,
    '54.201.40.3'::text,
    '2026-10-07T12:22:00Z'::timestamptz,
    '2026-10-07T12:24:00Z'::timestamptz,
    'Box tester run. The daily host_hits total for this day is kept and was not deleted. This window is excluded from the reading.'::text
  ),
  (
    'pivitlab.com',
    'https://cantsaythat.co.uk',
    '54.201.40.3',
    '2026-10-07T18:01:00Z'::timestamptz,
    '2026-10-07T18:27:00Z'::timestamptz,
    'Box tester run. The daily host_hits total for this day is kept and was not deleted. This window is excluded from the reading.'
  )
) AS seed(host, referrer_origin, source_ip, started_at, ended_at, note)
WHERE NOT EXISTS (
  SELECT 1 FROM host_hit_exclusions existing
  WHERE existing.host = seed.host
    AND existing.referrer_origin = seed.referrer_origin
    AND existing.started_at = seed.started_at
    AND existing.ended_at = seed.ended_at
);

-- Owner remove / restore of test traffic. One row per action. Counts are what
-- that action changed. The events themselves stay in the events table.
CREATE TABLE IF NOT EXISTS test_traffic_audit (
  id BIGSERIAL PRIMARY KEY,
  experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_ip TEXT,
  criteria JSONB NOT NULL,
  visitor_count INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  variant_counts JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_test_traffic_audit_experiment
  ON test_traffic_audit (experiment_id, created_at DESC);

-- Events the public endpoint dropped, per experiment per UTC day.
-- reason is rate_limited, bot, or host. Cheap upsert, same idea as host_hits.
-- A counter failure must not fail the request (see src/event-drops.js).
CREATE TABLE IF NOT EXISTS event_drops (
  day DATE NOT NULL,
  experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  drop_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, experiment_id, reason)
);

