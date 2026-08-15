-- CARDWORKS — payments (Technical Design §5.2, PRD §6 Epic F).
--
-- Money is the one place in this codebase where a lost write is not a bug you
-- can fix by re-running the request: the customer has already been debited at
-- bKash or Nagad. So this migration encodes the two guarantees the application
-- must not be trusted to keep on its own — that an order can be captured at
-- most once, and that the history of what was attempted is never overwritten.
--
-- Both patterns are lifted straight from db/schema.sql, which got them right:
-- append-only enforced by a Postgres trigger rather than by every caller
-- remembering, and identifiers taken from a dedicated sequence rather than
-- derived from a row count. That schema's own comment records what the derived
-- version cost — ten consecutive orders collapsed onto one reference and the
-- second insert failed on the unique index. A payment reference derived the
-- same way would collide the same way, except the collision would be a
-- customer's money attached to somebody else's order.

-- Amounts are integer taka, the same unit and type as orders.subtotal and
-- orders.total, so a payment and the order it settles can be compared without
-- a conversion that someone eventually gets backwards. The providers want a
-- two-decimal string; that formatting happens at the edge, in lib/payments.
CREATE TABLE IF NOT EXISTS payments (
  id            bigserial   PRIMARY KEY,
  ref           text        NOT NULL UNIQUE,
  order_ref     text        NOT NULL REFERENCES orders(ref) ON DELETE RESTRICT,
  provider      text        NOT NULL CHECK (provider IN ('bkash','nagad','cod')),
  provider_ref  text,
  provider_txn  text,
  amount        int         NOT NULL CHECK (amount > 0),
  currency      text        NOT NULL DEFAULT 'BDT',
  status        text        NOT NULL DEFAULT 'intent'
                CHECK (status IN ('intent','captured','failed','cancelled',
                                  'partially_refunded','refunded')),
  -- The caller's idempotency key, scoped to the order. Two attempts carrying
  -- the same key are the same attempt; the unique index below is what makes
  -- that true even when the two arrive on different function instances at the
  -- same moment, which is exactly when application-level checks lose.
  capture_key   text        NOT NULL,
  refunded      int         NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  failure_code  text,
  simulated     boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Payment references come from their own sequence, for the reason recorded at
-- the top of this file and in db/schema.sql.
CREATE SEQUENCE IF NOT EXISTS payments_ref_seq START 1000;
ALTER TABLE payments ALTER COLUMN ref
  SET DEFAULT 'PAY-' || lpad(nextval('payments_ref_seq')::text, 6, '0');

-- A retried capture is the same capture. Retrying with the caller's key finds
-- this row instead of opening a second one.
CREATE UNIQUE INDEX IF NOT EXISTS payments_capture_key_ix
  ON payments (order_ref, capture_key);

-- The hard stop against double-charging: an order may hold at most one payment
-- that ever took money. A second capture racing the first loses here, in the
-- database, and the loser becomes a reconciliation incident and an automatic
-- refund rather than a silent second debit.
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_capture_per_order_ix
  ON payments (order_ref)
  WHERE status IN ('captured','partially_refunded','refunded');

CREATE INDEX IF NOT EXISTS payments_order_ix    ON payments (order_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_provider_ix ON payments (provider, provider_ref);

-- What a payment row is allowed to become, enforced where it cannot be
-- forgotten. The immutable columns are frozen here too: an UPDATE that moves
-- an amount or repoints an order is not a state change, it is a rewrite of
-- what was charged, and no endpoint should be able to do it by accident.
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments is not deletable; cancel or refund the payment instead';
  END IF;
  IF NEW.ref <> OLD.ref OR NEW.order_ref <> OLD.order_ref
     OR NEW.provider <> OLD.provider OR NEW.amount <> OLD.amount
     OR NEW.currency <> OLD.currency OR NEW.capture_key <> OLD.capture_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a payment''s reference, order, provider, amount and key are fixed at creation';
  END IF;
  IF NEW.refunded > NEW.amount THEN
    RAISE EXCEPTION 'refunded % exceeds the captured amount %', NEW.refunded, NEW.amount;
  END IF;
  IF NEW.refunded < OLD.refunded THEN
    RAISE EXCEPTION 'refunded total cannot decrease';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
       (OLD.status = 'intent'             AND NEW.status IN ('captured','failed','cancelled')) OR
       (OLD.status = 'captured'           AND NEW.status IN ('partially_refunded','refunded')) OR
       (OLD.status = 'partially_refunded' AND NEW.status = 'refunded')
     ) THEN
    RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_guarded ON payments;
CREATE TRIGGER payments_guarded
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard();

-- Append-only ledger, the same shape and the same reasoning as order_events:
-- the record of what was asked of a provider and what it answered is evidence
-- in a dispute, so nothing may edit it after the fact.
CREATE TABLE IF NOT EXISTS payment_events (
  id         bigserial   PRIMARY KEY,
  payment_id bigint      REFERENCES payments(id) ON DELETE RESTRICT,
  order_ref  text        NOT NULL,
  type       text        NOT NULL,
  actor      text        NOT NULL DEFAULT 'system',
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_events_order_ix   ON payment_events (order_ref, created_at);
CREATE INDEX IF NOT EXISTS payment_events_payment_ix ON payment_events (payment_id, created_at);

CREATE OR REPLACE FUNCTION payment_events_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_events is append-only; record a new event instead';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_events_immutable ON payment_events;
CREATE TRIGGER payment_events_immutable
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION payment_events_no_update();

-- Refunds are their own rows because a refund is its own money movement with
-- its own provider reference, and because an automatic refund issued during
-- reconciliation must be idempotent for the same reason a capture must be.
CREATE TABLE IF NOT EXISTS refunds (
  id           bigserial   PRIMARY KEY,
  ref          text        NOT NULL UNIQUE,
  payment_id   bigint      NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  order_ref    text        NOT NULL,
  provider     text        NOT NULL,
  provider_ref text,
  amount       int         NOT NULL CHECK (amount > 0),
  reason       text        NOT NULL,
  refund_key   text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','refunded','failed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS refunds_ref_seq START 1000;
ALTER TABLE refunds ALTER COLUMN ref
  SET DEFAULT 'RFD-' || lpad(nextval('refunds_ref_seq')::text, 6, '0');

CREATE UNIQUE INDEX IF NOT EXISTS refunds_key_ix ON refunds (payment_id, refund_key);
CREATE INDEX        IF NOT EXISTS refunds_order_ix ON refunds (order_ref, created_at DESC);

-- Reconciliation, per PRD §12: a payment that succeeded at the provider but
-- failed to record here, or recorded here but did not succeed there, is not
-- allowed to be a silent mismatch. It becomes a row somebody has to close.
-- Resolution is a second row, not an edit, so the table stays append-only and
-- the original claim survives whatever was later decided about it.
CREATE TABLE IF NOT EXISTS payment_incidents (
  id         bigserial   PRIMARY KEY,
  ref        text        NOT NULL UNIQUE,
  order_ref  text        NOT NULL,
  payment_id bigint      REFERENCES payments(id) ON DELETE RESTRICT,
  kind       text        NOT NULL,
  severity   text        NOT NULL DEFAULT 'critical'
             CHECK (severity IN ('critical','warning','resolved')),
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  resolves   bigint      REFERENCES payment_incidents(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS payment_incidents_ref_seq START 1;
ALTER TABLE payment_incidents ALTER COLUMN ref
  SET DEFAULT 'INC-' || lpad(nextval('payment_incidents_ref_seq')::text, 6, '0');

CREATE INDEX IF NOT EXISTS payment_incidents_open_ix
  ON payment_incidents (created_at DESC) WHERE severity <> 'resolved';
CREATE INDEX IF NOT EXISTS payment_incidents_order_ix ON payment_incidents (order_ref, created_at);

CREATE OR REPLACE FUNCTION payment_incidents_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_incidents is append-only; insert a resolving row with resolves set instead';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_incidents_immutable ON payment_incidents;
CREATE TRIGGER payment_incidents_immutable
  BEFORE UPDATE OR DELETE ON payment_incidents
  FOR EACH ROW EXECUTE FUNCTION payment_incidents_no_update();
