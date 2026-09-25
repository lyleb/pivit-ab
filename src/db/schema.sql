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
