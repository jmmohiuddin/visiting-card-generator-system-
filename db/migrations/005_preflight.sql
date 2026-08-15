-- Server-side preflight — the audit trail behind the print-correct guarantee.
--
-- `preflight_reports` already exists in db/schema.sql, from when preflight was
-- a client-side check whose result was merely recorded. Now that the server
-- runs the check itself and refuses orders on it (Technical Design §10 item
-- 3), a report has to say which engine produced it and which saved design it
-- belongs to — without those two columns a stored report cannot be reproduced,
-- and a report that cannot be reproduced is not evidence.
--
-- Note that `preflight_reports.spec_hash` is the hash of the preflight
-- SUBJECT — the design, content, finishes and share link, and nothing else —
-- not `design_specs.spec_hash`, which covers the whole session snapshot down
-- to which screen the customer was on. The subject hash is what stays equal
-- between an unsaved design on the validate screen and the same design after
-- it is saved, which is what makes an acceptance survive the save.

ALTER TABLE preflight_reports ADD COLUMN IF NOT EXISTS short_code     text;
ALTER TABLE preflight_reports ADD COLUMN IF NOT EXISTS engine_version text NOT NULL DEFAULT 'ref-1';
CREATE INDEX IF NOT EXISTS preflight_reports_code_ix ON preflight_reports (short_code, created_at DESC);

-- Advisory acceptance (Technical Design §6.3).
--
-- An advisory finding is allowed through only when a named person accepted it
-- at a known time. This table is that record, and its whole reason for
-- existing is the sentence in §6.3: it is the product's defence if a customer
-- disputes a completed run. A dispute is decided by what the customer was
-- shown and agreed to, so `finding_label` stores the sentence itself rather
-- than a reference to it — the engine may reword a check later, and the
-- defence must not quietly change wording along with it.
--
-- `engine_version` is part of the key for the same reason: consent was given
-- to the checks that engine ran. A new engine produces a new report, and the
-- customer accepts again.
CREATE TABLE IF NOT EXISTS preflight_acceptances (
  id             bigserial PRIMARY KEY,
  spec_hash      text        NOT NULL,
  engine_version text        NOT NULL,
  finding_id     text        NOT NULL,
  finding_code   text,
  finding_label  text        NOT NULL,
  face           text,
  accepted_by    text        NOT NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  note           text,
  order_ref      text        REFERENCES orders(ref) ON DELETE SET NULL
);

-- One acceptance per person per finding per design. A customer clicking
-- "accept" twice is not two acceptances, and a retried request must not
-- become a second row in the evidence.
CREATE UNIQUE INDEX IF NOT EXISTS preflight_acceptances_key
  ON preflight_acceptances (spec_hash, engine_version, finding_id, accepted_by);
CREATE INDEX IF NOT EXISTS preflight_acceptances_order_ix ON preflight_acceptances (order_ref);

-- Evidence is append-only, with exactly one exception: an acceptance is made
-- before the order exists, so the order reference is attached afterwards. That
-- attachment is allowed once, on a row where it is still null, and nothing
-- else about the row may move. Anything more permissive and the record stops
-- being able to settle an argument.
CREATE OR REPLACE FUNCTION preflight_acceptances_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'preflight_acceptances is append-only; an acceptance cannot be deleted';
  END IF;
  IF (NEW.id, NEW.spec_hash, NEW.engine_version, NEW.finding_id, NEW.finding_code,
      NEW.finding_label, NEW.face, NEW.accepted_by, NEW.accepted_at, NEW.note)
     IS DISTINCT FROM
     (OLD.id, OLD.spec_hash, OLD.engine_version, OLD.finding_id, OLD.finding_code,
      OLD.finding_label, OLD.face, OLD.accepted_by, OLD.accepted_at, OLD.note) THEN
    RAISE EXCEPTION 'preflight_acceptances is append-only; attach the order reference and nothing else';
  END IF;
  IF OLD.order_ref IS NOT NULL OR NEW.order_ref IS NULL THEN
    RAISE EXCEPTION 'preflight_acceptances is append-only; only a null order_ref may be set, once';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS preflight_acceptances_immutable ON preflight_acceptances;
CREATE TRIGGER preflight_acceptances_immutable
  BEFORE UPDATE OR DELETE ON preflight_acceptances
  FOR EACH ROW EXECUTE FUNCTION preflight_acceptances_guard();
