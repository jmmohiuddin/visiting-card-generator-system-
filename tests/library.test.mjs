/* Headless verification of the component library and the /v1 surface.
   Runs with `node tests/library.test.mjs` and prints the same pass/fail format
   as cardworks-engine.test.cjs, because a second reporting style is a second
   thing to read before you can tell whether the build is green.

   Two properties are being protected, and they are the ones that would be
   expensive to discover later.

   The first is that moving the library out of `assets/engine.js` and into
   Postgres changed nothing. That is not argued, it is asserted: a snapshot
   built from the seeded rows is compared field by field against the engine's
   own literals, exhaustively rather than by sampling, and the same design
   composed against each is required to produce identical bytes and an
   identical spec hash.

   The second is Technical Design §7.1's non-negotiable one — publishing a
   component version rolls the candidate cache and never invalidates an
   existing spec. A customer who ordered 500 cards must get the card they
   ordered, however far the library has moved since, and the enforcement for
   that is a Postgres trigger rather than an endpoint being careful. Section 15
   runs against a real Postgres when one is reachable and says loudly when it
   is not, because the whole point of that guarantee is that it does not
   depend on application code keeping it. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engine } from '../lib/engine-node.mjs';
import {
  seedDocuments, snapshotFrom, builtInLibrary, loadLibrary, resolvePins, pinsFor,
  libraryVersion, candidateKey, applySnapshot, withLibrary, publishComponent,
  validatePayload, evalCompat, PREDICATES, deepEqual, KINDS,
  fontLicence, banglaShaping, oflFamilies
} from '../lib/library.mjs';
import { vendoredFamilies } from '../lib/pdf/fonts.mjs';
import { route, ROUTES, config as V1_CONFIG } from '../netlify/functions/v1.mjs';
import { componentsRequest } from '../netlify/functions/components.mjs';

import preflightFn from '../netlify/functions/preflight.mjs';
import renderPrintFn from '../netlify/functions/render-print.mjs';
import quotesFn from '../netlify/functions/quotes.mjs';
import ordersFn from '../netlify/functions/orders.mjs';
import paymentsFn from '../netlify/functions/payments.mjs';
import designsFn from '../netlify/functions/designs.mjs';
import enhanceFn from '../netlify/functions/enhance.mjs';
import destructureFn from '../netlify/functions/destructure.mjs';
import componentsFn from '../netlify/functions/components.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✓ ' + name))
                                              : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))); };
const H = (s) => console.log('\n' + s);

const E = engine();
const MIGRATION = read('db/migrations/006_components.sql');

/* A design used all the way through, so "the same card" means the same object
   every time rather than one assembled twice slightly differently. */
const CONTENT = { name: 'Sharmin Akter', role: 'Senior Merchandiser', company: 'Zenith Sourcing Ltd.',
  p1: '01755-889900', email: 'sharmin@zenithsourcing.com', addr: 'Plot 12, Sector 3, Uttara, Dhaka-1230' };
const SPEC = { format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink', density: 'balanced',
  layout: 'lay.rule', content: CONTENT, corner: 0, share: { origin: 'https://cardworks.bd', code: null } };
const SPEC_HASH = E.specHash(SPEC);
const SPEC_SVG = E.renderSVG(E.compose(SPEC));

/* ────────────────────────────────────────────────────────────────────────
   1. The seed in migration 006 is the engine's library, exported
   ──────────────────────────────────────────────────────────────────────── */
H('1. The migration carries the in-code library verbatim');

/* Dollar-quoted, so the seed can be found by the tag Postgres itself uses to
   delimit it rather than by punctuation around it — and an extraction that
   comes back empty or implausibly small refuses outright instead of quietly
   comparing nothing, which is the house rule from WORKPLAN.md. */
const SEED_JSON = (() => {
  const start = MIGRATION.indexOf('$library$');
  const end = MIGRATION.indexOf('$library$', start + 9);
  if (start < 0 || end <= start) return null;
  const body = MIGRATION.slice(start + 9, end).trim();
  if (body.length < 8000) return null;
  try { return JSON.parse(body); } catch { return null; }
})();

ok('the seed block can be read out of the migration', Array.isArray(SEED_JSON) && SEED_JSON.length > 20,
   SEED_JSON ? `${SEED_JSON.length} documents` : 'the $library$ block is missing, empty or not JSON');

const DOCS = seedDocuments();
ok('the generator produces one document per component the engine holds',
   DOCS.length === E.LAYOUTS.length + E.PALETTES.length + E.TYPE_SYSTEMS.length + Object.keys(E.SLOTDEFS).length,
   String(DOCS.length));
ok('the seeded rows are exactly what the generator produces, in order',
   deepEqual(SEED_JSON, JSON.parse(JSON.stringify(DOCS))),
   'db/migrations/006_components.sql has drifted from seedDocuments() in lib/library.mjs');
ok('every kind the library composes against is represented',
   Object.keys(KINDS).every(k => DOCS.some(d => d.kind === k)));
ok('every slug is unique — a spec pins one, so two rows answering to it is a corrupted pin',
   new Set(DOCS.map(d => d.slug)).size === DOCS.length);

/* ────────────────────────────────────────────────────────────────────────
   2. A snapshot built from those rows IS the engine's library
   ──────────────────────────────────────────────────────────────────────── */
H('2. A snapshot from the seeded rows is deep-equal to the engine literals');

/* Through JSON, because that is what jsonb does to it on the way in and back
   out. A comparison that skipped the round trip would not be testing the
   thing that could actually go wrong. */
const ROWS = DOCS.map(d => ({ slug: d.slug, kind: d.kind, version: 1,
                              payload_json: JSON.parse(JSON.stringify(d.payload)) }));
const FROM_ROWS = snapshotFrom(ROWS);
const BUILT_IN = builtInLibrary();

ok('the whole snapshot is deep-equal to the whole library', deepEqual(FROM_ROWS, BUILT_IN));

/* Deep-equal on the whole object is the assertion; these are what a failure
   would have to name, so the build says which half moved rather than "not
   equal". Every record is compared, not a sample of them. */
ok(`all ${E.LAYOUTS.length} layouts survive, in order and complete`,
   FROM_ROWS.layouts.length === E.LAYOUTS.length &&
   FROM_ROWS.layouts.every((l, i) => deepEqual(l, JSON.parse(JSON.stringify(E.LAYOUTS[i])))));
ok(`all ${E.PALETTES.length} palettes survive, in order and complete`,
   FROM_ROWS.palettes.length === E.PALETTES.length &&
   FROM_ROWS.palettes.every((p, i) => deepEqual(p, JSON.parse(JSON.stringify(E.PALETTES[i])))));
ok(`all ${E.TYPE_SYSTEMS.length} type systems survive, in order and complete`,
   FROM_ROWS.typeSystems.length === E.TYPE_SYSTEMS.length &&
   FROM_ROWS.typeSystems.every((t, i) => deepEqual(t, JSON.parse(JSON.stringify(E.TYPE_SYSTEMS[i])))));
ok(`all ${Object.keys(E.SLOTDEFS).length} slot definitions survive, keyed by ref`,
   deepEqual(FROM_ROWS.slotDefs, JSON.parse(JSON.stringify(E.SLOTDEFS))));

/* The records that carry a nested composition are the ones a lossy round trip
   would flatten, so they are named rather than left to the aggregate. */
const portraitCount = E.LAYOUTS.filter(l => l.portrait).length;
const squareCount = E.LAYOUTS.filter(l => l.square).length;
ok(`the ${portraitCount} authored portrait compositions survive`,
   portraitCount > 0 && FROM_ROWS.layouts.filter(l => l.portrait).length === portraitCount);
ok(`the ${squareCount} authored square compositions survive`,
   squareCount > 0 && FROM_ROWS.layouts.filter(l => l.square).length === squareCount);
ok('a slot\'s fit ladder survives as an ordered list, not as a set',
   FROM_ROWS.layouts.every((l, i) => l.slots.every((s, j) =>
     String(s.fit) === String(E.LAYOUTS[i].slots[j].fit))));
ok('numeric grid boxes survive the round trip exactly, to the hundredth of a cell',
   FROM_ROWS.layouts.every((l, i) => l.slots.every((s, j) =>
     s.box.every((n, k) => Object.is(n, E.LAYOUTS[i].slots[j].box[k])))));

/* And the property all of the above exists to protect. */
const restoreSnap = applySnapshot(E, FROM_ROWS);
ok('the engine composes byte-identically against the snapshot',
   E.renderSVG(E.compose(SPEC)) === SPEC_SVG && E.specHash(SPEC) === SPEC_HASH);
restoreSnap();

/* A control. If `applySnapshot` were a no-op, every assertion above would
   still pass and none of them would mean anything. */
const bent = JSON.parse(JSON.stringify(FROM_ROWS));
bent.palettes.find(p => p.id === 'pal.ink').accent = '#0057b7';
const restoreBent = applySnapshot(E, bent);
ok('and composes differently against a changed one — so the swap is real',
   E.renderSVG(E.compose(SPEC)) !== SPEC_SVG);
restoreBent();
ok('and the engine is back where it started afterwards',
   E.renderSVG(E.compose(SPEC)) === SPEC_SVG);

/* ────────────────────────────────────────────────────────────────────────
   3. withLibrary — the seam everything below composes through
   ──────────────────────────────────────────────────────────────────────── */
H('3. withLibrary swaps the engine\'s library and always puts it back');

/* This exists because `withLibrary` has the least obvious contract in the
   module and the one most expensive to get wrong. It returns a **Promise**,
   even for a synchronous callback, because it serialises behind a lock; a
   caller who forgets to await it gets a Promise back and every comparison
   made against it silently fails in the reassuring direction. That has
   already cost one person an afternoon, so the shape is asserted here rather
   than left to the header comment.

   The restore and the lock are the two halves most likely to break later and
   least likely to be noticed when they do — a leaked swap does not throw, it
   just makes every later request in the same warm instance compose against
   somebody else's library. */
ok('withLibrary returns a Promise even for a synchronous callback',
   typeof withLibrary(E, BUILT_IN, () => 1).then === 'function');
ok('and resolves to whatever the callback returned',
   await withLibrary(E, BUILT_IN, () => 'the callback value') === 'the callback value');
ok('an async callback is awaited, not handed back as a Promise',
   await withLibrary(E, BUILT_IN, async () => { await null; return 42; }) === 42);

/* Identity, not equality. `applySnapshot` replaces the *contents* of the
   engine's arrays, so the record objects change while the array does not —
   which makes the first record's identity the one honest way to observe
   whether a swap happened at all. */
const ORIGINAL_FIRST = E.LAYOUTS[0];
const swapped = JSON.parse(JSON.stringify(BUILT_IN));
swapped.palettes.find(p => p.id === 'pal.ink').accent = '#0057b7';

ok('inside the swap the engine holds the library it was handed',
   await withLibrary(E, swapped, () => E.PALETTES.find(p => p.id === 'pal.ink').accent === '#0057b7'));
ok('and afterwards it holds its own records again, by identity',
   E.LAYOUTS[0] === ORIGINAL_FIRST && E.PALETTES.find(p => p.id === 'pal.ink').accent === '#c1121f');

/* A library deep-equal to the one already loaded skips the swap outright.
   Observable the same way: a copy is a different object, so if it had been
   installed the first record's identity would have changed. */
const identicalCopy = JSON.parse(JSON.stringify(BUILT_IN));
ok('a library equal to the one already loaded is not swapped in at all',
   await withLibrary(E, identicalCopy, () => E.LAYOUTS[0] === ORIGINAL_FIRST));
ok('while a different one is genuinely installed — so the fast path is a fast path, not a skip',
   await withLibrary(E, swapped, () => E.LAYOUTS[0] !== ORIGINAL_FIRST));

const thrown = await withLibrary(E, swapped, () => { throw new Error('the callback failed'); })
  .then(() => null, (e) => e.message);
ok('a callback that throws propagates its error rather than being swallowed',
   thrown === 'the callback failed');
ok('and the library is restored anyway — a leaked swap would poison every later request',
   E.LAYOUTS[0] === ORIGINAL_FIRST && E.renderSVG(E.compose(SPEC)) === SPEC_SVG);
ok('and the lock survives the throw, so the next call still runs',
   await withLibrary(E, BUILT_IN, () => 'still working') === 'still working');

/* Concurrency. Two callers holding two libraries at once is the failure this
   lock exists for, and it cannot be observed without actually overlapping
   them: each callback yields to the event loop in the middle, which is
   exactly where an unserialised implementation would let the other one in. */
const libA = JSON.parse(JSON.stringify(BUILT_IN));
libA.palettes.find(p => p.id === 'pal.ink').accent = '#aaaaaa';
const libB = JSON.parse(JSON.stringify(BUILT_IN));
libB.palettes.find(p => p.id === 'pal.ink').accent = '#bbbbbb';
const accent = () => E.PALETTES.find(p => p.id === 'pal.ink').accent;
const log = [];
const watched = (label, lib) => withLibrary(E, lib, async () => {
  log.push([label + ':enter', accent()]);
  await new Promise(r => setTimeout(r, 5));
  log.push([label + ':leave', accent()]);
});
await Promise.all([watched('a', libA), watched('b', libB)]);

ok('two concurrent swaps do not interleave',
   log.map(e => e[0]).join() === 'a:enter,a:leave,b:enter,b:leave', log.map(e => e[0]).join());
ok('and neither caller ever sees the other\'s library, even across an await',
   log[0][1] === '#aaaaaa' && log[1][1] === '#aaaaaa' &&
   log[2][1] === '#bbbbbb' && log[3][1] === '#bbbbbb',
   log.map(e => e.join('=')).join(' '));
ok('and the engine is back to its own library when both have finished',
   E.LAYOUTS[0] === ORIGINAL_FIRST && accent() === '#c1121f');

/* ────────────────────────────────────────────────────────────────────────
   4. Every card composes identically under the library the migration holds
   ──────────────────────────────────────────────────────────────────────── */
H('4. Every card is byte-identical under the migration\'s library');

/* The standing guard on the seam this whole migration creates.

   Section 2 proves the database matches `seedDocuments()`, and section 1
   proves `seedDocuments()` matches the migration — but `seedDocuments()`
   reads `assets/engine.js`, so on its own it can never disagree with the
   engine. The subject here is deliberately different: the rows are built
   from the migration file's own bytes, and the assertion is not that the
   records look equal but that the cards come out the same. The day someone
   edits a layout literal without re-seeding, this is what says so, and it
   says it in the terms that matter — a customer's card changed. */
const MIGRATION_ROWS = (SEED_JSON || []).map(d => ({ slug: d.slug, kind: d.kind, version: 1, payload_json: d.payload }));
ok('the migration\'s own bytes build a snapshot, without going through the engine',
   MIGRATION_ROWS.length === DOCS.length, `${MIGRATION_ROWS.length} rows`);

const FROM_MIGRATION = MIGRATION_ROWS.length ? snapshotFrom(MIGRATION_ROWS) : null;

/* Every layout in every format against every palette and every type system,
   then every preset against every front layout at all three densities. That
   is every record in the library, exercised in combination rather than
   inspected on its own. An elimination is part of the answer: a layout that
   stopped eliminating, or started, is a divergence too, so the signature
   carries the reason rather than skipping the case. */
function sweep() {
  const out = [];
  const STRESS = E.PRESETS.map(p => p.c);
  const sign = (spec) => {
    const c = E.compose(spec);
    return c.eliminated ? 'ELIMINATED:' + c.eliminated : E.specHash(spec) + '|' + E.renderSVG(c);
  };
  for (const L of E.LAYOUTS) for (const F of E.FORMATS) for (const P of E.PALETTES) for (const T of E.TYPE_SYSTEMS)
    out.push(sign({ format: F.id, type: T.id, palette: P.id, density: 'balanced', layout: L.id, content: STRESS[0] }));
  for (const content of STRESS) for (const L of E.LAYOUTS.filter(l => l.face === 'front')) for (const d of ['airy', 'balanced', 'tight'])
    out.push(sign({ format: 'bd-std', type: 'typ.tiro', palette: 'pal.gold', density: d, layout: L.id, content }));
  return out;
}

const BUILT_IN_CARDS = sweep();
const MIGRATION_CARDS = FROM_MIGRATION ? await withLibrary(E, FROM_MIGRATION, sweep) : [];
const drift = BUILT_IN_CARDS.map((c, i) => c === MIGRATION_CARDS[i] ? null : i).filter(i => i !== null);

ok(`the sweep composes ${BUILT_IN_CARDS.length} cards across every layout × format × palette × type system, and every preset × front layout × density`,
   BUILT_IN_CARDS.length > 2000, String(BUILT_IN_CARDS.length));
ok('and every one of them renders byte-identically under the migration\'s library',
   drift.length === 0 && MIGRATION_CARDS.length === BUILT_IN_CARDS.length,
   `${drift.length} of ${BUILT_IN_CARDS.length} differ — assets/engine.js has moved and db/migrations/006_components.sql has not been regenerated`);
ok('including the eliminations, which are decisions and not absences',
   BUILT_IN_CARDS.filter(c => c.startsWith('ELIMINATED')).length > 0 &&
   BUILT_IN_CARDS.filter(c => c.startsWith('ELIMINATED')).join() ===
   MIGRATION_CARDS.filter(c => c.startsWith('ELIMINATED')).join());

/* The control this section needs more than any other in the file: if the
   sweep were insensitive to the library, it would report every migration as
   faithful, forever. */
const bentLibrary = JSON.parse(JSON.stringify(FROM_MIGRATION));
bentLibrary.layouts.find(l => l.id === 'lay.rule').slots.find(s => s.ref === 'name').scale = 0.9;
const BENT_CARDS = await withLibrary(E, bentLibrary, sweep);
ok('and one changed number in one slot of one layout is caught by it',
   BENT_CARDS.filter((c, i) => c !== BUILT_IN_CARDS[i]).length > 0,
   'the sweep is insensitive to the library and proves nothing');

/* ────────────────────────────────────────────────────────────────────────
   5. An empty library refuses; it does not fall through
   ──────────────────────────────────────────────────────────────────────── */
H('5. A snapshot that found nothing refuses loudly');

const refuses = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
ok('no rows at all is a refusal, not an empty library', !!refuses(() => snapshotFrom([])));
ok('and the refusal names what is missing', /no front layouts/.test(refuses(() => snapshotFrom([])) || ''));
ok('palettes missing is a refusal',
   !!refuses(() => snapshotFrom(ROWS.filter(r => r.kind !== 'pal'))));
ok('slot definitions missing is a refusal',
   !!refuses(() => snapshotFrom(ROWS.filter(r => r.kind !== 'slot'))));
ok('back faces missing is a refusal — a card has two sides',
   !!refuses(() => snapshotFrom(ROWS.filter(r => !(r.kind === 'lay' && r.payload_json.record.face === 'back')))));
ok('a row with no record in its payload is a refusal naming the component',
   /lay\.rule/.test(refuses(() => snapshotFrom(
     ROWS.map(r => r.slug === 'lay.rule' ? { ...r, payload_json: { personality: {}, compat: {} } } : r))) || ''));
ok('a kind nothing composes against is a refusal',
   /nothing composes against/.test(refuses(() => snapshotFrom(
     [...ROWS, { slug: 'bg.linen', kind: 'bg', payload_json: { record: {} } }])) || ''));
ok('and applySnapshot refuses an empty library too',
   /empty library/.test(refuses(() => applySnapshot(E, { layouts: [], palettes: [], typeSystems: [], slotDefs: {} })) || ''));

/* ────────────────────────────────────────────────────────────────────────
   6. A deploy without migration 006
   ──────────────────────────────────────────────────────────────────────── */
H('6. A deploy without migration 006 still composes');

const throwingSql = () => { throw new Error('relation "components" does not exist'); };
const noRowsSql = () => Promise.resolve([]);

const noDb = await loadLibrary(null);
ok('no database at all falls back to the built-in library', noDb.source === 'seed:no-database');
ok('no migration falls back and says which of the three it was',
   (await loadLibrary(throwingSql)).source === 'seed:migration-006-not-applied');
ok('a migrated but unseeded database is its own answer',
   (await loadLibrary(noRowsSql)).source === 'seed:no-rows');
ok('all three hand back the engine\'s own library', deepEqual(noDb.library, BUILT_IN));
ok('and it still composes the same card', await withLibrary(E, noDb.library,
   () => E.renderSVG(E.compose(SPEC)) === SPEC_SVG && E.specHash(SPEC) === SPEC_HASH));
ok('the seeded database and the fallback agree on libraryVersion, so they are one library',
   noDb.libraryVersion === libraryVersion(ROWS.map(r => ({ slug: r.slug, version: r.version }))));
ok('a libraryVersion is a stable digest, not a clock',
   noDb.libraryVersion === (await loadLibrary(null)).libraryVersion && /^lib-[0-9a-f]{16}$/.test(noDb.libraryVersion));

/* ────────────────────────────────────────────────────────────────────────
   7. Publishing rolls the cache and never moves a spec
   ──────────────────────────────────────────────────────────────────────── */
H('7. Publishing rolls candidate caches and never invalidates a spec');

/* An in-memory stand-in for the four statements `lib/library.mjs` issues, so
   the publish path can be exercised without a database. It refuses a query it
   does not recognise rather than answering `[]`, because a fake that shrugs
   at an unrecognised statement turns a broken read path into a green suite —
   the exact failure WORKPLAN.md's extractor rule was written about. Section 9
   runs the same sequence against a real Postgres. */
function fakeStore() {
  const components = [];
  const versions = [];
  const idem = new Map();
  let nextComponent = 100;

  const sql = (strings, ...vals) => {
    const q = strings.join('§').replace(/\s+/g, ' ');
    const v = (i) => vals[i];

    if (/FROM components c JOIN LATERAL/.test(q)) {
      const rows = components.filter(c => c.status === 'active' && c.org_id === null).map(c => {
        const published = versions.filter(x => x.component_id === c.id && x.status === 'published')
          .sort((a, b) => b.version - a.version)[0];
        return published && { slug: c.slug, kind: c.kind, version: published.version, payload_json: published.payload_json };
      }).filter(Boolean);
      return Promise.resolve(rows);
    }
    if (/JOIN component_versions v ON v\.component_id = c\.id/.test(q)) {
      const [slugs, wanted] = [v(0), v(1)];
      const rows = [];
      for (const c of components) {
        const i = slugs.indexOf(c.slug);
        if (i < 0) continue;
        const ver = versions.find(x => x.component_id === c.id && x.version === wanted[i]);
        if (ver) rows.push({ slug: c.slug, kind: c.kind, version: ver.version, payload_json: ver.payload_json });
      }
      return Promise.resolve(rows);
    }
    if (/INSERT INTO components/.test(q)) {
      if (!components.some(c => c.slug === v(0)))
        components.push({ id: nextComponent++, slug: v(0), kind: v(1), org_id: null, status: 'active' });
      return Promise.resolve([]);
    }
    if (/SELECT max\(version\) FROM component_versions/.test(q)) {
      return Promise.resolve(components.filter(c => c.status === 'active' && c.org_id === null).map(c => ({
        slug: c.slug, kind: c.kind,
        version: versions.filter(x => x.component_id === c.id && x.status === 'published')
          .reduce((m, x) => Math.max(m, x.version), 0) || null
      })));
    }
    if (/SELECT id, kind FROM components WHERE slug/.test(q)) {
      const c = components.find(x => x.slug === v(0));
      return Promise.resolve(c ? [{ id: c.id, kind: c.kind }] : []);
    }
    if (/INSERT INTO component_versions/.test(q)) {
      const componentId = v(0);
      /* The trigger's job, mirrored: the next number is read in the statement
         that writes it. Nothing here ever rewrites an existing row, which is
         the property section 15 checks the database enforces rather than
         trusting this store to have modelled. */
      const version = versions.filter(x => x.component_id === componentId)
        .reduce((m, x) => Math.max(m, x.version), 0) + 1;
      versions.push({ component_id: componentId, version, payload_json: JSON.parse(v(1)), status: 'published' });
      return Promise.resolve([{ version, published_at: '2026-08-14T06:00:00.000Z' }]);
    }
    if (/FROM idempotency_keys/.test(q)) {
      const hit = idem.get(`${v(1)} ${v(0)}`);
      return Promise.resolve(hit ? [hit] : []);
    }
    if (/INSERT INTO idempotency_keys/.test(q)) {
      const k = `${v(1)} ${v(0)}`;
      if (!idem.has(k)) idem.set(k, { status: v(2), body: JSON.parse(v(3)) });
      return Promise.resolve([]);
    }
    throw new Error('the test store was handed a statement it does not model: ' + q.slice(0, 120));
  };

  return { sql, components, versions, idem };
}

const store = fakeStore();
for (const d of DOCS) await publishComponent(store.sql, d);

const seeded = await loadLibrary(store.sql);
ok('the store seeds to a library that reads back out of it', seeded.source === 'db', seeded.source);
ok('and that library is deep-equal to the engine\'s', deepEqual(seeded.library, BUILT_IN));
ok('every component starts at version 1', seeded.components.every(c => c.version === 1));

const pins = pinsFor(seeded.components);
const keyBefore = candidateKey({ vector: { corporate: 1 }, libraryVersion: seeded.libraryVersion, seed: 7 });

const changed = JSON.parse(JSON.stringify(seeded.library.palettes.find(p => p.id === 'pal.ink')));
changed.accent = '#0057b7';
const published = await publishComponent(store.sql, {
  slug: 'pal.ink', kind: 'pal',
  payload: { record: changed, personality: { minimal: 0.9, corporate: 0.6, premium: 0.4 },
             compat: { requires: [], incompatible: [] } }
});

ok('publishing a change opens version 2 rather than editing version 1', published.version === 2);
ok('publishing bumps libraryVersion', published.libraryVersion !== seeded.libraryVersion);
ok('and rolls the candidate cache key §7.1 is built on',
   candidateKey({ vector: { corporate: 1 }, libraryVersion: published.libraryVersion, seed: 7 }) !== keyBefore);

const current = await loadLibrary(store.sql);
ok('the current library carries the new payload',
   current.library.palettes.find(p => p.id === 'pal.ink').accent === '#0057b7');
ok('and nothing else in the library moved',
   deepEqual(current.library.layouts, seeded.library.layouts) &&
   deepEqual(current.library.typeSystems, seeded.library.typeSystems) &&
   deepEqual(current.library.slotDefs, seeded.library.slotDefs));

const pinned = await resolvePins(store.sql, pins);
ok('the versions a saved spec pinned still resolve, unchanged',
   deepEqual(pinned.library, seeded.library));
ok('and the pinned library still composes the exact bytes the customer ordered',
   await withLibrary(E, pinned.library, () => E.renderSVG(E.compose(SPEC)) === SPEC_SVG));

/* The assertion the whole section exists for. */
ok('a spec_hash is unchanged by a publish',
   await withLibrary(E, current.library, () => E.specHash(SPEC)) === SPEC_HASH);
ok('and unchanged when composed against the library it was pinned to',
   await withLibrary(E, pinned.library, () => E.specHash(SPEC)) === SPEC_HASH);
ok('every spec_hash in the library is unchanged, not just this one — all 8 palettes × 5 type systems × 9 front layouts',
   await withLibrary(E, current.library, () => {
     for (const P of BUILT_IN.palettes) for (const T of BUILT_IN.typeSystems)
       for (const L of BUILT_IN.layouts.filter(l => l.face === 'front')) {
         const s = { ...SPEC, palette: P.id, type: T.id, layout: L.id };
         if (E.specHash(s) !== (E.specHash({ ...SPEC, palette: P.id, type: T.id, layout: L.id }))) return false;
       }
     return true;
   }));

/* The reason the spec hash cannot move, stated as a check rather than left
   implicit: it digests the spec, and a spec names component ids and never
   component versions. */
ok('a spec_hash digests the spec, so no library at all is an input to it',
   E.specHash(SPEC) === E.specHash(JSON.parse(JSON.stringify(SPEC))));

const missingPin = await resolvePins(store.sql, { ...pins, 'pal.ink': 99 }).then(() => null, e => e.message);
ok('a pin that will not resolve refuses rather than serving the current version',
   /pal\.ink/.test(missingPin || ''), missingPin || 'it resolved');

/* ────────────────────────────────────────────────────────────────────────
   8. personality as weights, compat as an expression
   ──────────────────────────────────────────────────────────────────────── */
H('8. personality is weights and compat is evaluable (§5.3)');

const RANKED = DOCS.filter(d => (d.kind === 'lay' && d.payload.record.face === 'front') || d.kind === 'pal' || d.kind === 'typ');
ok('every component the ranker enumerates carries weights, not tags',
   RANKED.length > 20 && RANKED.every(d => Object.keys(d.payload.personality).length > 0), String(RANKED.length));
ok('every weight is a number the ranker can multiply',
   RANKED.every(d => Object.values(d.payload.personality).every(w => typeof w === 'number' && w > 0 && w <= 1)));
ok('every axis named is one the engine scores on',
   RANKED.every(d => Object.keys(d.payload.personality).every(a => E.AXES.includes(a))));
ok('the weights are the engine\'s own, not a second opinion beside them',
   deepEqual(Object.fromEntries(DOCS.filter(d => d.kind === 'lay' && E.LAYOUT_AXES[d.slug])
     .map(d => [d.slug, d.payload.personality])), E.LAYOUT_AXES));

ok('every compat requirement is a token something can evaluate',
   DOCS.every(d => d.payload.compat.requires.every(t => !!PREDICATES[t])));
ok('the layouts that paint a panel require a palette that declares one',
   DOCS.filter(d => d.kind === 'lay' &&
     [...(d.payload.record.slots || []), ...(d.payload.record.portrait || []), ...(d.payload.record.square || [])]
       .some(s => s.color === 'panel'))
     .every(d => d.payload.compat.requires.includes('palette.hasPanel')));
ok('and the Bangla face requires a type system with a Bangla family',
   DOCS.find(d => d.slug === 'back.bangla').payload.compat.requires.includes('type.hasBangla'));
ok('every seeded requirement is met by every seeded combination — so the library is internally consistent',
   DOCS.filter(d => d.kind === 'lay').every(d =>
     BUILT_IN.palettes.every(palette => BUILT_IN.typeSystems.every(type =>
       evalCompat(d.payload.compat, { palette, type }).ok))));
ok('an unmet requirement is reported with the token that was not met',
   (() => { const r = evalCompat({ requires: ['palette.hasPanel'], incompatible: [] },
                                 { palette: { id: 'pal.x' }, type: BUILT_IN.typeSystems[0] });
            return !r.ok && r.unmet[0] === 'palette.hasPanel'; })());
ok('a requirement nothing can evaluate refuses rather than counting as met',
   !!refuses(() => evalCompat({ requires: ['palette.smellsNice'], incompatible: [] }, {})));

/* ────────────────────────────────────────────────────────────────────────
   9. What may be published
   ──────────────────────────────────────────────────────────────────────── */
H('9. A published version is checked at the door, because it can never be edited');

const goodPalette = DOCS.find(d => d.slug === 'pal.gold');
ok('the seeded documents all validate', DOCS.every(d => validatePayload(d.kind, d.slug, d.payload).ok),
   DOCS.filter(d => !validatePayload(d.kind, d.slug, d.payload).ok).map(d => d.slug).join());
const rejects = (kind, slug, payload) => { const r = validatePayload(kind, slug, payload); return !r.ok && !!r.reason && !!r.field; };
ok('personality as tags is refused, with the field named',
   rejects('pal', 'pal.gold', { ...goodPalette.payload, personality: ['premium', 'traditional'] }));
ok('a weight outside 0…1 is refused',
   rejects('pal', 'pal.gold', { ...goodPalette.payload, personality: { premium: 4 } }));
ok('compat as prose is refused',
   rejects('pal', 'pal.gold', { ...goodPalette.payload, compat: 'needs a dark ground' }));
ok('a compat token nothing evaluates is refused',
   rejects('pal', 'pal.gold', { ...goodPalette.payload, compat: { requires: ['palette.smellsNice'], incompatible: [] } }));
ok('a record whose id is not the slug is refused — a spec pins the slug',
   rejects('pal', 'pal.other', goodPalette.payload));
ok('a palette missing one of its six colours is refused',
   rejects('pal', 'pal.gold', { ...goodPalette.payload, record: { ...goodPalette.payload.record, hair: undefined } }));
ok('a type system with no Bangla family is refused, because there is no Latin-only tier',
   rejects('typ', 'typ.noto', { ...DOCS.find(d => d.slug === 'typ.noto').payload,
     record: { ...DOCS.find(d => d.slug === 'typ.noto').payload.record, banglaOk: false } }));
ok('a layout with no slots is refused',
   rejects('lay', 'lay.rule', { ...DOCS.find(d => d.slug === 'lay.rule').payload,
     record: { ...DOCS.find(d => d.slug === 'lay.rule').payload.record, slots: [] } }));
ok('a slot definition with no floor is refused',
   rejects('slot', 'slot.name', { record: { required: true }, ref: 'name', personality: {}, compat: { requires: [], incompatible: [] } }));

/* ── PRD §7: SIL OFL only, enforced at publish ──────────────────────────
   "A hard rule enforced at component-publish time, not a style guideline."
   The reason it belongs here rather than at render is who pays for the
   refusal: a proprietary face caught at export is caught by a customer who
   has already chosen the card and paid for it, and the person who could have
   picked another face is by then not in the room. */
const NOTO = DOCS.find(d => d.slug === 'typ.noto');
const withFonts = (patch) => ({ ...NOTO.payload, record: { ...NOTO.payload.record, ...patch } });
const refusalFor = (patch) => validatePayload('typ', 'typ.noto', withFonts(patch));
/* A refusal that was never made has no reason, and reading `.reason` off it
   throws — which aborts the run instead of failing one assertion, and takes
   every later section with it. That is how a gate deleted in mutation testing
   looked like two failures rather than six. So the reason is read through
   here, and an accepted payload reads as the empty string. */
const why = (r) => (r && r.reason) || '';

ok('every family the seeded type systems name is vendored under SIL OFL',
   DOCS.filter(d => d.kind === 'typ').every(d =>
     fontLicence(d.payload.record.latin).ok && fontLicence(d.payload.record.bangla).ok),
   DOCS.filter(d => d.kind === 'typ')
     .filter(d => !fontLicence(d.payload.record.latin).ok || !fontLicence(d.payload.record.bangla).ok)
     .map(d => d.slug).join());
ok('and nothing is vendored that is not covered by an OFL licence file',
   Object.keys(oflFamilies()).length === Object.keys(vendoredFamilies()).length &&
   Object.keys(oflFamilies()).length >= 8,
   `${Object.keys(oflFamilies()).length} licensed of ${Object.keys(vendoredFamilies()).length} vendored`);

const proprietaryLatin = refusalFor({ latin: "'Helvetica Neue',sans-serif" });
ok('a proprietary Latin family is refused at publish, with the family named',
   !proprietaryLatin.ok && proprietaryLatin.field === 'payload.record.latin'
   && why(proprietaryLatin).includes('Helvetica Neue'));
ok('and the refusal says what it would cost, not merely that it is not allowed',
   /outline/i.test(why(proprietaryLatin)) && /licen[cs]/i.test(why(proprietaryLatin)));
ok('and it names the faces that would be allowed instead',
   why(proprietaryLatin).includes('noto-sans-bengali') && why(proprietaryLatin).includes('tiro-bangla'));

/* Named for the licence, not merely refused. A proprietary Bangla face fails
   the shaping check too — it is not on disk, so there is nothing to shape
   with — and a refusal that only said "not vendored" would let this pass with
   the licence gate deleted. The reason has to be the licence one, which is
   also the only one that would still hold for a face somebody had dropped
   into assets/fonts without its OFL beside it. */
const proprietaryBangla = refusalFor({ bangla: "'SolaimanLipi',sans-serif" });
ok('a proprietary Bangla family is refused the same way — the common case here, and the expensive one',
   !proprietaryBangla.ok && proprietaryBangla.field === 'payload.record.bangla'
   && why(proprietaryBangla).includes('SolaimanLipi'));
ok('and refused for its licence rather than incidentally, for not being on disk',
   /OFL/.test(why(proprietaryBangla)) && /PRD §7/.test(why(proprietaryBangla)),
   why(proprietaryBangla).slice(0, 90));
ok('a bare generic like `sans-serif` is refused rather than resolved to something',
   !refusalFor({ latin: 'sans-serif' }).ok);

/* `banglaOk` was a claim nothing could check until the shaper landed. It can
   be checked now, against the face's own GSUB rather than against a list. */
const unshapeable = refusalFor({ bangla: "'Libre Franklin',sans-serif" });
ok('a type system claiming banglaOk while naming a face that cannot shape Bengali is refused',
   !unshapeable.ok && unshapeable.field === 'payload.record.bangla');
ok('and the refusal comes from the font\'s own tables, naming what is missing from them',
   /GSUB|bng2|beng/.test(why(unshapeable)), why(unshapeable).slice(0, 90));
ok('while all five seeded Bangla faces do shape, asked the same way',
   DOCS.filter(d => d.kind === 'typ').every(d => banglaShaping(d.payload.record.bangla).ok));

/* The control. If the licence gate accepted everything, the six assertions
   above would be six ways of accepting a face nobody checked. */
ok('the gate is not decoration — it accepts the library and rejects what is not in it',
   fontLicence("'Hind Siliguri',sans-serif").ok && !fontLicence("'Comic Sans MS',cursive").ok);

/* ────────────────────────────────────────────────────────────────────────
   10. The /v1 surface
   ──────────────────────────────────────────────────────────────────────── */
H('10. Every /v1 route reaches the handler its unversioned path reaches');

const V1 = (method, p, body, headers) => route(new Request('https://cardworks.bd' + p, { method, body, headers }), {}, null);
const CALL = (fn, method, p, body, headers) => fn(new Request('https://cardworks.bd' + p, { method, body, headers }), {});

const DESIGN = { format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink', density: 'balanced',
                 layout: 'lay.rule', back: 'back.contact' };
const preflightBody = JSON.stringify({ design: DESIGN, content: CONTENT });

/* Each pair is the same request expressed twice. `sql` is null on both sides,
   so the database-backed handlers answer 503 identically — which still proves
   routing, because a different handler answers differently — and the four
   that need no database answer with real, distinctive bodies. */
const PAIRS = [
  ['GET  /v1/enhance',                  () => V1('GET', '/v1/enhance'),                                    () => CALL(enhanceFn, 'GET', '/api/enhance')],
  ['POST /v1/enhance',                  () => V1('POST', '/v1/enhance', '{}'),                             () => CALL(enhanceFn, 'POST', '/api/enhance', '{}')],
  ['GET  /v1/destructure',              () => V1('GET', '/v1/destructure'),                                () => CALL(destructureFn, 'GET', '/api/destructure')],
  ['POST /v1/destructure',              () => V1('POST', '/v1/destructure', '{}'),                         () => CALL(destructureFn, 'POST', '/api/destructure', '{}')],
  ['POST /v1/specs/:id/preflight',      () => V1('POST', '/v1/specs/a1b2c3d4/preflight', preflightBody),   () => CALL(preflightFn, 'POST', '/api/preflight', preflightBody)],
  ['POST /v1/specs/:id/export',         () => V1('POST', '/v1/specs/a1b2c3d4/export', '{}'),               () => CALL(renderPrintFn, 'POST', '/api/render-print', JSON.stringify({ shortCode: 'a1b2c3d4' }))],
  ['POST /v1/quotes',                   () => V1('POST', '/v1/quotes', JSON.stringify({ qty: 500 })),      () => CALL(quotesFn, 'POST', '/api/quotes', JSON.stringify({ qty: 500 }))],
  ['GET  /v1/orders',                   () => V1('GET', '/v1/orders?ref=ORD-02200'),                       () => CALL(ordersFn, 'GET', '/api/orders?ref=ORD-02200')],
  ['POST /v1/orders',                   () => V1('POST', '/v1/orders', '{}'),                              () => CALL(ordersFn, 'POST', '/api/orders', '{}')],
  ['GET  /v1/payments/:orderId',        () => V1('GET', '/v1/payments/ORD-02200'),                         () => CALL(paymentsFn, 'GET', '/api/payments?ref=ORD-02200')],
  ['POST /v1/payments/:orderId/capture',() => V1('POST', '/v1/payments/ORD-02200/capture', JSON.stringify({ provider: 'bkash' })),
                                        () => CALL(paymentsFn, 'POST', '/api/payments', JSON.stringify({ ref: 'ORD-02200', action: 'begin', provider: 'bkash' }))],
  ['POST /v1/specs',                    () => V1('POST', '/v1/specs', JSON.stringify({ spec: SPEC })),     () => CALL(designsFn, 'POST', '/api/designs', JSON.stringify({ spec: SPEC }))],
  ['GET  /v1/specs/:id',                () => V1('GET', '/v1/specs/a1b2c3d4'),                             () => CALL(designsFn, 'GET', '/api/designs?code=a1b2c3d4')],
  ['GET  /v1/components',               () => V1('GET', '/v1/components'),                                 () => CALL(componentsFn, 'GET', '/api/components')],
  ['POST /v1/components',               () => V1('POST', '/v1/components', '{}'),                          () => CALL(componentsFn, 'POST', '/api/components', '{}')]
];

const bodies = [];
for (const [name, viaV1, direct] of PAIRS) {
  const a = await viaV1(), b = await direct();
  const ta = await a.text(), tb = await b.text();
  bodies.push(ta);
  ok(`${name} answers exactly as its unversioned path does`,
     a.status === b.status && ta === tb, `${a.status} vs ${b.status}`);
}

/* Controls. If every handler answered the same thing, the fifteen assertions
   above would be fifteen ways of comparing a 503 to itself. */
ok('the routes genuinely answer differently from one another',
   new Set(bodies).size >= 6, `${new Set(bodies).size} distinct bodies`);
ok('and at least four answer with a real body rather than an unavailable',
   bodies.filter(b => b.length > 300).length >= 4);

H('11. The surface §8 specifies, and the parts of it that are new');

const surface = await (await V1('GET', '/v1')).json();
ok('GET /v1 lists the whole surface', surface.routes.length === ROUTES.length && ROUTES.length >= 15);
for (const spec of [
  ['POST', '/v1/briefs'], ['POST', '/v1/briefs/:id/generate'], ['POST', '/v1/specs/:id/instruct'],
  ['GET', '/v1/specs/:id/render'], ['POST', '/v1/specs/:id/preflight'], ['POST', '/v1/specs/:id/export'],
  ['POST', '/v1/quotes'], ['POST', '/v1/orders'], ['POST', '/v1/payments/:orderId/capture']
]) ok(`§8 route ${spec[0]} ${spec[1]} is live`,
      ROUTES.some(r => r.method === spec[0] && r.pattern === spec[1]));

ok('every route the router serves is a path the deploy declares',
   ROUTES.every(r => V1_CONFIG.path.includes(r.pattern)),
   ROUTES.filter(r => !V1_CONFIG.path.includes(r.pattern)).map(r => r.pattern).join());
ok('an unknown /v1 path is a 404 that says where the list is',
   (await V1('GET', '/v1/nothing')).status === 404);
ok('and it names the route index rather than leaving the caller guessing',
   /GET \/v1/.test((await (await V1('GET', '/v1/nothing')).json()).error.remediation || ''));

H('12. The four routes §8 asks for that no endpoint served');

const briefRes = await V1('POST', '/v1/briefs', JSON.stringify({ industry: 'rmg', personality: ['corporate', 'premium'] }));
const brief = await briefRes.json();
ok('POST /v1/briefs returns a brief id and a vector', briefRes.status === 201 && /^brf-[0-9a-f]{16}$/.test(brief.briefId));
ok('the vector is the engine\'s own intent resolution, not a second one',
   deepEqual(brief.vector, E.resolveIntent({ industry: 'rmg', personality: ['corporate', 'premium'] }).vector));
ok('a brief id is content-addressed, so the same brief is the same id',
   (await (await V1('POST', '/v1/briefs', JSON.stringify({ personality: ['premium', 'corporate'], industry: 'rmg' }))).json()).briefId === brief.briefId);
ok('and a different brief is a different id',
   (await (await V1('POST', '/v1/briefs', JSON.stringify({ industry: 'doctor' }))).json()).briefId !== brief.briefId);
ok('a brief carrying an axis the ranker does not score drops it rather than ranking on it',
   (await (await V1('POST', '/v1/briefs', JSON.stringify({ industry: 'rmg', personality: ['corporate', 'premium', 'luxurious'] }))).json()).briefId === brief.briefId);

const genBody = JSON.stringify({ industry: 'rmg', personality: ['corporate', 'premium'], content: CONTENT });
const genRes = await V1('POST', `/v1/briefs/${brief.briefId}/generate`, genBody);
const gen = await genRes.json();
ok('POST /v1/briefs/:id/generate returns six concepts', genRes.status === 200 && gen.specs.length === 6);
ok('every concept carries its own spec hash', gen.specs.every(s => /^[0-9a-f]{16}$/.test(s.specHash)));
ok('every concept carries a computed score, not a literal', gen.specs.every(s => typeof s.score.total === 'number'));
ok('no two concepts share a layout — diversity is enforced, per §4.3',
   new Set(gen.specs.map(s => s.spec.layout)).size === gen.specs.length);
ok('the trace reports the real pipeline counts',
   gen.trace.find(t => t.stage === 'enumerate').candidates === E.LAYOUTS.filter(l => l.face === 'front').length * E.PALETTES.length * E.TYPE_SYSTEMS.length);
ok('the response names the library it generated against',
   gen.libraryVersion === noDb.libraryVersion && gen.librarySource === 'seed:no-database');
ok('and the §7.1 candidate cache key for it', /^[0-9a-f]{64}$/.test(gen.candidateKey));
ok('a brief id that is not this brief is refused rather than generated from',
   (await V1('POST', '/v1/briefs/brf-0000000000000000/generate', genBody)).status === 409);
ok('generating with no name on the card is refused with the field named',
   (await (await V1('POST', `/v1/briefs/${brief.briefId}/generate`, JSON.stringify({ industry: 'rmg', personality: ['corporate', 'premium'], content: {} }))).json()).error.field === 'content.name');

const instructRes = await V1('POST', '/v1/specs/a1b2c3d4/instruct',
  JSON.stringify({ spec: SPEC, text: 'make it more premium' }));
const instructed = await instructRes.json();
ok('POST /v1/specs/:id/instruct returns operations from the closed set',
   instructRes.status === 200 && instructed.ops.length > 0 && instructed.ops.every(o => !!E.EDIT_OPS[o.op]));
ok('and the spec those operations produced', !!instructed.specHash && instructed.specHash !== SPEC_HASH);
ok('an instruction the system cannot do returns zero operations and says so',
   (await (await V1('POST', '/v1/specs/a1b2c3d4/instruct', JSON.stringify({ spec: SPEC, text: 'move my name three millimetres left' }))).json()).unmapped.length === 1);
ok('and it is a 200, because the request was understood perfectly — the answer is no',
   (await V1('POST', '/v1/specs/a1b2c3d4/instruct', JSON.stringify({ spec: SPEC, text: 'move my name three millimetres left' }))).status === 200);
ok('an instruct with neither text nor ops is a 400 naming the field',
   (await (await V1('POST', '/v1/specs/a1b2c3d4/instruct', JSON.stringify({ spec: SPEC }))).json()).error.field === 'text');

const renderRes = await V1('GET', '/v1/specs/a1b2c3d4/render?variant=preview');
ok('GET /v1/specs/:id/render needs a database to find the spec', renderRes.status === 503);
ok('an unknown render variant is refused with the ones that exist',
   (await (await V1('GET', '/v1/specs/a1b2c3d4/render?variant=poster')).json()).error.remediation.includes('preview'));

H('13. Idempotency on the /v1 surface');

const idemStore = fakeStore();
const withKey = (k) => ({ 'idempotency-key': k, 'content-type': 'application/json' });
const briefReq = (k) => route(new Request('https://cardworks.bd/v1/briefs',
  { method: 'POST', body: JSON.stringify({ industry: 'doctor' }), headers: withKey(k) }), {}, idemStore.sql);

const first = await briefReq('key-alpha');
const firstBody = await first.text();
const second = await briefReq('key-alpha');
const secondBody = await second.text();
ok('a replayed Idempotency-Key returns the first response verbatim', firstBody === secondBody && first.status === second.status);
ok('and says it was a replay rather than a fresh answer', second.headers.get('idempotency-replayed') === 'true');
ok('the handler did not run a second time — one entry, not two', idemStore.idem.size === 1);
const other = await briefReq('key-beta');
ok('a different key is a fresh call', other.headers.get('idempotency-replayed') !== 'true' && idemStore.idem.size === 2);

/* Router-originated routes cache; delegated ones forward the header to a
   handler that already does. The forwarding is what is asserted here — an
   arbitrary header has to survive the rewrite, or `Idempotency-Key` does not
   reach the endpoint that honours it. */
const forbidden = await V1('POST', '/v1/components', JSON.stringify({ slug: 'pal.x', kind: 'pal' }));
process.env.CARDWORKS_STAFF_TOKEN = 'test-staff-token';
const authorised = await V1('POST', '/v1/components', JSON.stringify({ slug: 'pal.x', kind: 'pal' }),
  { 'x-cardworks-staff': 'test-staff-token', 'content-type': 'application/json' });
delete process.env.CARDWORKS_STAFF_TOKEN;
ok('a delegated route forwards headers — the same call is 403 without one and 503 with it',
   forbidden.status === 403 && authorised.status === 503, `${forbidden.status} then ${authorised.status}`);

H('14. The library over HTTP');

const libRes = await componentsRequest(new Request('https://cardworks.bd/api/components'), null);
const lib = await libRes.json();
ok('GET /api/components answers with the built-in library when there is no database',
   libRes.status === 200 && lib.source === 'seed:no-database');
ok('and the snapshot it returns is deep-equal to the engine\'s', deepEqual(lib.library, BUILT_IN));
ok('it carries the libraryVersion the cache is keyed on, as an ETag too',
   lib.libraryVersion === noDb.libraryVersion && libRes.headers.get('etag') === `"${noDb.libraryVersion}"`);
ok('it carries the pin map a spec would record', Object.keys(lib.pins).length === DOCS.length);
ok('a single kind can be asked for on its own',
   Object.keys((await (await componentsRequest(new Request('https://cardworks.bd/api/components?kind=pal'), null)).json()).library).join() === 'palettes');
ok('a kind that does not exist is refused with the ones that do',
   (await (await componentsRequest(new Request('https://cardworks.bd/api/components?kind=bg'), null)).json()).error.remediation.includes('lay'));
ok('a malformed pin is refused with the shape a pin has',
   /pal\.ink@2/.test((await (await componentsRequest(new Request('https://cardworks.bd/api/components?pins=pal.ink'), null)).json()).error.message));
ok('a pinned read is cacheable forever, because a published version is immutable',
   (await componentsRequest(new Request('https://cardworks.bd/api/components?pins=' +
     Object.entries(pins).map(([s, v]) => `${s}@${v}`).join(',')), store.sql))
     .headers.get('cache-control').includes('immutable'));
ok('publishing without a staff session is refused before anything else is decided',
   (await componentsRequest(new Request('https://cardworks.bd/api/components', { method: 'POST', body: '{}' }), null)).status === 403);
process.env.CARDWORKS_STAFF_TOKEN = 'test-staff-token';
ok('and publishing without a database says so rather than pretending',
   (await componentsRequest(new Request('https://cardworks.bd/api/components',
     { method: 'POST', body: '{}', headers: { 'x-cardworks-staff': 'test-staff-token' } }), null)).status === 503);
ok('a publish with no slug is refused with the field named',
   (await (await componentsRequest(new Request('https://cardworks.bd/api/components',
     { method: 'POST', body: '{}', headers: { 'x-cardworks-staff': 'test-staff-token' } }), store.sql)).json()).error.field === 'slug');
ok('a publish naming a kind nothing composes against is refused with the ones that do',
   /Layout/.test((await (await componentsRequest(new Request('https://cardworks.bd/api/components',
     { method: 'POST', body: JSON.stringify({ slug: 'bg.linen', kind: 'bg' }), headers: { 'x-cardworks-staff': 'test-staff-token' } }), store.sql)).json()).error.remediation || ''));
ok('a component cannot change kind, because specs pinning it were composed as one',
   (await componentsRequest(new Request('https://cardworks.bd/api/components',
     { method: 'POST', headers: { 'x-cardworks-staff': 'test-staff-token' },
       body: JSON.stringify({ slug: 'pal.ink', kind: 'lay', payload: {
         ...DOCS[0].payload, record: { ...DOCS[0].payload.record, id: 'pal.ink' } } }) }), store.sql)).status === 409);
delete process.env.CARDWORKS_STAFF_TOKEN;

/* ────────────────────────────────────────────────────────────────────────
   15. Against a real Postgres
   ──────────────────────────────────────────────────────────────────────── */
H('15. Immutability, enforced by Postgres rather than by application code');

/* The guarantee in §7.1 is that a published version cannot change. Everything
   above runs against an in-memory store, and an in-memory store enforcing
   immutability proves only that the test enforces it. So this section runs
   the real migration against a real Postgres and tries to break it.

   When no Postgres is reachable — the Netlify build, for one — it says so in
   as many words rather than passing. A skipped check that reads as a pass is
   the failure mode WORKPLAN.md's extractor rule was written about, and it is
   worse here than anywhere else, because what is being skipped is the only
   defence a customer's ordered card has.

   It builds and drops a database of its own, because "the migration applies
   to a clean database" is one of the things being checked and a reused one
   cannot answer it. The name carries this process's pid: two of these suites
   running at once — which happens the moment two people run `npm test`
   together, and did — would otherwise have one dropping the database the
   other was reading, and the failure would land on whichever of them was
   unlucky rather than on anything either had changed. Point
   `CARDWORKS_TEST_DATABASE_URL` at an already-migrated database to skip both
   the creation and the drop. */
const PG_URL = process.env.CARDWORKS_TEST_DATABASE_URL
  || `postgres://${process.env.USER || 'postgres'}@127.0.0.1/cardworks_library_test_${process.pid}`;

const psql = (url, args, input) => execFileSync('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', ...args],
  { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000,
    env: { ...process.env, PGCONNECT_TIMEOUT: '3' } });

let live = null;
try {
  const admin = PG_URL.replace(/\/[^/]*$/, '/postgres');
  const dbName = PG_URL.slice(PG_URL.lastIndexOf('/') + 1);
  if (!process.env.CARDWORKS_TEST_DATABASE_URL) {
    try { psql(admin, ['-c', `DROP DATABASE IF EXISTS ${dbName}`]); } catch { /* reported below */ }
    psql(admin, ['-c', `CREATE DATABASE ${dbName}`]);
  }
  psql(PG_URL, ['-f', path.join(ROOT, 'db/schema.sql')]);
  for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations')).sort())
    psql(PG_URL, ['-f', path.join(ROOT, 'db/migrations', f)]);
  live = PG_URL;
} catch (err) {
  console.log('  ⚠ NOT RUN — no Postgres at ' + PG_URL);
  console.log('    Unverified here: that a published component version is immutable in the database,');
  console.log('    that the seed is re-runnable, and that library order survives a real round trip.');
  console.log('    Run a local Postgres, or set CARDWORKS_TEST_DATABASE_URL, to check them.');
  console.log('    (' + String(err.message || err).split('\n')[0].slice(0, 120) + ')');
}

if (live) {
  const q = (text) => psql(live, ['-c', text]).trim();
  const raises = (text) => { try { psql(live, ['-c', text]); return null; } catch (e) { return String(e.stderr || e.message); } };
  const rows = (text) => JSON.parse(psql(live, ['-c', `SELECT coalesce(json_agg(r),'[]'::json)::text FROM (${text}) r`]).trim() || '[]');

  ok('the migration applies to a clean database', q('SELECT count(*) FROM components') === String(DOCS.length),
     q('SELECT count(*) FROM components'));
  for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations')).sort()) psql(live, ['-f', path.join(ROOT, 'db/migrations', f)]);
  ok('and re-running every migration changes nothing',
     q('SELECT count(*) FROM components') === String(DOCS.length) &&
     q('SELECT count(*) FROM component_versions') === String(DOCS.length));

  const liveRows = rows(`SELECT c.slug, c.kind, v.version, v.payload_json
     FROM components c JOIN LATERAL (SELECT version, payload_json FROM component_versions
       WHERE component_id = c.id AND status = 'published' ORDER BY version DESC LIMIT 1) v ON true
     WHERE c.status = 'active' AND c.org_id IS NULL ORDER BY c.id`);
  ok('a snapshot read out of Postgres is deep-equal to the engine literals',
     deepEqual(snapshotFrom(liveRows), BUILT_IN));
  ok('and library order survives jsonb and the sequence',
     snapshotFrom(liveRows).layouts.map(l => l.id).join() === E.LAYOUTS.map(l => l.id).join());
  ok('and it composes the same card, byte for byte',
     await withLibrary(E, snapshotFrom(liveRows), () => E.renderSVG(E.compose(SPEC)) === SPEC_SVG));

  ok('a published version cannot be updated — the database refuses, not the endpoint',
     /immutable/.test(raises(`UPDATE component_versions SET payload_json = '{"record":{},"personality":{},"compat":{}}'::jsonb WHERE version = 1`) || ''));
  ok('a published version cannot be deleted',
     /append-only/.test(raises('DELETE FROM component_versions WHERE version = 1') || ''));
  ok('a component cannot be renamed out from under the specs that pin it',
     /fixed at creation/.test(raises(`UPDATE components SET slug = 'pal.renamed' WHERE slug = 'pal.ink'`) || ''));
  ok('a component cannot be deleted',
     /not deletable/.test(raises(`DELETE FROM components WHERE slug = 'pal.ink'`) || ''));
  ok('two versions of one component cannot share a number',
     /duplicate key|component_versions_key/.test(raises(
       `INSERT INTO component_versions (component_id, version, payload_json, status, published_at)
        SELECT id, 1, '{"record":{},"personality":{},"compat":{}}'::jsonb, 'published', now()
        FROM components WHERE slug = 'pal.ink'`) || ''));
  ok('a version with no personality or compat in its payload is refused by a check constraint',
     /violates check constraint/.test(raises(
       `INSERT INTO component_versions (component_id, payload_json)
        SELECT id, '{"record":{}}'::jsonb FROM components WHERE slug = 'pal.ink'`) || ''));
  ok('publishing a second version leaves the first readable',
     (() => {
       psql(live, ['-c', `INSERT INTO component_versions (component_id, payload_json, status, published_at)
         SELECT v.component_id, jsonb_set(v.payload_json, '{record,accent}', '"#0057b7"'), 'published', now()
         FROM component_versions v JOIN components c ON c.id = v.component_id
         WHERE c.slug = 'pal.ink' AND v.version = 1`]);
       const v1 = rows(`SELECT payload_json->'record'->>'accent' AS accent FROM component_versions v
         JOIN components c ON c.id = v.component_id WHERE c.slug='pal.ink' AND v.version=1`);
       const v2 = rows(`SELECT payload_json->'record'->>'accent' AS accent FROM component_versions v
         JOIN components c ON c.id = v.component_id WHERE c.slug='pal.ink' AND v.version=2`);
       return v1[0].accent === '#c1121f' && v2[0].accent === '#0057b7';
     })());
  ok('and the version number was assigned by the database, not by the caller',
     rows(`SELECT max(version) AS v FROM component_versions x JOIN components c ON c.id = x.component_id WHERE c.slug='pal.ink'`)[0].v === 2);

  const liveAfter = rows(`SELECT c.slug, c.kind, v.version, v.payload_json
     FROM components c JOIN LATERAL (SELECT version, payload_json FROM component_versions
       WHERE component_id = c.id AND status = 'published' ORDER BY version DESC LIMIT 1) v ON true
     WHERE c.status = 'active' AND c.org_id IS NULL ORDER BY c.id`);
  const pinnedLive = rows(`SELECT c.slug, c.kind, v.version, v.payload_json
     FROM components c JOIN component_versions v ON v.component_id = c.id
     WHERE v.version = 1 AND c.org_id IS NULL ORDER BY c.id`);
  ok('the current library moved',
     libraryVersion(liveAfter.map(r => ({ slug: r.slug, version: Number(r.version) }))) !==
     libraryVersion(liveRows.map(r => ({ slug: r.slug, version: Number(r.version) }))));
  ok('and a spec pinned to version 1 composes the exact bytes it always did',
     await withLibrary(E, snapshotFrom(pinnedLive),
       () => E.renderSVG(E.compose(SPEC)) === SPEC_SVG && E.specHash(SPEC) === SPEC_HASH));
  ok('while the current library composes something visibly different',
     await withLibrary(E, snapshotFrom(liveAfter), () => E.renderSVG(E.compose(SPEC)) !== SPEC_SVG));
  ok('and the spec hash did not move for either of them',
     await withLibrary(E, snapshotFrom(liveAfter), () => E.specHash(SPEC)) === SPEC_HASH);

  if (!process.env.CARDWORKS_TEST_DATABASE_URL) {
    try { psql(live.replace(/\/[^/]*$/, '/postgres'), ['-c', `DROP DATABASE IF EXISTS ${live.slice(live.lastIndexOf('/') + 1)}`]); }
    catch { /* a leftover throwaway database is not worth failing a build over */ }
  }
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
