-- 008 — entitlements (Master PRD §9).
--
-- §9 defines the free tier precisely: unlimited briefs, six concepts,
-- watermarked previews, no export, no order. Everything up to that point was
-- described on the pricing screen and enforced nowhere, so every visitor got
-- the press file for nothing. These tables are the record that decides
-- otherwise.
--
-- The shape is the argument. §9 rejects a subscription for this market — an
-- individual buys cards about once every eighteen months, and bKash and Nagad
-- are built for one-off pushes rather than silent monthly pulls — and its
-- pricing principle is to charge at the moment of realised value and never for
-- access to the tool. A boolean on `users` saying "may export" would be the
-- subscription shape wearing different clothes: it grants access, unbounded,
-- to designs nobody paid for. What a customer buys is *this design's file*, so
-- the row is keyed on the spec hash, which is already the immutable name of a
-- design everywhere else in this schema.
--
-- Re-runnable, like db/schema.sql and every migration before this one: every
-- object is IF NOT EXISTS, every identifier comes from a sequence rather than
-- from a row count, and what must never be rewritten is enforced by a trigger
-- instead of by every caller remembering.

CREATE TABLE IF NOT EXISTS entitlements (
  id         bigserial   PRIMARY KEY,
  ref        text        NOT NULL UNIQUE,
  kind       text        NOT NULL CHECK (kind IN ('file_pack','print_order','shop_channel','comp')),

  -- What was bought. Not a user flag: the same content address `design_specs`
  -- and the render cache already use, so an entitlement names exactly the card
  -- the customer paid for and no other.
  spec_hash  text        NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{8,64}$'),

  -- Who holds it. An account when there is one, and the anonymous browser key
  -- otherwise, because PRD §3.2 requires that no signup stands between someone
  -- and a card — a customer may pay by bKash having never signed in. Signing
  -- in later carries the key onto the account through `owner_claims`, exactly
  -- as designs and orders are carried (migration 004).
  user_id    bigint      REFERENCES users(id) ON DELETE RESTRICT,
  owner_key  text,

  source     text        NOT NULL CHECK (source IN ('payment','staff','shop')),
  source_ref text        NOT NULL,
  amount     int         CHECK (amount IS NULL OR amount >= 0),
  currency   text        NOT NULL DEFAULT 'BDT',
  note       text,
  granted_at timestamptz NOT NULL DEFAULT now()
);

-- An entitlement nobody holds is not an entitlement, it is a leak: the read
-- path matches on the holder, and a row with neither column set would match
-- any caller who supplied neither.
ALTER TABLE entitlements DROP CONSTRAINT IF EXISTS entitlements_has_holder;
ALTER TABLE entitlements ADD  CONSTRAINT entitlements_has_holder
  CHECK (user_id IS NOT NULL OR owner_key IS NOT NULL);

-- The same shape lib/http.mjs and migration 004 require of a browser key, so a
-- key that could never have owned a design cannot hold an entitlement either.
ALTER TABLE entitlements DROP CONSTRAINT IF EXISTS entitlements_owner_key_shape;
ALTER TABLE entitlements ADD  CONSTRAINT entitlements_owner_key_shape
  CHECK (owner_key IS NULL OR owner_key ~ '^[A-Za-z0-9_-]{8,64}$');

CREATE SEQUENCE IF NOT EXISTS entitlements_ref_seq START 1000;
ALTER TABLE entitlements ALTER COLUMN ref
  SET DEFAULT 'ENT-' || lpad(nextval('entitlements_ref_seq')::text, 6, '0');

-- One payment grants one entitlement per design, however many times the
-- capture is replayed or reconciled. This index is what makes
-- `grantFromPayment`'s single INSERT … SELECT safe under concurrency: two
-- requests racing the same capture do not both write a grant, the loser's
-- ON CONFLICT DO NOTHING makes it a no-op, and neither has to have read first.
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_source_ix
  ON entitlements (source, source_ref, spec_hash);

-- The read path: this design, this holder. Two partial indexes rather than one
-- composite, because a holder is one or the other and a NULL in a composite
-- key indexes nothing useful.
CREATE INDEX IF NOT EXISTS entitlements_user_ix
  ON entitlements (spec_hash, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entitlements_owner_ix
  ON entitlements (spec_hash, owner_key) WHERE owner_key IS NOT NULL;

-- Append-only, by trigger. What a customer was granted, when, and against
-- which payment is the answer to "why does this person have the file", and a
-- support fix that edited it in place would destroy the only evidence there
-- is. Withdrawal is a revocation row below, never an UPDATE here — the same
-- reasoning db/schema.sql gives for design specs and 003 gives for payments.
CREATE OR REPLACE FUNCTION entitlements_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'entitlements is append-only; insert a row in entitlement_revocations instead';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entitlements_immutable ON entitlements;
CREATE TRIGGER entitlements_immutable
  BEFORE UPDATE OR DELETE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION entitlements_no_update();

-- ── Withdrawal ────────────────────────────────────────────────────────────
-- A refunded file pack is a file pack the customer no longer holds, and a
-- support grant made in error has to be reversible. Both are a second row, so
-- the original claim survives whatever was later decided about it.

CREATE TABLE IF NOT EXISTS entitlement_revocations (
  id             bigserial   PRIMARY KEY,
  entitlement_id bigint      NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
  reason         text        NOT NULL,
  source_ref     text,
  revoked_at     timestamptz NOT NULL DEFAULT now()
);

-- Revoking twice is revoking once. The reconciliation sweep that issues an
-- automatic refund may run more than once against the same payment, for the
-- same reason a capture may.
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_revocations_once_ix
  ON entitlement_revocations (entitlement_id);

CREATE OR REPLACE FUNCTION entitlement_revocations_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'entitlement_revocations is append-only; a mistaken revocation is a new grant, not an edit';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entitlement_revocations_immutable ON entitlement_revocations;
CREATE TRIGGER entitlement_revocations_immutable
  BEFORE UPDATE OR DELETE ON entitlement_revocations
  FOR EACH ROW EXECUTE FUNCTION entitlement_revocations_no_update();
