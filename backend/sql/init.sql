-- =============================================================================
-- init.sql
--
-- Safe to re-run at any time.
-- regions_metrics and poi_layers are always dropped and recreated so the
-- schema is guaranteed to match the code. No manual psql fixes ever needed.
-- scoring_weights is preserved across runs (DROP ... IF EXISTS + INSERT ON
-- CONFLICT DO NOTHING) so any weight tweaks you've made are kept.
-- =============================================================================


-- =============================================================================
-- regions_metrics
-- Raw census + business data only.
-- Normalization and scoring happen at request time in server.js.
-- =============================================================================
DROP TABLE IF EXISTS regions_metrics;

CREATE TABLE regions_metrics (
  fips               TEXT             PRIMARY KEY,
  population       DOUBLE PRECISION NOT NULL,
  median_income    DOUBLE PRECISION NOT NULL,
  business_count   DOUBLE PRECISION NOT NULL,
  transit_agencies DOUBLE PRECISION NOT NULL DEFAULT 0
  -- Scores computed dynamically in server.js (incl. transit density per 100k residents).
);

-- =============================================================================
-- poi_layers
-- GeoJSON blobs for each infrastructure layer (airports, ports, rail, etc.)
-- =============================================================================
DROP TABLE IF EXISTS poi_layers;

CREATE TABLE poi_layers (
  layer_key  TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- scoring_weights
-- Single source of truth for Opportunity Score weights.
-- NOT dropped on re-run so manual weight changes survive a reload.
-- metric_name must match the keys used in server.js / db.js fallbacks.
-- =============================================================================
CREATE TABLE IF NOT EXISTS scoring_weights (
  metric_name TEXT             PRIMARY KEY,
  weight      DOUBLE PRECISION NOT NULL CHECK (weight >= 0)
);

-- Seed default weights (existing DBs keep prior rows; new metric added separately).
INSERT INTO scoring_weights (metric_name, weight) VALUES
  ('population',       0.30),
  ('median_income',    0.30),
  ('business_count',   0.30),
  ('transit_density',  0.10)
ON CONFLICT (metric_name) DO NOTHING;
