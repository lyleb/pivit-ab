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

