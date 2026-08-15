-- CARDWORKS migration 006 — the component library as records.
--
-- `LAYOUTS`, `PALETTES`, `TYPE_SYSTEMS` and `SLOTDEFS` live in
-- `assets/engine.js` as object literals. Technical Design §5.2 and §5.3
-- specify them as versioned, independently publishable records, and §10 item
-- 5 gives the two reasons: while the library is code, a designer cannot
-- extend it without an engineer, and publishing a component version cannot
-- roll the candidate cache (§7.1) without a deploy.
--
-- This migration moves them without moving the engine. The rows below are the
-- in-code records exported verbatim, so a snapshot read back out of this
-- table is deep-equal to what the engine holds — `tests/library.test.mjs`
-- asserts that field by field, and that equality is the whole proof the
-- migration is faithful. The literals stay as the built-in default, which is
-- what makes this reversible: a deploy where 006 has not run finds no table,
-- `lib/library.mjs` falls back, and nothing composes differently. The presses
-- table and the idempotency cache degrade the same way for the same reason.
--
-- Re-runnable, like every migration here: every statement is guarded and the
-- seed will not duplicate itself.

-- Identifiers come from dedicated sequences. db/schema.sql records what the
-- derived version cost — an identifier truncated from a row count collided
-- silently after ten rows — and anywhere else an id is derived rather than
-- sequence-generated is a latent version of that same bug.
CREATE SEQUENCE IF NOT EXISTS components_id_seq         START 100;
CREATE SEQUENCE IF NOT EXISTS component_versions_id_seq START 100;

CREATE TABLE IF NOT EXISTS components (
  id         bigint      PRIMARY KEY DEFAULT nextval('components_id_seq'),

  -- The slug is the id the engine already uses and a spec already stores —
  -- `lay.rule`, `pal.gold`, `back.bangla`. It is not a new name for an old
  -- thing, because a saved design pins this string, and renaming it here
  -- would orphan every spec composed before the rename.
  slug       text        NOT NULL UNIQUE,

  -- The §5.3 taxonomy. Four kinds are seeded because four are what the engine
  -- composes against today; the rest are listed so adding a ground or a
  -- finish record is an INSERT rather than a schema change, and deliberately
  -- left empty, because a component nothing composes against has no way to be
  -- found wrong. `slot` is the sixth record type §4.1 counts and §5.3's list
  -- omits.
  kind       text        NOT NULL
             CHECK (kind IN ('lay','typ','pal','bg','mrk','cnt','qr','fin','fmt','slot')),

  -- Null is the shared library everyone composes from. A brand-locked library
  -- belongs to an org, and PRD §5.2 gates orgs on a paying customer asking for
  -- one, so nothing writes this column yet. It is here rather than added
  -- later because §5.2 asks tenant-scoped tables to carry `org_id` from the
  -- first one, and because row-level security keyed on a column that does not
  -- exist yet is a retrofit nobody does evenly.
  org_id     bigint,

  -- Retiring a component stops it being offered. It does not withdraw it:
  -- every version it ever published stays readable, because a design somebody
  -- ordered was made of one of them.
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS components_kind_ix ON components (kind, status);
CREATE INDEX IF NOT EXISTS components_org_ix  ON components (org_id) WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS component_versions (
  id           bigint      PRIMARY KEY DEFAULT nextval('component_versions_id_seq'),
  component_id bigint      NOT NULL REFERENCES components(id) ON DELETE RESTRICT,

  -- The one identifier in this codebase that is counted rather than taken
  -- from a sequence, and it has to be: a version number is per component and
  -- has to be dense and ordered, which a shared sequence cannot give. What
  -- makes the count safe is the unique index below rather than the trigger
  -- that computes it — two publishes racing on the same component both read
  -- the same maximum, and the loser fails on the index instead of silently
  -- overwriting the winner. That is the difference between this and the
  -- row-count-derived order reference db/schema.sql records as a bug.
  version      int         NOT NULL CHECK (version > 0),

  -- { record, personality, compat } — see lib/library.mjs. `record` is the
  -- composable half and is byte-for-byte what the engine holds. `personality`
  -- is weights rather than tags so ranking stays arithmetic, and `compat` is
  -- an evaluable expression rather than prose, both per §5.3.
  payload_json jsonb       NOT NULL
               CHECK (payload_json ? 'record' AND payload_json ? 'personality' AND payload_json ? 'compat'),

  status       text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS component_versions_key
  ON component_versions (component_id, version);
CREATE INDEX IF NOT EXISTS component_versions_published_ix
  ON component_versions (component_id, version DESC) WHERE status = 'published';

-- The version number, assigned where it cannot be forgotten. A caller that
-- computes it in application code computes it from a read it took a moment
-- earlier; this reads it in the same statement that writes it.
CREATE OR REPLACE FUNCTION component_versions_next() RETURNS trigger AS $$
BEGIN
  IF NEW.version IS NULL THEN
    SELECT coalesce(max(version), 0) + 1 INTO NEW.version
      FROM component_versions WHERE component_id = NEW.component_id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS component_versions_numbered ON component_versions;
CREATE TRIGGER component_versions_numbered
  BEFORE INSERT ON component_versions
  FOR EACH ROW EXECUTE FUNCTION component_versions_next();

-- The guarantee Technical Design §7.1 calls non-negotiable, enforced here
-- rather than by every endpoint remembering it.
--
-- A saved design pins the exact component versions it was composed from, so
-- publishing a change bumps `libraryVersion` and rolls the candidate cache
-- without invalidating a single existing spec. That only holds while a
-- published version can never be edited or deleted: if the payload behind a
-- pin could change, a customer's card would change under them after they had
-- paid for it, and they would find out when 500 of them arrived. So a
-- published row is frozen and no row is ever deletable. A draft may still be
-- edited, because nothing has been composed from it yet.
CREATE OR REPLACE FUNCTION component_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'component_versions is append-only; a published version is what somebody''s saved design is made of. Publish a new version instead.';
  END IF;
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'component version %/% is published and therefore immutable; publish a new version instead', OLD.component_id, OLD.version;
  END IF;
  IF NEW.component_id IS DISTINCT FROM OLD.component_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a component version''s identity is fixed at creation';
  END IF;
  IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS component_versions_immutable ON component_versions;
CREATE TRIGGER component_versions_immutable
  BEFORE UPDATE OR DELETE ON component_versions
  FOR EACH ROW EXECUTE FUNCTION component_versions_guard();

-- A component's slug and kind are pinned by every spec that ever named it, so
-- they are fixed too. Retiring one is a status change and stays allowed.
CREATE OR REPLACE FUNCTION components_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'components are not deletable; retire the component instead';
  END IF;
  IF NEW.slug <> OLD.slug OR NEW.kind <> OLD.kind
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a component''s slug, kind and owner are fixed at creation; specs pin them';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS components_immutable ON components;
CREATE TRIGGER components_immutable
  BEFORE UPDATE OR DELETE ON components
  FOR EACH ROW EXECUTE FUNCTION components_guard();

-- ── Seed: the in-code library, exported ──────────────────────────────────
--
-- One document per component, generated from `seedDocuments()` in
-- lib/library.mjs, which reads the engine's own literals. It is written
-- compact and one per line because the readable form of a layout is the
-- annotated record in `assets/engine.js`; this is its serialisation, and the
-- test that matters compares the two rather than asking anyone to read both.
--
-- A layout added to the engine therefore fails tests/library.test.mjs until
-- this block is regenerated, which is the order those two events should
-- happen in. Rebuild it with:
--
--   node -e "import('./lib/library.mjs').then(L => console.log('[\n' +
--     L.seedDocuments().map(d => '  ' + JSON.stringify(d)).join(',\n') + '\n]'))"
--
-- Order is load-bearing. `lib/library.mjs` reads the library back with
-- `ORDER BY c.id`, and the edit grammar's `setLayoutFamily` picks the first
-- record in a family, so the sequence has to be handed out in the order the
-- literals are written — hence WITH ORDINALITY and the explicit ORDER BY on
-- the insert rather than trusting the set-returning function's output order.
DO $seed$
DECLARE
  lib jsonb := $library$
[
  {"slug":"lay.rule","kind":"lay","payload":{"record":{"id":"lay.rule","name":"Rule & Name","family":"minimal","face":"front","slots":[{"ref":"mark","kind":"mark","box":[0.8,0.8,1.3,1.3],"color":"fg"},{"ref":"company","kind":"text","box":[3.2,0.9,8,0.8],"scale":0.36,"align":"right","upper":true,"track":0.2,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"_rule","kind":"rule","box":[0.8,4.15,2.2,0.09],"color":"accent"},{"ref":"name","kind":"text","box":[0.8,4.45,10.4,1.35],"scale":1,"weight":"name","color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,5.85,7.5,0.75],"scale":0.5,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.8,6.75,10.4,0.9],"scale":0.42,"mode":"inline","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"portrait":[{"ref":"mark","kind":"mark","box":[0.7,0.7,1.5,1.1],"color":"fg"},{"ref":"company","kind":"text","box":[2.5,0.8,4.8,0.8],"scale":0.36,"align":"right","upper":true,"track":0.18,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"_rule","kind":"rule","box":[0.7,6.4,2,0.07],"color":"accent"},{"ref":"name","kind":"text","box":[0.7,6.8,6.6,1.9],"scale":1,"weight":"name","color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.7,8.9,6.6,0.9],"scale":0.5,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.7,10,6.6,1.4],"scale":0.42,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"square":[{"ref":"mark","kind":"mark","box":[0.8,0.8,1.6,1.6],"color":"fg"},{"ref":"company","kind":"text","box":[2.8,0.9,6.4,0.9],"scale":0.36,"align":"right","upper":true,"track":0.18,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"_rule","kind":"rule","box":[0.8,5.4,2,0.08],"color":"accent"},{"ref":"name","kind":"text","box":[0.8,5.8,8.4,1.7],"scale":1,"weight":"name","color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,7.6,8.4,0.9],"scale":0.5,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.8,8.6,8.4,0.9],"scale":0.42,"mode":"inline","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{"minimal":0.9,"corporate":0.6,"premium":0.5,"technical":0.3},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"lay.centered","kind":"lay","payload":{"record":{"id":"lay.centered","name":"Centred Signature","family":"traditional","face":"front","slots":[{"ref":"mark","kind":"mono","box":[5,1,2,1.7],"color":"accent","align":"center"},{"ref":"_hair","kind":"rule","box":[5.4,3.05,1.2,0.05],"color":"hair"},{"ref":"name","kind":"text","box":[1.2,3.35,9.6,1.25],"scale":0.92,"align":"center","color":"fg","maxLines":1,"priority":1,"fit":["track","step"]},{"ref":"role","kind":"text","box":[1.2,4.7,9.6,0.75],"scale":0.44,"align":"center","upper":true,"track":0.14,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"company","kind":"text","box":[1.2,6.3,9.6,0.8],"scale":0.4,"align":"center","upper":true,"track":0.2,"color":"accent","priority":3,"fit":["track","step","drop"]}],"portrait":[{"ref":"mark","kind":"mono","box":[3,1.8,2,1.7],"color":"accent","align":"center"},{"ref":"_hair","kind":"rule","box":[3.6,4,0.8,0.05],"color":"hair"},{"ref":"name","kind":"text","box":[0.7,4.4,6.6,1.7],"scale":0.92,"align":"center","color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.7,6.3,6.6,0.9],"scale":0.44,"align":"center","upper":true,"track":0.14,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"company","kind":"text","box":[0.7,9.8,6.6,0.9],"scale":0.4,"align":"center","upper":true,"track":0.2,"color":"accent","priority":3,"fit":["track","step","drop"]}],"square":[{"ref":"mark","kind":"mono","box":[4,1.5,2,1.7],"color":"accent","align":"center"},{"ref":"_hair","kind":"rule","box":[4.6,3.7,0.8,0.05],"color":"hair"},{"ref":"name","kind":"text","box":[0.8,4.1,8.4,1.5],"scale":0.88,"align":"center","color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,5.8,8.4,0.9],"scale":0.44,"align":"center","upper":true,"track":0.14,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"company","kind":"text","box":[0.8,7.9,8.4,0.9],"scale":0.4,"align":"center","upper":true,"track":0.2,"color":"accent","priority":3,"fit":["track","step","drop"]}]},"personality":{"premium":0.9,"traditional":0.8,"minimal":0.55},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"lay.split","kind":"lay","payload":{"record":{"id":"lay.split","name":"Split Panel","family":"structured","face":"front","slots":[{"ref":"_panel","kind":"panel","box":[0,0,4,8],"color":"panel"},{"ref":"mark","kind":"mark","box":[0.7,0.9,1.5,1.5],"color":"bg","onPanel":true},{"ref":"company","kind":"text","box":[0.5,6.3,3.1,0.9],"scale":0.34,"upper":true,"track":0.18,"color":"bg","onPanel":true,"maxLines":2,"priority":4,"fit":["track","step","wrap","drop"]},{"ref":"name","kind":"text","box":[4.7,2,6.6,1.2],"scale":0.82,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[4.7,3.3,6.6,0.75],"scale":0.44,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"_hair2","kind":"rule","box":[4.7,4.25,1.8,0.05],"color":"hair"},{"ref":"contact","kind":"contact","box":[4.7,4.5,6.6,2.7],"scale":0.4,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{"corporate":0.9,"minimal":0.45,"technical":0.4},"compat":{"requires":["palette.hasPanel"],"incompatible":[]}}},
  {"slug":"lay.bleed","kind":"lay","payload":{"record":{"id":"lay.bleed","name":"Full Bleed","family":"expressive","face":"front","slots":[{"ref":"_flood","kind":"panel","box":[0,0,12,8],"color":"accent"},{"ref":"_ghost","kind":"ghost","box":[6.2,1,6.6,6.6],"color":"bg"},{"ref":"company","kind":"text","box":[0.8,0.85,7,0.8],"scale":0.36,"upper":true,"track":0.2,"color":"bg","priority":4,"fit":["track","step","drop"]},{"ref":"name","kind":"text","box":[0.8,3.9,8.6,2.3],"scale":1.22,"weight":"display","color":"bg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,6.4,7.6,0.8],"scale":0.44,"color":"bg","priority":2,"fit":["track","step","abbrev","drop"]}]},"personality":{"bold":0.95,"friendly":0.6,"premium":0.2},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"lay.editorial","kind":"lay","payload":{"record":{"id":"lay.editorial","name":"Editorial","family":"traditional","face":"front","slots":[{"ref":"company","kind":"text","box":[1,0.9,8.5,0.8],"scale":0.34,"upper":true,"track":0.22,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"name","kind":"text","box":[1,3,9.8,1.5],"scale":1.02,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[1,4.6,8.5,0.8],"scale":0.44,"upper":true,"track":0.12,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"_hair","kind":"rule","box":[1,6.35,10,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[1,6.55,10,0.85],"scale":0.38,"mode":"inline","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"portrait":[{"ref":"company","kind":"text","box":[0.8,0.9,6.4,0.8],"scale":0.34,"upper":true,"track":0.22,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"name","kind":"text","box":[0.8,3.6,6.4,2.1],"scale":1,"color":"fg","maxLines":3,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,5.9,6.4,0.9],"scale":0.44,"upper":true,"track":0.12,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"_hair","kind":"rule","box":[0.8,9.8,6.4,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[0.8,10.1,6.4,1.3],"scale":0.4,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{"premium":0.8,"traditional":0.7,"minimal":0.6},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"lay.grid","kind":"lay","payload":{"record":{"id":"lay.grid","name":"Technical Grid","family":"technical","face":"front","slots":[{"ref":"_grid","kind":"gridlines","box":[0,0,12,8],"color":"hair"},{"ref":"company","kind":"text","box":[0.8,0.85,6,0.7],"scale":0.32,"upper":true,"track":0.2,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"qr","kind":"qr","box":[8.6,0.7,2.7,2.7],"color":"fg"},{"ref":"name","kind":"text","box":[0.8,3.5,8,1.15],"scale":0.8,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,4.75,8,0.75],"scale":0.42,"color":"accent","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.8,5.7,10.4,1.6],"scale":0.38,"mode":"stack","color":"muted","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{"technical":0.95,"minimal":0.6,"corporate":0.5},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"lay.band","kind":"lay","payload":{"record":{"id":"lay.band","name":"Colour Band","family":"structured","face":"front","slots":[{"ref":"_band","kind":"panel","box":[0,0,12,2.3],"color":"panel"},{"ref":"company","kind":"text","box":[0.8,0.75,10.4,0.85],"scale":0.4,"upper":true,"track":0.2,"color":"bg","onPanel":true,"priority":4,"fit":["track","step","drop"]},{"ref":"name","kind":"text","box":[0.8,3.2,10.4,1.25],"scale":0.94,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,4.55,8.5,0.75],"scale":0.44,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.8,6,10.4,1.3],"scale":0.4,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"portrait":[{"ref":"_band","kind":"panel","box":[0,0,8,2.8],"color":"panel"},{"ref":"company","kind":"text","box":[0.7,1.1,6.6,0.9],"scale":0.38,"upper":true,"track":0.2,"color":"bg","onPanel":true,"priority":4,"fit":["track","step","drop"]},{"ref":"name","kind":"text","box":[0.7,4.2,6.6,1.8],"scale":0.94,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.7,6.2,6.6,0.9],"scale":0.46,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.7,9.4,6.6,2],"scale":0.42,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{"corporate":0.7,"bold":0.6,"friendly":0.55},"compat":{"requires":["palette.hasPanel"],"incompatible":[]}}},
  {"slug":"lay.corner","kind":"lay","payload":{"record":{"id":"lay.corner","name":"Corner Monogram","family":"expressive","face":"front","slots":[{"ref":"mark","kind":"bigmono","box":[7.6,0.2,4.2,4],"color":"accent"},{"ref":"company","kind":"text","box":[0.8,0.9,6.2,0.8],"scale":0.34,"upper":true,"track":0.2,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"name","kind":"text","box":[0.8,4.35,8,1.2],"scale":0.88,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,5.6,7.4,0.7],"scale":0.42,"color":"muted","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.8,6.5,10.4,0.85],"scale":0.38,"mode":"inline","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{"premium":0.7,"bold":0.7,"traditional":0.35},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"lay.stack","kind":"lay","payload":{"record":{"id":"lay.stack","name":"Ruled Stack","family":"minimal","face":"front","slots":[{"ref":"company","kind":"text","box":[0.8,0.8,10.4,0.75],"scale":0.34,"upper":true,"track":0.2,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"_h1","kind":"rule","box":[0.8,1.68,10.4,0.04],"color":"hair"},{"ref":"name","kind":"text","box":[0.8,1.95,10.4,1.2],"scale":0.88,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"_h2","kind":"rule","box":[0.8,3.32,10.4,0.04],"color":"hair"},{"ref":"role","kind":"text","box":[0.8,3.6,10.4,0.75],"scale":0.44,"color":"accent","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"_h3","kind":"rule","box":[0.8,4.5,10.4,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[0.8,4.78,10.4,2.4],"scale":0.4,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"portrait":[{"ref":"company","kind":"text","box":[0.7,0.8,6.6,0.8],"scale":0.34,"upper":true,"track":0.2,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"_h1","kind":"rule","box":[0.7,1.8,6.6,0.04],"color":"hair"},{"ref":"name","kind":"text","box":[0.7,2.1,6.6,1.8],"scale":0.88,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"_h2","kind":"rule","box":[0.7,4.1,6.6,0.04],"color":"hair"},{"ref":"role","kind":"text","box":[0.7,4.4,6.6,0.9],"scale":0.46,"color":"accent","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"_h3","kind":"rule","box":[0.7,5.5,6.6,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[0.7,5.8,6.6,5.4],"scale":0.42,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"square":[{"ref":"company","kind":"text","box":[0.8,0.9,8.4,0.9],"scale":0.34,"upper":true,"track":0.2,"color":"muted","priority":4,"fit":["track","step","drop"]},{"ref":"_h1","kind":"rule","box":[0.8,2,8.4,0.04],"color":"hair"},{"ref":"name","kind":"text","box":[0.8,2.3,8.4,1.6],"scale":0.88,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"_h2","kind":"rule","box":[0.8,4.1,8.4,0.04],"color":"hair"},{"ref":"role","kind":"text","box":[0.8,4.4,8.4,0.9],"scale":0.46,"color":"accent","priority":2,"fit":["track","step","abbrev","drop"]},{"ref":"_h3","kind":"rule","box":[0.8,5.5,8.4,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[0.8,5.8,8.4,3.4],"scale":0.42,"mode":"stack","color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{"minimal":0.8,"corporate":0.6,"technical":0.5},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"back.contact","kind":"lay","payload":{"record":{"id":"back.contact","name":"Contact block","face":"back","slots":[{"ref":"company","kind":"text","box":[0.8,0.9,10.4,0.85],"scale":0.38,"upper":true,"track":0.2,"color":"accent","priority":4,"fit":["track","step","drop"]},{"ref":"_h","kind":"rule","box":[0.8,1.85,10.4,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[0.8,2.3,10.4,4.9],"scale":0.44,"mode":"stack","color":"fg","priority":1,"fit":["track","step","reduceRoutes"]}],"portrait":[{"ref":"company","kind":"text","box":[0.7,0.9,6.6,0.9],"scale":0.38,"upper":true,"track":0.2,"color":"accent","priority":4,"fit":["track","step","drop"]},{"ref":"_h","kind":"rule","box":[0.7,2,6.6,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[0.7,2.4,6.6,8.8],"scale":0.44,"mode":"stack","color":"fg","priority":1,"fit":["track","step","reduceRoutes"]}],"square":[{"ref":"company","kind":"text","box":[0.8,0.9,8.4,0.9],"scale":0.38,"upper":true,"track":0.2,"color":"accent","priority":4,"fit":["track","step","drop"]},{"ref":"_h","kind":"rule","box":[0.8,2.1,8.4,0.04],"color":"hair"},{"ref":"contact","kind":"contact","box":[0.8,2.5,8.4,6.6],"scale":0.44,"mode":"stack","color":"fg","priority":1,"fit":["track","step","reduceRoutes"]}]},"personality":{},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"back.bangla","kind":"lay","payload":{"record":{"id":"back.bangla","name":"বাংলা face","face":"back","forceScript":"bangla","slots":[{"ref":"company","kind":"text","box":[0.8,0.9,10.4,0.9],"scale":0.38,"color":"accent","priority":4,"maxLines":2,"fit":["track","step","wrap","drop"]},{"ref":"_h","kind":"rule","box":[0.8,2,10.4,0.04],"color":"hair"},{"ref":"name","kind":"text","box":[0.8,2.3,10.4,1.35],"scale":0.88,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,3.8,10.4,0.9],"scale":0.46,"color":"muted","priority":2,"maxLines":2,"fit":["track","step","wrap","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.8,5,10.4,2.2],"scale":0.42,"mode":"stack","bnDigits":true,"color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"portrait":[{"ref":"company","kind":"text","box":[0.7,0.9,6.6,1],"scale":0.38,"color":"accent","priority":4,"maxLines":2,"fit":["track","step","wrap","drop"]},{"ref":"_h","kind":"rule","box":[0.7,2.2,6.6,0.04],"color":"hair"},{"ref":"name","kind":"text","box":[0.7,2.6,6.6,1.9],"scale":0.88,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.7,4.7,6.6,1.1],"scale":0.46,"color":"muted","priority":2,"maxLines":2,"fit":["track","step","wrap","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.7,6.2,6.6,5],"scale":0.42,"mode":"stack","bnDigits":true,"color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}],"square":[{"ref":"company","kind":"text","box":[0.8,0.9,8.4,1],"scale":0.38,"color":"accent","priority":4,"maxLines":2,"fit":["track","step","wrap","drop"]},{"ref":"_h","kind":"rule","box":[0.8,2.2,8.4,0.04],"color":"hair"},{"ref":"name","kind":"text","box":[0.8,2.6,8.4,1.7],"scale":0.88,"color":"fg","maxLines":2,"priority":1,"fit":["track","step","wrap"]},{"ref":"role","kind":"text","box":[0.8,4.5,8.4,1],"scale":0.46,"color":"muted","priority":2,"maxLines":2,"fit":["track","step","wrap","abbrev","drop"]},{"ref":"contact","kind":"contact","box":[0.8,5.8,8.4,3.4],"scale":0.42,"mode":"stack","bnDigits":true,"color":"fg","priority":3,"fit":["track","step","reduceRoutes"]}]},"personality":{},"compat":{"requires":["type.hasBangla"],"incompatible":[]}}},
  {"slug":"back.qr","kind":"lay","payload":{"record":{"id":"back.qr","name":"QR forward","face":"back","slots":[{"ref":"qr","kind":"qr","box":[4.3,1.5,3.4,3.4],"color":"fg"},{"ref":"_cap","kind":"static","box":[1,5.3,10,0.8],"scale":0.36,"align":"center","upper":true,"track":0.18,"color":"muted","text":"Scan to save contact"},{"ref":"company","kind":"text","box":[1,6.2,10,0.8],"scale":0.4,"align":"center","upper":true,"track":0.2,"color":"accent","priority":4,"fit":["track","step","drop"]}]},"personality":{},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"back.mark","kind":"lay","payload":{"record":{"id":"back.mark","name":"Mark only","face":"back","slots":[{"ref":"_flood","kind":"panel","box":[0,0,12,8],"color":"panel"},{"ref":"mark","kind":"bigmono","box":[4,2,4,4],"color":"bg","align":"center"}]},"personality":{},"compat":{"requires":["palette.hasPanel"],"incompatible":[]}}},
  {"slug":"pal.ink","kind":"pal","payload":{"record":{"id":"pal.ink","name":"Ink on white","bg":"#ffffff","fg":"#16161a","accent":"#c1121f","muted":"#7a7876","hair":"#d8d5d2","panel":"#16161a"},"personality":{"minimal":0.9,"corporate":0.6,"premium":0.4},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"pal.gold","kind":"pal","payload":{"record":{"id":"pal.gold","name":"Black & gold","bg":"#0d0d0c","fg":"#efe9dc","accent":"#c9a227","muted":"#8e8778","hair":"#5c5850","panel":"#0d0d0c"},"personality":{"premium":0.95,"traditional":0.6,"bold":0.3},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"pal.green","kind":"pal","payload":{"record":{"id":"pal.green","name":"Bottle green & bone","bg":"#f5f4ef","fg":"#12291f","accent":"#0a6847","muted":"#7c837e","hair":"#cdd2cb","panel":"#0a6847"},"personality":{"traditional":0.7,"friendly":0.55,"premium":0.5},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"pal.navy","kind":"pal","payload":{"record":{"id":"pal.navy","name":"Navy & brass","bg":"#0f2233","fg":"#eef1f4","accent":"#c8a45c","muted":"#8494a3","hair":"#2b3d4d","panel":"#0f2233"},"personality":{"corporate":0.9,"premium":0.7,"traditional":0.5},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"pal.maroon","kind":"pal","payload":{"record":{"id":"pal.maroon","name":"Cream & maroon","bg":"#f4efe6","fg":"#1f1b18","accent":"#7a1f28","muted":"#8b8377","hair":"#d4cbbc","panel":"#7a1f28"},"personality":{"traditional":0.9,"premium":0.6},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"pal.teal","kind":"pal","payload":{"record":{"id":"pal.teal","name":"White & teal","bg":"#ffffff","fg":"#14201f","accent":"#0d7a72","muted":"#7d8a88","hair":"#dde5e4","panel":"#0d7a72"},"personality":{"friendly":0.7,"corporate":0.55,"minimal":0.5},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"pal.slate","kind":"pal","payload":{"record":{"id":"pal.slate","name":"Charcoal & signal","bg":"#1b1e21","fg":"#e6e8ea","accent":"#00c48a","muted":"#8b959c","hair":"#3a4045","panel":"#1b1e21"},"personality":{"technical":0.9,"bold":0.5,"minimal":0.5},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"pal.red","kind":"pal","payload":{"record":{"id":"pal.red","name":"White & vermilion","bg":"#ffffff","fg":"#191919","accent":"#e03616","muted":"#7d7d7d","hair":"#e2e2e2","panel":"#191919"},"personality":{"bold":0.9,"friendly":0.6},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"typ.siliguri","kind":"typ","payload":{"record":{"id":"typ.siliguri","name":"Hind Siliguri + Libre Franklin","note":"Workhorse. Best Bangla legibility at small sizes.","latin":"'Libre Franklin',sans-serif","bangla":"'Hind Siliguri',sans-serif","banglaOk":true,"weightName":600},"personality":{"minimal":0.7,"corporate":0.7,"friendly":0.5},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"typ.noto","kind":"typ","payload":{"record":{"id":"typ.noto","name":"Noto Sans Bengali + Archivo","note":"Widest conjunct coverage. Safest for uncommon names.","latin":"'Archivo',sans-serif","bangla":"'Noto Sans Bengali',sans-serif","banglaOk":true,"weightName":700},"personality":{"corporate":0.7,"friendly":0.6,"minimal":0.55},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"typ.tiro","kind":"typ","payload":{"record":{"id":"typ.tiro","name":"Tiro Bangla + Playfair Display","note":"Editorial. Traditional Bangla letterforms, high contrast.","latin":"'Playfair Display',serif","bangla":"'Tiro Bangla',serif","banglaOk":true,"weightName":600},"personality":{"traditional":0.95,"premium":0.8},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"typ.baloo","kind":"typ","payload":{"record":{"id":"typ.baloo","name":"Baloo Da 2 + Archivo","note":"Heavy display. Retail, food, events.","latin":"'Archivo',sans-serif","bangla":"'Baloo Da 2',sans-serif","banglaOk":true,"weightName":800},"personality":{"bold":0.9,"friendly":0.8},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"typ.mono","kind":"typ","payload":{"record":{"id":"typ.mono","name":"IBM Plex Mono + Noto Sans Bengali","note":"Technical. IT, engineering, data.","latin":"'IBM Plex Mono',monospace","bangla":"'Noto Sans Bengali',sans-serif","banglaOk":true,"weightName":600},"personality":{"technical":0.95,"minimal":0.6},"compat":{"requires":[],"incompatible":[]}}},
  {"slug":"slot.mark","kind":"slot","payload":{"record":{"minMm":9,"required":false},"personality":{},"compat":{"requires":[],"incompatible":[]},"ref":"mark"}},
  {"slug":"slot.company","kind":"slot","payload":{"record":{"minPt":6,"required":false},"personality":{},"compat":{"requires":[],"incompatible":[]},"ref":"company"}},
  {"slug":"slot.name","kind":"slot","payload":{"record":{"minPt":7,"required":true},"personality":{},"compat":{"requires":[],"incompatible":[]},"ref":"name"}},
  {"slug":"slot.role","kind":"slot","payload":{"record":{"minPt":6,"required":false},"personality":{},"compat":{"requires":[],"incompatible":[]},"ref":"role"}},
  {"slug":"slot.contact","kind":"slot","payload":{"record":{"minPt":6,"required":true},"personality":{},"compat":{"requires":[],"incompatible":[]},"ref":"contact"}},
  {"slug":"slot.qr","kind":"slot","payload":{"record":{"minMm":12,"required":false},"personality":{},"compat":{"requires":[],"incompatible":[]},"ref":"qr"}}
]
$library$::jsonb;
BEGIN
  INSERT INTO components (slug, kind)
  SELECT d->>'slug', d->>'kind'
  FROM jsonb_array_elements(lib) WITH ORDINALITY AS t(d, ord)
  ORDER BY t.ord
  ON CONFLICT (slug) DO NOTHING;

  -- Only where the component has no version at all, so re-running this after
  -- a designer has published version 2 of a palette does not quietly publish
  -- a third that is the original again.
  INSERT INTO component_versions (component_id, payload_json, status, published_at)
  SELECT c.id, t.d->'payload', 'published', now()
  FROM jsonb_array_elements(lib) WITH ORDINALITY AS t(d, ord)
  JOIN components c ON c.slug = t.d->>'slug'
  WHERE NOT EXISTS (SELECT 1 FROM component_versions v WHERE v.component_id = c.id)
  ORDER BY t.ord;
END $seed$;
