-- CARDWORKS — schema for what the deployed site actually exercises.
-- This is the subset of blueprint §8 that real traffic touches today:
-- immutable, content-addressed design specs plus the short-link resolver
-- the QR fallback needs. Orgs, memberships, orders and press tables are
-- specified in §8 and deliberately NOT created until there is code using them.

CREATE TABLE IF NOT EXISTS design_specs (
  id             bigserial PRIMARY KEY,
  spec_hash      text        NOT NULL,
  short_code     text        NOT NULL,
  spec_json      jsonb       NOT NULL,
  parent_spec_id bigint      REFERENCES design_specs(id),
  label          text,
  engine_version text        NOT NULL DEFAULT 'ref-1',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Identity IS the content: the same design saved twice is one row.
CREATE UNIQUE INDEX IF NOT EXISTS design_specs_hash_key  ON design_specs (spec_hash);
CREATE UNIQUE INDEX IF NOT EXISTS design_specs_short_key ON design_specs (short_code);
CREATE INDEX        IF NOT EXISTS design_specs_parent_ix ON design_specs (parent_spec_id);

-- Append-only: a spec is never updated. An edit inserts a child row, which
-- is what gives versioning, forking and rollback for free (§8).
CREATE OR REPLACE FUNCTION design_specs_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'design_specs is append-only; insert a child row with parent_spec_id instead';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS design_specs_immutable ON design_specs;
CREATE TRIGGER design_specs_immutable
  BEFORE UPDATE OR DELETE ON design_specs
  FOR EACH ROW EXECUTE FUNCTION design_specs_no_update();

CREATE TABLE IF NOT EXISTS preflight_reports (
  id          bigserial PRIMARY KEY,
  spec_hash   text        NOT NULL,
  status      text        NOT NULL CHECK (status IN ('pass','advisory','blocked')),
  blocking    int         NOT NULL DEFAULT 0,
  advisory    int         NOT NULL DEFAULT 0,
  findings    jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS preflight_hash_ix ON preflight_reports (spec_hash);

-- Scan + save metering. This is the loop that tells you whether a card works
-- (blueprint §16) — the QR is ours, so a scan is measurable.
CREATE TABLE IF NOT EXISTS usage_events (
  id         bigserial PRIMARY KEY,
  type       text        NOT NULL,
  short_code text,
  meta       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_type_ix ON usage_events (type, created_at DESC);
