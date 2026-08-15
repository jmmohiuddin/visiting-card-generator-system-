-- CARDWORKS migration 002 — presses as records, not a free-text string.
--
-- `orders.press` is today a text column holding whatever the order screen
-- happened to send, which means finish availability, lead time and price are
-- all typed in by whoever built that screen rather than derived from what a
-- press can actually do (Technical Design §10 item 4). These two tables are
-- the capability record that PRD §7 asks each press to fill in before launch,
-- and they are what `lib/quote-server.mjs` computes a quote from.
--
-- Re-runnable: every statement is guarded, so applying this twice is a no-op
-- rather than an error, and the seed below will not duplicate itself.

-- Identifiers come from dedicated sequences. db/schema.sql records why: an
-- identifier derived from a row count collided silently after ten rows, and
-- anywhere else an id is derived rather than sequence-generated is a latent
-- version of that same bug.
CREATE SEQUENCE IF NOT EXISTS presses_id_seq     START 100;
CREATE SEQUENCE IF NOT EXISTS price_rules_id_seq START 100;

CREATE TABLE IF NOT EXISTS presses (
  id                bigint      PRIMARY KEY DEFAULT nextval('presses_id_seq'),
  slug              text        NOT NULL UNIQUE,
  name              text        NOT NULL,
  -- What the press can produce. `finishes` is the only capability anyone has
  -- actually recorded; stock and format lists belong here too once a press
  -- has stated them, which is why this is a document and not seven columns.
  capabilities_json jsonb       NOT NULL DEFAULT '{"finishes":[]}'::jsonb
                    CHECK (jsonb_typeof(capabilities_json->'finishes') = 'array'),
  lead_days         int         NOT NULL CHECK (lead_days > 0),   -- working days, PRD §7
  min_qty           int         NOT NULL DEFAULT 100 CHECK (min_qty > 0),
  active            boolean     NOT NULL DEFAULT true,

  -- PRD §7 requires each press to state its colour profile or confirm it has
  -- none. A null `icc_profile` is ambiguous on its own — it cannot tell "the
  -- press confirmed it works untagged" apart from "nobody has asked yet" —
  -- so the answer itself is a column and the profile name is the detail.
  icc_profile       text,
  icc_status        text        NOT NULL DEFAULT 'unasked'
                    CHECK (icc_status IN ('confirmed','none_confirmed','unasked')),

  -- Plate/block setup, the flat charge before any per-card cost. Null means
  -- unquoted, which is not the same as free, so quotes must not treat it as 0
  -- silently — `lib/quote-server.mjs` reports it as an unpriced line instead.
  plate_setup_bdt   int         CHECK (plate_setup_bdt IS NULL OR plate_setup_bdt >= 0),

  -- The answer PRD §7 calls a stronger signal than the quoted price: will the
  -- press take a PDF/X-4 as it is, or will it "fix" the file in CorelDRAW
  -- first? A press that reopens and re-exports our file discards the outlined
  -- type, the spot separations and the trim geometry that the whole
  -- print-correct guarantee rests on, so this decides routing, not the price.
  pdfx4_stance      text        NOT NULL DEFAULT 'unasked'
                    CHECK (pdfx4_stance IN ('accepts_as_is','fixes_in_coreldraw','refuses','unasked')),

  -- Null until someone has physically visited or phoned this press. Every
  -- number above is a guess while this is null (PRD §8.1).
  verified_at       timestamptz,
  contact           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS presses_active_ix ON presses (active, lead_days);

-- Price history matters for the same reason order history does: a quote a
-- customer accepted was computed against the rule that was in force at that
-- moment, and rewriting that rule afterwards would make the pinned price
-- unexplainable. A rule is therefore superseded by closing `valid_to` and
-- inserting a new row, never by editing the old one.
CREATE TABLE IF NOT EXISTS price_rules (
  id         bigint      PRIMARY KEY DEFAULT nextval('price_rules_id_seq'),
  press_id   bigint      NOT NULL REFERENCES presses(id) ON DELETE RESTRICT,
  -- Two shapes, both read by lib/quote-server.mjs. `multiplier` scales the
  -- engine's placeholder cost model and is what the seed below carries;
  -- `tier` states real per-quantity prices from a written press quote and
  -- replaces the placeholder base outright. Replacing a guess with a real
  -- number is one INSERT of a `tier` rule with "validated": true — that is
  -- the whole migration path PRD §8.1 asks for.
  --   {"kind":"multiplier","value":0.92,"source":"…","validated":false}
  --   {"kind":"tier","currency":"BDT","tiers":{"100":600,"500":1300},
  --    "source":"written quote, 2026-09-01","validated":true}
  rule_json  jsonb       NOT NULL CHECK (rule_json ? 'kind'),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS price_rules_press_ix ON price_rules (press_id, valid_from DESC);
-- At most one open rule per press, so "the price now" is never ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS price_rules_open_key
  ON price_rules (press_id) WHERE valid_to IS NULL;

CREATE OR REPLACE FUNCTION price_rules_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'price_rules is append-only; supersede a rule by setting valid_to and inserting a new row';
  END IF;
  IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL
     OR NEW.press_id   IS DISTINCT FROM OLD.press_id
     OR NEW.rule_json  IS DISTINCT FROM OLD.rule_json
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
    RAISE EXCEPTION 'price_rules rows may only be closed, never edited; insert a superseding row instead';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS price_rules_immutable ON price_rules;
CREATE TRIGGER price_rules_immutable
  BEFORE UPDATE OR DELETE ON price_rules
  FOR EACH ROW EXECUTE FUNCTION price_rules_append_only();

-- ── orders points at a press record ──────────────────────────────────────
-- The text column stays as the historical label of what was ordered — an old
-- order must keep saying which press printed it even if that press is later
-- deactivated — but new orders resolve a real row. `quote_id` pins the quote
-- the customer accepted so the price they saw is the price they are charged.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS press_id bigint REFERENCES presses(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_id text;
CREATE INDEX IF NOT EXISTS orders_press_ix ON orders (press_id, created_at DESC);

UPDATE orders o SET press_id = p.id
  FROM presses p WHERE o.press_id IS NULL AND o.press = p.name;

-- ── Seed: the four Dhaka presses the order screen already names ──────────
-- Lifted verbatim from `const PRESSES` in assets/ui-shell.js so the records
-- and the screen agree on day one. Every number here is inherited from that
-- literal and none of it has been confirmed with the press itself, which is
-- exactly what `verified_at IS NULL`, `icc_status = 'unasked'` and
-- `pdfx4_stance = 'unasked'` are recording. PRD §8.1 makes filling these in a
-- precondition for showing a price to a customer, not a follow-up task.
INSERT INTO presses (slug, name, capabilities_json, lead_days, min_qty, active)
VALUES
  ('nilkhet-offset',      'Nilkhet Offset, Dhaka',
   '{"finishes":["matte","gloss","spotuv"]}'::jsonb,                             3, 100, true),
  ('fakirapool-press',    'Fakirapool Press, Motijheel',
   '{"finishes":["matte","gloss","spotuv","foil"]}'::jsonb,                      4, 100, true),
  ('banglabazar-printers','Banglabazar Printers',
   '{"finishes":["matte","gloss","foil","emboss"]}'::jsonb,                      5, 100, true),
  ('arambagh-fine-print', 'Arambagh Fine Print',
   '{"finishes":["matte","gloss","softtouch","spotuv","foil","emboss"]}'::jsonb, 7, 100, true)
ON CONFLICT (slug) DO NOTHING;

-- The multipliers the order screen applies today, recorded as what they are:
-- unvalidated placeholders scaling an unvalidated base cost.
INSERT INTO price_rules (press_id, rule_json)
SELECT p.id, jsonb_build_object(
         'kind', 'multiplier', 'value', v.mult, 'validated', false,
         'source', 'assets/ui-shell.js PRESSES literal — no press has been contacted',
         'replaces_with', 'a tier rule carrying a written quote per PRD §8.1')
FROM (VALUES
        ('nilkhet-offset',       0.92),
        ('fakirapool-press',     1.00),
        ('banglabazar-printers', 1.04),
        ('arambagh-fine-print',  1.18)
     ) AS v(slug, mult)
JOIN presses p ON p.slug = v.slug
WHERE NOT EXISTS (
  SELECT 1 FROM price_rules r WHERE r.press_id = p.id AND r.valid_to IS NULL);
