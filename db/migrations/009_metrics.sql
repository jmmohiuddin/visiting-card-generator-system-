-- The numbers §5.3 and §10 are written in, made recordable.
--
-- Master PRD §10 names Print-Correct Rate the north star and subordinates
-- every other requirement to it, and §5.3 turns the MVP exit decision — build
-- V2 or stop — into six numbers. None of the six could be computed before
-- this migration. `usage_events` counts design saves, loads, scans, vCard
-- downloads and signups, which is the loop blueprint §16 asked for and is a
-- different question entirely: it says how a finished card performs in the
-- world, not whether a brief became a concept, how long that took, or whether
-- the paper that arrived was correct.
--
-- ── Why a table beside `usage_events` rather than five more of its types ──
--
-- Three reasons, and the second is the one that decides it.
--
-- `usage_events` has no correlation column. Every one of its five types is
-- about a saved design and carries `short_code`, but a brief has no short
-- code — nothing is saved until the customer likes something — so the two
-- events that bracket the funnel, "a brief was started" and "a concept was
-- seen", have nothing to join on there. §5.3's ≥40% and its median
-- brief-to-export are both joins across that gap, so the correlation key is
-- not an optional extra column: it is the whole measurement.
--
-- The event names here are a closed set, checked by the database. A funnel
-- computed over a vocabulary that anything may add to is a funnel that dilutes
-- silently — one endpoint emitting `brief.start` instead of `brief.started`
-- moves the denominator and nothing fails. `usage_events.type` is deliberately
-- open, and it should stay that way for what it does.
--
-- And these rows are append-only, enforced below by a trigger for the same
-- reason `design_specs` and `preflight_acceptances` are: a number that decides
-- whether the company builds V2 must not be editable by the people whose work
-- it judges.
--
-- ── Privacy is a database property here, not a convention ────────────────
--
-- These events measure a funnel, not a person. There is no reason for a name,
-- a phone number, an address or a line of card copy to be in any of them, so
-- rather than trusting every future caller to remember that, `meta` accepts
-- only a fixed set of keys carrying only scalars. The key allowlist is the
-- real defence — a value regex cannot tell a vertical from a phone number,
-- but there is no allowed key a phone number would ever be written under.

CREATE OR REPLACE FUNCTION metric_meta_ok(m jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(m) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(m) AS e(k, v)
       WHERE k NOT IN ('locale','vertical','format','count','engineVersion',
                       'variant','blocked','advisory','qty')
          OR jsonb_typeof(v) NOT IN ('number','boolean','string')
          OR (jsonb_typeof(v) = 'string' AND (v #>> '{}') !~ '^[A-Za-z0-9._:-]{1,40}$')
     );
$$;

-- `brief_key` is minted fresh by the client for each brief attempt and is
-- random, so it correlates the steps of one brief and nothing else. It is
-- deliberately not the owner key: reusing that would make the funnel
-- person-stable, which is a tracking identifier, and the funnel does not need
-- to know that two briefs came from the same phone.
--
-- `duration_ms` exists for one metric only — §10's brief→first-concept p95,
-- which is wall clock from the customer submitting the brief to concepts being
-- on screen. It is not engine compute time and must not be read as a cost.
CREATE TABLE IF NOT EXISTS metric_events (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL CHECK (name IN ('brief.started','concept.viewed',
                                                   'export.completed','order.placed')),
  brief_key   text        CHECK (brief_key IS NULL OR brief_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  short_code  text,
  order_ref   text,
  duration_ms int         CHECK (duration_ms IS NULL OR duration_ms >= 0),
  meta        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (metric_meta_ok(meta)),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The read path counts by name inside a time window and never fetches rows,
-- so this index is the one it lives on.
CREATE INDEX IF NOT EXISTS metric_events_name_ix ON metric_events (name, created_at DESC);

-- The funnel join: did this brief reach a concept, and how long until it
-- reached an export. Both are grouped by brief, so the key leads.
CREATE INDEX IF NOT EXISTS metric_events_brief_ix ON metric_events (brief_key, name, created_at);

CREATE OR REPLACE FUNCTION metric_events_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'metric_events is append-only; a measurement is recorded once and never revised';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS metric_events_immutable ON metric_events;
CREATE TRIGGER metric_events_immutable
  BEFORE UPDATE OR DELETE ON metric_events
  FOR EACH ROW EXECUTE FUNCTION metric_events_no_change();

-- ── The north star, which is not telemetry ───────────────────────────────
--
-- Print-Correct Rate is the percentage of delivered orders with zero
-- preflight-attributable defects, and the system cannot observe it. A defect
-- is discovered by a human holding paper — the customer opening the box, the
-- shop checking the run before handover — and no amount of instrumentation on
-- our side sees that. So this is not a metric computed from events. It is an
-- outcome entered against the order by whoever handled the delivery or the
-- complaint, and the number is worth exactly as much as the discipline of
-- entering it. Nothing here can improve on that, and pretending otherwise by
-- deriving a plausible-looking rate from something we can see would produce a
-- north star that quietly measures a different thing.
--
-- `cause` carries the whole meaning of the metric. §10 says *preflight-
-- attributable* defects, which is narrower than defects, and the difference is
-- the difference between a number that judges our product and a number that
-- judges a courier. A card that printed exactly as the file specified and was
-- crushed in a van is a bad day, not a preflight failure; a card whose Bangla
-- conjunct broke on the press because our checks passed a file that could not
-- hold it is the thing this number exists to catch. Only `preflight` counts
-- against the rate.
--
-- `undetermined` exists because it is the honest answer often enough, and it
-- counts against the rate rather than for it. An unexplained defect that
-- flatters the north star is exactly the failure this table is trying to
-- prevent, and the read path reports the undetermined count separately so
-- nobody has to guess how much of the number is unresolved.
CREATE TABLE IF NOT EXISTS order_outcomes (
  id           bigserial   PRIMARY KEY,
  order_ref    text        NOT NULL REFERENCES orders(ref),
  verdict      text        NOT NULL CHECK (verdict IN ('correct','defective')),
  cause        text        CHECK (cause IN ('preflight','press','courier',
                                            'customer_content','undetermined')),
  defect_code  text        CHECK (defect_code IS NULL OR defect_code ~ '^[a-z][a-z0-9_]{2,40}$'),
  evidence     text        NOT NULL CHECK (evidence IN ('customer_report','shop_inspection',
                                                        'our_inspection')),
  recorded_by  text        NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  source_key   text,
  note         text        CHECK (note IS NULL OR length(note) <= 400),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- A verdict of defective without a cause is a row that cannot be counted,
  -- and a cause on a correct card is a contradiction. Both are refused here
  -- rather than being tidied up later by whoever runs the query.
  CONSTRAINT order_outcomes_cause_matches_verdict
    CHECK ((verdict = 'defective') = (cause IS NOT NULL))
);

-- `defect_code` names the specific fault — `text_outside_safe_area`,
-- `press_misregistration`, `courier_damage` — and is checked for shape rather
-- than against a list, because the list of ways paper goes wrong will keep
-- growing and requiring a migration per new one leads to people reaching for
-- the nearest existing code instead. `cause` is the field the metric depends
-- on and it is enumerated; the code is the detail that makes a defect
-- investigable afterwards.

-- The current verdict for an order is its newest row. A defect found a week
-- after a delivery that was signed off as correct is a correction, and a
-- correction is a new row, never an edit — the same reasoning that makes
-- `design_specs` append-only. The read path takes the latest per order.
CREATE INDEX IF NOT EXISTS order_outcomes_ref_ix ON order_outcomes (order_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS order_outcomes_age_ix ON order_outcomes (created_at DESC);

-- A retried request must not become a second verdict, so the caller's key
-- deduplicates. Partial, because most entries are typed by a person and have
-- no key at all.
CREATE UNIQUE INDEX IF NOT EXISTS order_outcomes_source_key
  ON order_outcomes (source_key) WHERE source_key IS NOT NULL;

CREATE OR REPLACE FUNCTION order_outcomes_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_outcomes is append-only; record a corrected verdict as a new row';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_outcomes_immutable ON order_outcomes;
CREATE TRIGGER order_outcomes_immutable
  BEFORE UPDATE OR DELETE ON order_outcomes
  FOR EACH ROW EXECUTE FUNCTION order_outcomes_no_change();
