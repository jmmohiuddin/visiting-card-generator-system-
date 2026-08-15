/* The component library, as records instead of JS literals.
 *
 * Technical Design §5.2 and §5.3 specify `LAYOUTS`, `PALETTES`,
 * `TYPE_SYSTEMS` and `SLOTDEFS` as versioned, independently publishable
 * database records, and §10 item 5 gives the two reasons: a designer cannot
 * extend the library without an engineer while it is code, and publishing a
 * component version cannot roll a cache (§7.1) without a deploy.
 *
 * ── Why the engine did not change ─────────────────────────────────────────
 *
 * §3.3 makes the engine a pure function of (brief, library, seed), and over a
 * thousand assertions are written against its present behaviour. So the
 * library moves without the engine moving: the in-code records are exported
 * into `component_versions` rows as the seed, and this module is the read
 * path back. The literals stay as the built-in default; the database becomes
 * the authority only when it has published rows to be authoritative with.
 *
 * That ordering is what makes the migration reversible. A deploy where
 * migration 006 has not run finds no `components` table, falls back to the
 * literals, and composes exactly what it composed yesterday — the same
 * pattern `lib/quote-server.mjs` uses for presses and `lib/http.mjs` uses for
 * the idempotency cache. Losing the database degrades the library to its
 * defaults; it never fails a compose.
 *
 * ── What a snapshot is ────────────────────────────────────────────────────
 *
 * A `LibrarySnapshot` is `{ layouts, palettes, typeSystems, slotDefs }` in
 * exactly the shape `assets/engine.js` already holds, because that equality
 * is the entire proof that the migration is faithful — `tests/library.test.mjs`
 * asserts it field by field rather than by sampling. The engine holds its
 * library as module-scope consts, so `applySnapshot` supplies a different one
 * by replacing the contents of those live objects rather than by editing the
 * file.
 *
 * ── The guarantee that governs publishing ─────────────────────────────────
 *
 * §7.1: publishing a component version bumps `libraryVersion` and rolls
 * candidate caches, and it must never invalidate an existing spec. A saved
 * design pins the exact versions it was composed from, so `resolvePins`
 * answers with those payloads forever and a customer's card cannot change
 * under them after they have ordered it. In a product people order physical
 * goods from that is not a nicety, so a published version is immutable in the
 * database — enforced by the trigger in migration 006, not by anything here
 * remembering to be careful.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { engine } from './engine-node.mjs';
import { familyOf, vendoredFamilies, loadFace, FONT_DIR } from './pdf/fonts.mjs';
import { planFor } from './pdf/bengali.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_SRC = path.join(ROOT, 'assets/engine.js');

/* The component kinds this library holds. §5.3 names nine at maturity; four
   exist as records today because four are what the engine reads. The rest —
   grounds, marks, contact blocks, QR styles, finishes, formats — are listed
   in the migration's CHECK so adding one is a row rather than a schema
   change, and deliberately not seeded, because a component nothing composes
   against is a record with no way to be wrong. */
export const KINDS = {
  lay:  'Layout',
  pal:  'Palette',
  typ:  'Type system',
  slot: 'Slot definition'
};

/** Deep structural equality over JSON-shaped values. Key order is not
 *  significant — Postgres `jsonb` reorders keys on the way in, so an
 *  order-sensitive comparison would report a faithful migration as broken. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/** A JSON round trip, so a record handed out can never be the engine's own
 *  object. `generate()` mutates `LAYOUTS[i]` in place while it enumerates
 *  candidates, and a snapshot sharing those objects would see it happen. */
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ── Reading the ranker's personality tables ──────────────────────────────
   §5.3 requires every component to carry `personality` as weights rather than
   string tags, so ranking stays arithmetic. The engine already holds them
   that way, in `LAYOUT_AXES`, `PALETTE_AXES` and `TYPE_AXES` — but only the
   first is on the export list in `lib/engine-node.mjs`, and that file belongs
   to another owner this round.

   So the other two are read out of the source by name and brace matching.
   That is a source-shaped extraction, which this codebase distrusts for good
   reason, so it is not taken on trust: `LAYOUT_AXES` *is* exported, the same
   reader is run against it, and the result is checked against the engine's
   own object before either of the other two is believed. A reader that
   disagrees there is a reader whose other answers mean nothing, and it
   refuses rather than returning a table with entries missing — an incomplete
   personality table does not fail, it silently flattens the ranking. */
function literalNamed(src, name) {
  const at = src.search(new RegExp(`const\\s+${name}\\s*=\\s*\\{`));
  if (at < 0) throw new Error(`assets/engine.js no longer declares ${name}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0)
      return new Function('return ' + src.slice(open, i + 1))();
  }
  throw new Error(`assets/engine.js opens ${name} and never closes it`);
}

let axesCache = null;
function axes() {
  if (axesCache) return axesCache;
  const src = fs.readFileSync(ENGINE_SRC, 'utf8');
  const E = engine();

  const layout = literalNamed(src, 'LAYOUT_AXES');
  if (!deepEqual(layout, E.LAYOUT_AXES))
    throw new Error('the engine literal reader disagrees with the engine on LAYOUT_AXES; nothing it returns is trustworthy');

  const palette = literalNamed(src, 'PALETTE_AXES');
  const type = literalNamed(src, 'TYPE_AXES');
  for (const [name, table, expected] of [['PALETTE_AXES', palette, E.PALETTES], ['TYPE_AXES', type, E.TYPE_SYSTEMS]])
    if (Object.keys(table).length !== expected.length)
      throw new Error(`${name} came back with ${Object.keys(table).length} entries for ${expected.length} components`);

  axesCache = { lay: layout, pal: palette, typ: type };
  return axesCache;
}

/* ── compat, as an expression rather than as prose ────────────────────────
   §5.3 asks for `compat` to be evaluable. A requirement is therefore a token
   from this closed table, and each token is a predicate over the combination
   being considered — a layout together with the palette and type system it
   would be composed with. `evalCompat` refuses an unknown token rather than
   treating it as satisfied, because a requirement nobody can evaluate reads
   as met and would let an incompatible pair through. */
export const PREDICATES = {
  'palette.hasPanel': (c) => typeof c.palette?.panel === 'string' && c.palette.panel.length > 0,
  'type.hasBangla':   (c) => c.type?.banglaOk === true && typeof c.type?.bangla === 'string' && c.type.bangla.length > 0
};

/** Evaluate a component's `compat` against a candidate combination.
 *  Returns the unmet requirements, so a refusal can name them. */
export function evalCompat(compat, combination) {
  const unmet = [];
  for (const token of compat?.requires || []) {
    const p = PREDICATES[token];
    if (!p) throw new Error(`compat names an unknown requirement: ${token}`);
    if (!p(combination)) unmet.push(token);
  }
  const clashes = (compat?.incompatible || []).filter(id =>
    id === combination.palette?.id || id === combination.type?.id || (combination.finishes || []).includes(id));
  return { ok: !unmet.length && !clashes.length, unmet, clashes };
}

/* What a layout actually requires, derived from the record rather than typed
   in beside it, so a new layout carries the right requirements the moment it
   is written. A slot painted in `panel` needs a palette that declares one; a
   face that forces Bangla needs a type system with a Bangla family.

   `incompatible` is empty on every seeded component and that is a statement,
   not an omission. The plausible entries are print facts — whether a flood
   coverage can be letterpressed, whether a hairline survives emboss — and
   nobody has printed the test sheet (Master PRD §8.1). The presses table
   records the same kind of blank as `pdfx4_stance = 'unasked'` rather than as
   a guess, and inventing one here would be worse than leaving it open. */
function compatFor(kind, record) {
  const requires = [];
  if (kind === 'lay') {
    const slots = [...(record.slots || []), ...(record.portrait || []), ...(record.square || [])];
    if (slots.some(s => s.color === 'panel')) requires.push('palette.hasPanel');
    if (record.forceScript === 'bangla') requires.push('type.hasBangla');
  }
  return { requires, incompatible: [] };
}

/** Every component in the built-in library, as the document its published
 *  version carries. This is what migration 006 seeds, and regenerating that
 *  migration from this function is how the two are kept honest. */
export function seedDocuments() {
  const E = engine();
  const A = axes();
  const docs = [];

  const push = (kind, slug, record, extra = {}) => docs.push({
    slug, kind,
    payload: { record: clone(record), personality: A[kind]?.[slug] || {}, compat: compatFor(kind, record), ...extra }
  });

  for (const L of E.LAYOUTS) push('lay', L.id, L);
  for (const P of E.PALETTES) push('pal', P.id, P);
  for (const T of E.TYPE_SYSTEMS) push('typ', T.id, T);
  /* A slot definition is keyed by its `ref` rather than by an id inside the
     record, so the ref travels in the payload instead of being cut back out
     of the slug. Nothing downstream should have to do string surgery on a
     name to find out what a record is. */
  for (const ref of Object.keys(E.SLOTDEFS)) push('slot', 'slot.' + ref, E.SLOTDEFS[ref], { ref });

  return docs;
}

/* ── Snapshots ────────────────────────────────────────────────────────── */

/** Build a `LibrarySnapshot` from component rows, in row order.
 *
 *  Order is the library's own: the seed inserts in the order the literals are
 *  written and `id` comes from a sequence, so `ORDER BY c.id` reproduces it
 *  and a component published later lands at the end. The engine ranks by
 *  score rather than by position, but the edit grammar's `setLayoutFamily`
 *  picks the first record in a family, so the order is observable and is
 *  therefore preserved rather than assumed not to matter. */
export function snapshotFrom(rows) {
  const library = { layouts: [], palettes: [], typeSystems: [], slotDefs: {} };

  for (const r of rows) {
    const payload = r.payload_json || r.payload;
    if (!payload || typeof payload !== 'object' || !payload.record)
      throw new Error(`component ${r.slug} has no record in its published payload`);
    const record = payload.record;
    if (r.kind === 'lay') library.layouts.push(record);
    else if (r.kind === 'pal') library.palettes.push(record);
    else if (r.kind === 'typ') library.typeSystems.push(record);
    else if (r.kind === 'slot') library.slotDefs[payload.ref || r.slug] = record;
    else throw new Error(`component ${r.slug} has a kind nothing composes against: ${r.kind}`);
  }

  /* An extractor that finds nothing must fail, not pass — the house rule from
     WORKPLAN.md, and this is exactly the shape it was written for. A snapshot
     that came back empty would compose nothing, and letting the engine fall
     through to its literals instead would hide a broken read path behind a
     working product for as long as it took someone to publish a change. */
  const missing = [];
  if (!library.layouts.some(l => l.face === 'front')) missing.push('front layouts');
  if (!library.layouts.some(l => l.face === 'back')) missing.push('back layouts');
  if (!library.palettes.length) missing.push('palettes');
  if (!library.typeSystems.length) missing.push('type systems');
  if (!Object.keys(library.slotDefs).length) missing.push('slot definitions');
  if (missing.length)
    throw new Error(`a library snapshot built from ${rows.length} rows has no ${missing.join(', no ')}`);

  return library;
}

/** The built-in default: the engine's own literals, cloned. */
export function builtInLibrary() {
  const E = engine();
  return {
    layouts: clone(E.LAYOUTS),
    palettes: clone(E.PALETTES),
    typeSystems: clone(E.TYPE_SYSTEMS),
    slotDefs: clone(E.SLOTDEFS)
  };
}

/** The version identifier §7.1 keys the candidate cache on.
 *
 *  It digests the published version of every component, so republishing one
 *  palette moves it and nothing else about the deploy does. A snapshot with
 *  the same components at the same versions is the same library, whether it
 *  was read out of Postgres or fell back to the literals — which is why the
 *  seeded database and a deploy without migration 006 report the same value
 *  rather than two that have to be reconciled later. */
export function libraryVersion(components) {
  const line = components
    .map(c => `${c.slug}@${c.version}`)
    .sort()
    .join('\n');
  return 'lib-' + crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
}

/** The pin map a spec stores, so it can be recomposed from the exact versions
 *  it was built from however far the library has moved since. */
export const pinsFor = (components) =>
  Object.fromEntries(components.map(c => [c.slug, c.version]).sort((a, b) => a[0] < b[0] ? -1 : 1));

const SEED_COMPONENTS = () => seedDocuments().map(d => ({ slug: d.slug, kind: d.kind, version: 1 }));

function builtIn(source) {
  const components = SEED_COMPONENTS();
  return { library: builtInLibrary(), components, source, libraryVersion: libraryVersion(components) };
}

/** The current published library, or the built-in default and the reason.
 *
 *  Every failure here degrades rather than refuses, and each one says which
 *  it was: a deploy with no database, a database without migration 006, and a
 *  migration applied but not seeded are three different operational states,
 *  and collapsing them into "the library is the default" is what makes them
 *  take an afternoon to tell apart. */
export async function loadLibrary(sql) {
  if (!sql) return builtIn('seed:no-database');

  let rows;
  try {
    rows = await sql`
      SELECT c.slug, c.kind, v.version, v.payload_json
      FROM components c
      JOIN LATERAL (
        SELECT version, payload_json FROM component_versions
        WHERE component_id = c.id AND status = 'published'
        ORDER BY version DESC LIMIT 1
      ) v ON true
      WHERE c.status = 'active' AND c.org_id IS NULL
      ORDER BY c.id`;
  } catch (e) {
    console.error('component library unavailable, using built-in defaults:', e && e.message);
    return builtIn('seed:migration-006-not-applied');
  }

  if (!rows.length) return builtIn('seed:no-rows');

  const components = rows.map(r => ({ slug: r.slug, kind: r.kind, version: Number(r.version) }));
  return { library: snapshotFrom(rows), components, source: 'db', libraryVersion: libraryVersion(components) };
}

/** Which components exist and at which published version, without their
 *  payloads. This is what `libraryVersion` digests, and it is deliberately
 *  separate from `loadLibrary`: publishing the first component of a fresh
 *  library must be able to report the version it produced, and asking for a
 *  whole snapshot there would refuse — correctly, but for the wrong question. */
export async function loadComponents(sql) {
  if (!sql) return SEED_COMPONENTS();
  const rows = await sql`
    SELECT c.slug, c.kind, (
      SELECT max(version) FROM component_versions
      WHERE component_id = c.id AND status = 'published'
    ) AS version
    FROM components c
    WHERE c.status = 'active' AND c.org_id IS NULL
    ORDER BY c.id`;
  return rows.filter(r => r.version !== null).map(r => ({ slug: r.slug, kind: r.kind, version: Number(r.version) }));
}

/** The snapshot a spec pinned, at the exact versions it named.
 *
 *  This is the read path behind the §7.1 guarantee, and the only reason it
 *  can be relied on is that migration 006 refuses to update or delete a
 *  published row. A pin that cannot be resolved is therefore not a stale
 *  reference to tidy up — it means something got past the trigger, and it is
 *  reported as the incident it is rather than quietly falling back to the
 *  current version, which would silently change a card somebody ordered. */
export async function resolvePins(sql, pins) {
  const slugs = Object.keys(pins || {});
  if (!slugs.length) throw new Error('a spec with no pinned component versions cannot be resolved');

  if (!sql) {
    const seeded = builtIn('seed:no-database');
    const drifted = seeded.components.filter(c => pins[c.slug] !== undefined && pins[c.slug] !== c.version);
    if (drifted.length)
      throw new Error(`no database, so only version 1 of each component exists here; this spec pins ${drifted.map(c => `${c.slug}@${pins[c.slug]}`).join(', ')}`);
    return seeded;
  }

  const versions = slugs.map(s => Number(pins[s]));
  const rows = await sql`
    SELECT c.slug, c.kind, v.version, v.payload_json
    FROM components c
    JOIN component_versions v ON v.component_id = c.id
    WHERE (c.slug, v.version) IN (SELECT * FROM unnest(${slugs}::text[], ${versions}::int[]))
    ORDER BY c.id`;

  if (rows.length !== slugs.length) {
    const found = new Set(rows.map(r => `${r.slug}@${r.version}`));
    const lost = slugs.filter(s => !found.has(`${s}@${pins[s]}`));
    throw new Error(`a published component version this spec pins is no longer readable: ${lost.join(', ')}`);
  }

  const components = rows.map(r => ({ slug: r.slug, kind: r.kind, version: Number(r.version) }));
  return { library: snapshotFrom(rows), components, source: 'db:pinned', libraryVersion: libraryVersion(components) };
}

/* ── Making the database the authority ────────────────────────────────── */

/** Compose against a different library without editing `assets/engine.js`.
 *
 *  The engine holds its library as module-scope consts, so a snapshot is
 *  supplied by replacing the contents of those live objects rather than by
 *  rebinding them. Returns a restore function, because a caller that swaps
 *  the library for one request and leaves it swapped has changed what every
 *  later request in the same warm function instance composes.
 *
 *  It refuses an empty snapshot for the same reason `snapshotFrom` does: the
 *  failure would be a library that quietly stopped having any layouts in it. */
export function applySnapshot(E, library) {
  if (!library?.layouts?.length || !library.palettes?.length || !library.typeSystems?.length)
    throw new Error('refusing to compose against an empty library');

  const before = {
    layouts: E.LAYOUTS.slice(), palettes: E.PALETTES.slice(),
    typeSystems: E.TYPE_SYSTEMS.slice(), slotDefs: { ...E.SLOTDEFS }
  };

  const swap = (lib) => {
    E.LAYOUTS.splice(0, E.LAYOUTS.length, ...lib.layouts);
    E.PALETTES.splice(0, E.PALETTES.length, ...lib.palettes);
    E.TYPE_SYSTEMS.splice(0, E.TYPE_SYSTEMS.length, ...lib.typeSystems);
    for (const k of Object.keys(E.SLOTDEFS)) delete E.SLOTDEFS[k];
    Object.assign(E.SLOTDEFS, lib.slotDefs);
  };

  swap(library);
  return () => swap(before);
}

/* One swap at a time. `applySnapshot` mutates objects the whole module shares,
   so two requests composing against two different libraries inside one warm
   function instance would read each other's halves. Netlify usually hands an
   instance one request at a time and that is exactly the kind of usually that
   produces a card nobody can reproduce, so the swap is serialised rather than
   assumed safe. */
let libraryLock = Promise.resolve();

/** Run `fn` with the engine composing against `library`, then put it back.
 *
 *  A snapshot equal to what is already loaded is not swapped at all, so the
 *  common case — a deploy whose database holds exactly the seeded library —
 *  costs a comparison and nothing else. */
export function withLibrary(E, library, fn) {
  const run = async () => {
    const current = { layouts: E.LAYOUTS, palettes: E.PALETTES, typeSystems: E.TYPE_SYSTEMS, slotDefs: E.SLOTDEFS };
    if (deepEqual(current, library)) return await fn();
    const restore = applySnapshot(E, library);
    try { return await fn(); } finally { restore(); }
  };
  const next = libraryLock.then(run, run);
  libraryLock = next.then(() => undefined, () => undefined);
  return next;
}

/** The candidate-set cache key from §7.1, `sha256(vector, libraryVersion, seed)`.
 *
 *  Publishing rolls this and leaves `spec_hash` alone, which is the whole of
 *  the §7.1 contract in one line: the six concepts a brief returns may change
 *  when the library does, and a design already saved may not. */
export const candidateKey = ({ vector, libraryVersion: lv, seed }) =>
  crypto.createHash('sha256')
    .update(JSON.stringify([vector, lv, seed ?? null]))
    .digest('hex');

/* ── Font licensing, enforced where PRD §7 says to enforce it ────────────
   > Fonts: SIL OFL only, always outlined in output, never embedded. This is
   > a hard rule enforced at component-publish time, not a style guideline.

   Publish time is the only place it can be enforced without someone being
   hurt by it. A proprietary face refused at render is refused to a customer
   who has already chosen the design, already paid, and is waiting on a press
   file; refused here it is refused to the person who can simply pick another
   face. The rule is also not really about rendering at all — this writer
   outlines type rather than embedding it (`lib/pdf/writer.mjs`), and
   outlining a licensed face converts its letterforms into paths we then hand
   to a press, which most commercial licences treat as redistribution. OFL
   permits it. Nothing else in this repository does.

   The answer comes from D1's registry rather than from a list kept here:
   `vendoredFamilies()` reports what is actually on disk, and an `.OFL.txt`
   beside those binaries is the evidence of the licence they are under. A
   family with a binary and no licence file is refused exactly as loudly as
   one with neither — "we shipped it" is not a licence. */

/* fonts.mjs derives its filenames from a family name with this rule. It is
   private there and mirrored here, which is a seam: if it ever changes, this
   lookup misses and every type system stops publishing. That failure is loud
   and immediate rather than silent, and `tests/library.test.mjs` requires all
   five seeded type systems to pass this check, so the drift fails a build
   rather than quietly certifying nothing. */
const fontSlug = (family) => String(family).toLowerCase().replace(/[^a-z0-9]+/g, '-');

let _licensed = null;
function licensedFamilies() {
  if (_licensed) return _licensed;
  const vendored = vendoredFamilies();
  const licensed = new Map();
  let names = [];
  try { names = fs.readdirSync(FONT_DIR); } catch { names = []; }
  for (const n of names) {
    if (!n.endsWith('.OFL.txt')) continue;
    const slug = n.slice(0, -'.OFL.txt'.length);
    if (vendored[slug] && vendored[slug].length) licensed.set(slug, vendored[slug]);
  }
  /* An extractor that finds nothing must fail, not pass. An empty licence
     list would refuse every type system, which is safe but says nothing
     useful; the deploy is broken, and it should say that instead. */
  if (!licensed.size)
    throw new Error(`no OFL-licensed face is vendored in ${FONT_DIR}, so no type system can be published from this deploy`);
  _licensed = licensed;
  return _licensed;
}

/** Every family a type system is allowed to name, and the weights on disk. */
export const oflFamilies = () => Object.fromEntries(licensedFamilies());

/** Whether a CSS font stack names a face this project may print.
 *
 *  The stack is the engine's own — `"'Hind Siliguri',sans-serif"` — and only
 *  the first quoted family matters, because a press file has no fallback
 *  chain: whatever is outlined is what gets printed, permanently. */
export function fontLicence(cssStack) {
  const family = familyOf(cssStack);
  if (!family)
    return { ok: false, family: '', reason: `\`${cssStack}\` names no font family.` };

  const licensed = licensedFamilies();
  const slug = fontSlug(family);
  if (licensed.has(slug)) return { ok: true, family, slug, weights: licensed.get(slug) };

  const vendored = vendoredFamilies();
  const offer = [...licensed.keys()].join(', ');

  if (vendored[slug] && vendored[slug].length)
    return { ok: false, family, slug,
      reason: `${family} is vendored but carries no SIL OFL licence beside it. PRD §7 allows OFL faces only, ` +
              `because this writer outlines type into the press file rather than embedding it, and converting a ` +
              `licensed face to outlines is redistribution under most commercial licences. Publish against one of: ${offer}.` };

  return { ok: false, family, slug,
    reason: `${family} is not an SIL OFL face this project holds. PRD §7 makes that a hard rule at publish time, not ` +
            `a preference: the press file carries outlined letterforms, so printing ${family} would redistribute a ` +
            `face nobody here is licensed to redistribute — and it would be discovered at export, by a customer who ` +
            `has already paid. Publish against one of: ${offer}.` };
}

/** Whether a face can actually shape Bengali, asked of the font's own GSUB.
 *
 *  `banglaOk` is a claim, and until the shaper landed there was nothing that
 *  could check it. Now there is: `planFor` reads the face's tables and
 *  refuses by name when the Bengali script or its shaping features are not
 *  reachable in them. A type system that claimed `banglaOk` and named a
 *  Latin-only face would otherwise publish cleanly and be discovered as a
 *  refused export — or, before the shaper, as a card whose conjuncts were
 *  printed as disconnected letters, which the customer cannot see and the
 *  five hundred people handed the card can. */
export function banglaShaping(cssStack) {
  const family = familyOf(cssStack);
  let face;
  try { face = loadFace(cssStack, 400); }
  catch (err) { return { ok: false, family, reason: err.message }; }
  try { planFor(face); return { ok: true, family }; }
  catch (err) { return { ok: false, family, reason: err.message || String(err) }; }
}

/* ── Publishing ───────────────────────────────────────────────────────── */

const HEX = /^#[0-9a-fA-F]{6}$/;

/** What a payload has to be before it is allowed to become a published
 *  version. A published version is immutable, so a bad one is not a row to
 *  correct — it is a row that stays wrong forever with a newer row beside it,
 *  and everything composed in between carrying whatever it did. The checks
 *  are therefore at the door rather than at the first compose that breaks. */
export function validatePayload(kind, slug, payload) {
  const bad = (m, field) => ({ ok: false, reason: m, field });
  if (!payload || typeof payload !== 'object') return bad('A component version needs a payload.', 'payload');
  const { record, personality, compat } = payload;
  if (!record || typeof record !== 'object') return bad('A payload needs a `record` — the composable half.', 'payload.record');

  if (!personality || typeof personality !== 'object' || Array.isArray(personality))
    return bad('`personality` is weights, not tags — send an object of axis weights (§5.3).', 'payload.personality');
  for (const [axis, w] of Object.entries(personality))
    if (typeof w !== 'number' || !(w > 0) || w > 1)
      return bad(`personality.${axis} must be a weight above 0 and at most 1, not ${JSON.stringify(w)}.`, 'payload.personality');

  if (!compat || !Array.isArray(compat.requires) || !Array.isArray(compat.incompatible))
    return bad('`compat` is an expression — { requires: [], incompatible: [] } (§5.3).', 'payload.compat');
  for (const token of compat.requires)
    if (!PREDICATES[token])
      return bad(`compat.requires names ${token}, which nothing can evaluate. Known: ${Object.keys(PREDICATES).join(', ')}.`, 'payload.compat');

  if (kind === 'slot') {
    if (typeof payload.ref !== 'string' || !payload.ref) return bad('A slot definition carries the slot it defines as `ref`.', 'payload.ref');
    if (typeof record.required !== 'boolean') return bad('A slot definition declares whether it is required.', 'payload.record.required');
    if (typeof record.minPt !== 'number' && typeof record.minMm !== 'number')
      return bad('A slot definition declares a floor, in points for text or millimetres for a mark.', 'payload.record');
    return { ok: true };
  }

  if (record.id !== slug) return bad(`The record's id is ${record.id}; the component is ${slug}. A spec pins the slug, so the two cannot differ.`, 'payload.record.id');

  if (kind === 'lay') {
    if (!Array.isArray(record.slots) || !record.slots.length) return bad('A layout with no slots composes nothing.', 'payload.record.slots');
    if (record.face !== 'front' && record.face !== 'back') return bad('A layout is a front face or a back face.', 'payload.record.face');
    for (const s of record.slots)
      if (!Array.isArray(s.box) || s.box.length !== 4 || s.box.some(n => typeof n !== 'number'))
        return bad(`Slot ${s.ref} has no [x, y, w, h] box in grid units.`, 'payload.record.slots');
  }

  if (kind === 'pal') {
    for (const key of ['bg', 'fg', 'accent', 'muted', 'hair', 'panel'])
      if (!HEX.test(String(record[key])))
        return bad(`Palette ${slug} has no ${key} colour. All six are required — the renderer reads every one of them.`, `payload.record.${key}`);
  }

  if (kind === 'typ') {
    if (!record.latin || !record.bangla || record.banglaOk !== true)
      return bad('Every type system must declare a Bangla family. A system without one cannot be offered on a bilingual card, and this product does not have a Latin-only tier.', 'payload.record.bangla');

    /* PRD §7's hard rule, at the moment it says to apply it. A deploy with no
       vendored faces at all refuses here with that as the reason rather than
       throwing, so a broken deploy reads as a broken deploy. */
    let licence;
    try {
      for (const field of ['latin', 'bangla']) {
        licence = fontLicence(record[field]);
        if (!licence.ok) return bad(licence.reason, `payload.record.${field}`);
      }
    } catch (err) { return bad(err.message, 'payload.record'); }

    const shaping = banglaShaping(record.bangla);
    if (!shaping.ok) return bad(shaping.reason, 'payload.record.bangla');
  }

  return { ok: true };
}

/** Publish a new version of a component, creating the component if this is
 *  its first. The version number is assigned by the database, not here — see
 *  migration 006 for why that is safe under a race and why it is the one
 *  identifier in this codebase that is derived rather than sequence-given. */
export async function publishComponent(sql, { slug, kind, payload }) {
  if (!sql) throw new Error('publishing a component version needs a database');
  if (!KINDS[kind]) throw new Error(`unknown component kind ${kind}; known: ${Object.keys(KINDS).join(', ')}`);

  const check = validatePayload(kind, slug, payload);
  if (!check.ok) { const e = new Error(check.reason); e.field = check.field; e.code = 'bad_component'; throw e; }

  await sql`INSERT INTO components (slug, kind) VALUES (${slug}, ${kind}) ON CONFLICT (slug) DO NOTHING`;
  const [component] = await sql`SELECT id, kind FROM components WHERE slug = ${slug} LIMIT 1`;
  if (!component) throw new Error(`component ${slug} could not be created`);
  if (component.kind !== kind) {
    const e = new Error(`${slug} is already a ${KINDS[component.kind]}; a component cannot change kind, because specs pinning it were composed as one.`);
    e.code = 'kind_conflict'; e.field = 'kind';
    throw e;
  }

  const [row] = await sql`
    INSERT INTO component_versions (component_id, payload_json, status, published_at)
    VALUES (${component.id}, ${JSON.stringify(payload)}::jsonb, 'published', now())
    RETURNING version, published_at`;

  const components = await loadComponents(sql);
  return { slug, kind, version: Number(row.version), publishedAt: row.published_at,
           libraryVersion: libraryVersion(components), components };
}
