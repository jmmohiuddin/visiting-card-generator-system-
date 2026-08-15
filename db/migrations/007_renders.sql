-- The renders table Technical Design §7.1 refers to.
--
-- §7.1 is the sentence the whole cost model rests on: the expensive operation
-- is the rare one. Previews are generated constantly and are cheap SVG
-- strings servable from a CDN by content hash; PDFs are expensive and only
-- happen when somebody pays. Determinism is what makes that work — the same
-- spec composes to the same card forever — so a render is content-addressed
-- and, once written, never changes.
--
--   Preview render   spec_hash + variant   immutable, one year
--   Print render     spec_hash             immutable
--
-- Both are the same row shape, which is why they are one table: `variant`
-- carries the difference, and `print` is a variant like any other.
--
-- ── Why `engine_version` is part of the key ─────────────────────────────
--
-- §7.1 keys this on the spec hash alone, and for the library that is right:
-- a spec pins the component versions it was built from, so publishing a
-- palette cannot change a card somebody has already ordered. But the fit
-- ladder is not a component. It lives in `assets/engine.js`, and a change
-- there moves geometry for every spec at once. Migration 005 reached the
-- same conclusion about preflight reports for the same reason, and used the
-- same column: an artefact is only immutable relative to the code that made
-- it, and a cache that forgets this serves a customer the card the engine
-- used to draw.
--
-- The practical effect is that shipping a new engine misses on every key
-- rather than serving something stale — the correct behaviour, and cheap,
-- because a preview costs about 8 ms to regenerate.
--
-- ── Bytes here, or a URL to bytes elsewhere ─────────────────────────────
--
-- A preview is ~40 KB of SVG and belongs in the row. A print PDF is ~4 MB
-- and does not: §7.2 budgets ~200 GB a month at scale with a lifecycle to
-- cold storage at 90 days, which is object-store work, not Postgres work.
-- So a row carries either the body or a URL to it, and the check below
-- refuses a row that carries neither — a cache entry that names an artefact
-- nobody can fetch is worse than a miss, because a miss regenerates.

CREATE TABLE IF NOT EXISTS renders (
  id             bigserial   PRIMARY KEY,
  spec_hash      text        NOT NULL,
  variant        text        NOT NULL,
  engine_version text        NOT NULL,
  content_type   text        NOT NULL,
  byte_length    int         NOT NULL CHECK (byte_length >= 0),
  content_sha256 text        NOT NULL,
  body           text,
  url            text,
  short_code     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT renders_has_artefact CHECK (body IS NOT NULL OR url IS NOT NULL)
);

-- The cache key itself. A repeated render is a hit, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS renders_key
  ON renders (spec_hash, variant, engine_version);

-- The dashboard read: every render belonging to a saved design, newest first.
CREATE INDEX IF NOT EXISTS renders_code_ix ON renders (short_code, created_at DESC);

-- The lifecycle sweep §7.2 describes moves the oldest rows to cold storage,
-- so it reads in creation order and needs to.
CREATE INDEX IF NOT EXISTS renders_age_ix ON renders (created_at);

-- Immutable, which is the property the one-year cache header is a promise
-- about. A render that could be updated in place would let a stale header
-- outlive the artefact it described, and the customer holding the printed
-- card would be the one who found out. Re-rendering a changed design is an
-- INSERT under a new key, never an UPDATE under the old one — exactly as
-- `design_specs` is append-only in db/schema.sql, and for the same reason.
--
-- Deletion stays legal, unlike `design_specs`, because the §7.2 lifecycle
-- sweep has to be able to evict a cold row. Evicting a cache entry costs a
-- regeneration; rewriting one costs the truth.
CREATE OR REPLACE FUNCTION renders_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'renders is immutable; a changed design is a new key, not an updated row';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS renders_immutable ON renders;
CREATE TRIGGER renders_immutable
  BEFORE UPDATE ON renders
  FOR EACH ROW EXECUTE FUNCTION renders_no_update();
