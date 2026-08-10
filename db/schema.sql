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

-- ── Added when the Order, Tracking and My-designs screens were built ──────
-- These tables exist because there is now code using them. Orders carry the
-- proof-before-charge flow the prototype designed: the run does not start,
-- and nothing is charged, until the customer has held a printed proof.

ALTER TABLE design_specs ADD COLUMN IF NOT EXISTS owner_key text;
CREATE INDEX IF NOT EXISTS design_specs_owner_ix ON design_specs (owner_key, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id          bigserial PRIMARY KEY,
  ref         text        NOT NULL UNIQUE,
  owner_key   text,
  short_code  text        NOT NULL,
  qty         int         NOT NULL CHECK (qty > 0),
  press       text        NOT NULL,
  finishes    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  zone        text        NOT NULL DEFAULT 'dhaka',
  currency    text        NOT NULL DEFAULT 'BDT',
  subtotal    int         NOT NULL,
  total       int         NOT NULL,
  status      text        NOT NULL DEFAULT 'files_locked'
              CHECK (status IN ('files_locked','at_press','proof_printed','proof_delivered',
                                'awaiting_approval','printing','delivered','cancelled')),
  recipient   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_owner_ix ON orders (owner_key, created_at DESC);

-- Append-only event log. The order's status is derived from it, so the
-- history of who approved what and when is never overwritten.
CREATE TABLE IF NOT EXISTS order_events (
  id         bigserial PRIMARY KEY,
  order_ref  text        NOT NULL REFERENCES orders(ref) ON DELETE CASCADE,
  type       text        NOT NULL,
  actor      text        NOT NULL DEFAULT 'system',
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_ref_ix ON order_events (order_ref, created_at);

-- Order references come from their own sequence. Deriving them from a row
-- count and then truncating to a fixed width collides silently: ten
-- consecutive orders produced the same reference and the second one failed
-- on the unique index. A sequence is also race-safe under concurrency.
CREATE SEQUENCE IF NOT EXISTS orders_ref_seq START 2200;
ALTER TABLE orders ALTER COLUMN ref
  SET DEFAULT 'ORD-' || lpad(nextval('orders_ref_seq')::text, 5, '0');
