/* The optimisation suite — which is really a suite about output not changing.
 *
 * Technical Design §3.3 says the engine must remain a pure function of
 * (brief, library, seed): no database, no clock, no unseeded randomness. Every
 * optimisation in `assets/engine.js` is licensed by exactly that sentence — a
 * pure function's answer cannot go stale between two calls with the same
 * arguments, so remembering it can only save work and can never change a
 * result. That is the argument. This file is the evidence for it.
 *
 * The engine carries a switch, `PERF.caches`, which turns off every piece of
 * reuse it does: the memoised QR encoder, the measurement cache, the colour
 * caches, and the hoist that composes a layout once per type system instead of
 * once per type system per palette. With the switch off the engine recomputes
 * everything, candidate by candidate, exactly as it did before any of this
 * existed. So the central assertion here is simply that the two paths produce
 * the same bytes over the whole matrix — every preset × format × script ×
 * density for `generate`, and every layout × format × style override for
 * `compose`, compared at full precision including the rendered SVG.
 *
 * That formulation is deliberate. A golden file pinned to today's numbers
 * would fail the moment someone legitimately adds a palette, and it would fail
 * in the file of whoever added it, for a reason that has nothing to do with
 * them. Comparing the fast path against the engine's own reference path never
 * goes stale, because both sides move together when the library does.
 *
 * The counters are what stop this being a test that passes by doing nothing.
 * A typo that quietly disabled caching would make both paths identical and
 * every comparison below vacuously true, so the fast path is required to
 * register cache hits and the reference path is required to register none.
 *
 * Run it with `node tests/perf.test.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'assets/engine.js'), 'utf8');

/* ── instances ───────────────────────────────────────────────────────────
   Each one gets its own VM context, which is what lets the purity section
   below hand an engine a clock that lies or a `Math.random` that throws
   without disturbing any other instance or this file. */

/* The same per-glyph advance ratios `lib/engine-node.mjs` uses. Restating
   them here is a duplication and duplications drift, so the first assertion
   in this file is that the two tables still agree — measured through the
   engine rather than by comparing the source, since agreeing on the numbers
   is the only thing that matters. */
/* The Bangla model, kept identical to lib/engine-node.mjs. This is the fourth
   copy of it in the repository — server, engine suite, parity suite, and here —
   and D3's own assertion that "this file measures text exactly as
   lib/engine-node.mjs does" is what caught the fourth when the other three
   moved. Four copies of one constant is the real defect; the assertion is the
   thing keeping them honest until someone shares the module. */
const BN_HALANT = /\u09CD/;
const BN_MATRA  = /[\u09BE-\u09CC\u09D7]/;
const BN_SIGN   = /[\u0981-\u0983\u09BC]/;
const BN_ANY    = /[\u0980-\u09FF]/;
function banglaAdvance(ch) {
  if (BN_HALANT.test(ch)) return -0.50;
  if (BN_MATRA.test(ch))  return 0.25;
  if (BN_SIGN.test(ch))   return 0.10;
  return 0.64;
}

function advance(ch, family) {
  if (BN_ANY.test(ch)) return banglaAdvance(ch);
  if (/[A-Z]/.test(ch)) return family.includes('Mono') ? 0.60 : 0.66;
  if (/[il1.,'!|]/.test(ch)) return 0.26;
  if (/[mwMW]/.test(ch)) return 0.86;
  if (/\s/.test(ch)) return 0.28;
  return family.includes('Mono') ? 0.60 : 0.52;
}
const measureCtx = () => ({
  font: '',
  measureText(t) {
    const m = /(\d+)px\s+(.+)$/.exec(this.font) || [0, '200', 'sans'];
    const px = +m[1], fam = m[2];
    let w = 0; for (const ch of t) w += advance(ch, fam) * px;
    const bn = /[ঀ-৿]/.test(t);
    return { width: w,
             fontBoundingBoxAscent: px * (bn ? 0.95 : 0.80),
             fontBoundingBoxDescent: px * (bn ? 0.35 : 0.20) };
  }
});
const stubEl = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
  setAttribute() {}, appendChild() {}, querySelectorAll: () => [],
  querySelector: () => stubEl(), closest: () => null });

const SURFACE = ['PERF', 'generate', 'compose', 'composeGeometry', 'resolvePalette', 'renderSVG',
  'preflight', 'stableStringify', 'specHash', 'measure', '_mcache', 'QR', 'qrPayload', 'lum',
  'LAYOUTS', 'PALETTES', 'TYPE_SYSTEMS', 'FORMATS', 'PRESETS', 'INDUSTRIES', 'SLOTDEFS'];

/** An engine in its own context. `over` replaces sandbox globals, which is
 *  how the purity section poisons a clock or a source of randomness. */
function load(over = {}) {
  const sandbox = {
    document: {
      createElement: t => t === 'canvas' ? { getContext: () => measureCtx() } : stubEl(),
      querySelector: () => stubEl(), querySelectorAll: () => [], fonts: { ready: Promise.resolve() }
    },
    performance: { now: () => 0 },
    console, TextEncoder, TextDecoder,
    ...over
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return vm.runInNewContext(SRC + `\n;({ ${SURFACE.join(', ')} });`, sandbox,
                            { filename: 'assets/engine.js' });
}

const fast = load();
const ref  = load();
ref.PERF.caches = false;

/* ── harness, printing what the other suites print ──────────────────────── */
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name))
       : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')));
};
const H = s => console.log('\n' + s);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* Everything a `generate` result carries except `ms`, which is wall-clock
   telemetry and the one field that is allowed to differ between two runs.
   The rendered SVG is included because it is the artefact a customer
   actually looks at, and geometry that agrees while paint disagrees is not
   the same card. */
function digest(E, g) {
  return E.stableStringify({
    intent: g.intent, stages: g.stages, considered: g.considered,
    picked: g.picked.map(c => ({
      layout: c.layout, palette: c.palette, type: c.type,
      score: c.score, why: c.why, findings: c.findings,
      pal: c.composed.pal, trace: c.composed.trace, dropped: c.composed.dropped,
      eliminated: c.composed.eliminated ?? null,
      elements: c.composed.elements.map(e => ({
        ref: e.ref, kind: e.kind, geom: e.geom, fit: e.fit,
        glyph: e.glyph ?? null, align: e.align ?? null, color: e.color ?? null,
        qr: e.qr ? { size: e.qr.size, version: e.qr.version, mask: e.qr.mask,
                     bytes: e.qr.bytes, matrix: e.qr.matrix } : null,
        payload: e.payload ?? null, moduleMm: e.moduleMm ?? null
      })),
      svg: E.renderSVG(c.composed)
    }))
  });
}
function composeDigest(E, spec) {
  const c = E.compose(spec);
  return E.stableStringify({ elements: c.elements, trace: c.trace, dropped: c.dropped,
    eliminated: c.eliminated ?? null, pal: c.pal, svg: E.renderSVG(c), findings: E.preflight(c) });
}

/* The brief matrix. Industries and personalities are spread deterministically
   across it rather than fixed, so the intent resolver and the industry-avoid
   rule are exercised too and not just the geometry. */
const INDS = Object.keys(fast.INDUSTRIES);
const PERSONAS = [[], ['premium'], ['minimal', 'technical'], ['bold', 'friendly'],
                  ['traditional', 'corporate']];
const BRIEFS = [];
for (let i = 0; i < fast.PRESETS.length; i++)
  for (const F of fast.FORMATS)
    for (const script of ['latin', 'bangla'])
      for (const density of ['airy', 'balanced', 'tight'])
        BRIEFS.push({
          label: `preset${i}·${F.id}·${script}·${density}`,
          brief: { industry: INDS[(i * 3 + F.id.length + density.length) % INDS.length],
                   personality: PERSONAS[(i + density.length) % PERSONAS.length],
                   format: F.id, density, script },
          content: fast.PRESETS[i].c
        });

/* Style overrides for the part editor's channel. The last one pins a size
   under the print floor on purpose: the floor must still win, and it must
   win identically on both paths. */
const STYLES = [
  null,
  { name: { sizePt: 18 } },
  { name: { weightNum: 900, upper: true } },
  { role: { color: '#b3121a', align: 'right' } },
  { company: { upper: true, weightNum: 300 }, contact: { align: 'center' } },
  { name: { sizePt: 3 }, role: { sizePt: 24, weightNum: 200 } }
];
const SPECS = [];
for (const L of fast.LAYOUTS)
  for (const F of fast.FORMATS)
    for (let si = 0; si < STYLES.length; si++)
      SPECS.push({
        label: `${L.id}·${F.id}·style${si}`,
        spec: { format: F.id, type: fast.TYPE_SYSTEMS[si % fast.TYPE_SYSTEMS.length].id,
                palette: fast.PALETTES[si % fast.PALETTES.length].id, density: 'balanced',
                layout: L.id, content: fast.PRESETS[si % fast.PRESETS.length].c, corner: si,
                share: { origin: 'https://cardworks.bd', code: si % 2 ? 'abc12345' : null },
                ...(STYLES[si] ? { slotStyle: STYLES[si] } : {}) }
      });

H('1. Two engines, one metric model');
ok('both instances loaded the same source', fast.LAYOUTS.length === ref.LAYOUTS.length &&
   fast.PRESETS.length === ref.PRESETS.length && fast.LAYOUTS !== ref.LAYOUTS);
ok('the reference instance has every cache turned off', ref.PERF.caches === false);
ok('the fast instance has them on', fast.PERF.caches === true);
{
  /* Measurement is upstream of every number in this file. If this local
     metric model has drifted from the one the server suite uses, every
     comparison below would still pass while measuring something the rest of
     the project does not measure. */
  const { engine } = await import('../lib/engine-node.mjs');
  const server = engine();
  const spec = { format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink', density: 'balanced',
                 layout: fast.LAYOUTS[0].id, content: fast.PRESETS[0].c, corner: 0,
                 share: { origin: 'https://cardworks.bd', code: null } };
  const w = (E, t) => E.compose({ ...spec, content: { ...spec.content, name: t } })
                       .elements.find(e => e.ref === 'name')?.fit?.width ?? null;
  const sample = ['Prof. Dr. Md. Abdur Rahman', 'অধ্যাপক ডাঃ মোঃ আব্দুর রহমান'];
  const widths = sample.map(t => w(fast, t));
  ok('this file measures text exactly as lib/engine-node.mjs does',
     widths.every(x => x !== null) && sample.every((t, i) => w(server, t) === widths[i]),
     JSON.stringify(widths));
}

H('2. The whole matrix, fast path against reference path');
{
  if (BRIEFS.length < 100)
    throw new Error(`only ${BRIEFS.length} briefs built — the matrix did not assemble, and a ` +
                    `comparison over nothing is not a comparison`);
  let same = 0, bytes = 0;
  const differing = [];
  for (const b of BRIEFS) {
    const a = digest(fast, fast.generate(b.brief, b.content));
    const z = digest(ref,  ref.generate(b.brief, b.content));
    bytes += a.length;
    a === z ? same++ : differing.push(b.label);
  }
  ok(`generate() is byte-identical on both paths across ${BRIEFS.length} briefs`,
     same === BRIEFS.length, differing.slice(0, 4).join(', '));
  ok('and the comparison actually had output to compare',
     bytes > 2_000_000, `${bytes} bytes`);
}
{
  if (SPECS.length < 100)
    throw new Error(`only ${SPECS.length} specs built — the compose matrix did not assemble`);
  let same = 0;
  const differing = [];
  for (const s of SPECS) {
    composeDigest(fast, s.spec) === composeDigest(ref, s.spec) ? same++ : differing.push(s.label);
  }
  ok(`compose() is byte-identical on both paths across ${SPECS.length} specs, ` +
     `slotStyle present and absent`, same === SPECS.length, differing.slice(0, 4).join(', '));
}
{
  /* If slotStyle changed nothing, the assertion above would be true for a
     reason that has nothing to do with slotStyle. */
  const base = SPECS.find(s => !s.spec.slotStyle && s.spec.layout === 'lay.centered')?.spec
            || SPECS[0].spec;
  const styled = { ...base, slotStyle: { name: { sizePt: 22, weightNum: 900 } } };
  ok('and slotStyle genuinely changes a composition, so that comparison meant something',
     composeDigest(fast, base) !== composeDigest(fast, styled));
  ok('an overridden size still goes through the print floor rather than around it',
     (() => {
       const tiny = fast.compose({ ...base, slotStyle: { name: { sizePt: 2 } } });
       const nm = tiny.elements.find(e => e.ref === 'name');
       return !!nm && nm.fit.sizePt >= nm.fit.minPt - 1e-9;
     })());
}

H('3. The caches were genuinely used, and genuinely not used');
{
  const a = load(), b = load();
  b.PERF.caches = false;
  const brief = BRIEFS[0].brief, content = BRIEFS[0].content;
  a.PERF.hits = 0; a.PERF.misses = 0;
  b.PERF.hits = 0; b.PERF.misses = 0;
  a.generate(brief, content);
  b.generate(brief, content);
  ok('the fast path registers cache hits', a.PERF.hits > 1000, `${a.PERF.hits} hits`);
  ok('the reference path registers none at all', b.PERF.hits === 0, `${b.PERF.hits} hits`);
  ok('the reference path still does the work, it just does not remember it',
     b.PERF.misses > a.PERF.misses, `${b.PERF.misses} vs ${a.PERF.misses}`);
  ok('and the reference path measures far more text than the fast path does',
     b.PERF.misses > a.PERF.misses * 5);
}

H('4. Bounded, and correct after eviction');
{
  const E = load();
  const before = E._mcache.map.size;
  /* Far more distinct strings than the cache can hold, so eviction has to
     happen and has to happen many times over. */
  for (let i = 0; i < 40000; i++) E.measure('flood-' + i, 'Inter', 400, 0);
  ok('the measurement cache stops growing at its bound',
     E._mcache.map.size <= 16384, `${E._mcache.map.size} entries`);
  ok('and it did grow, so the bound was actually tested',
     E._mcache.map.size > before + 1000);

  /* Eviction must be free of consequence. The oldest entries are gone; the
     answers must not be. */
  const fresh = load();
  const key = ['Prof. Dr. Md. Abdur Rahman', 'Inter', 400, 0];
  const evicted = E.measure(...key), clean = fresh.measure(...key);
  ok('a measurement recomputed after eviction is the measurement it was before',
     evicted.w === clean.w && evicted.asc === clean.asc && evicted.desc === clean.desc);

  const qrBefore = E.QR.encode('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Test\r\nEND:VCARD');
  for (let i = 0; i < 500; i++) E.QR.encode('flood-payload-' + i);
  const qrAfter = E.QR.encode('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Test\r\nEND:VCARD');
  ok('a QR symbol re-encoded after its cache entry was evicted is the same symbol',
     sha(JSON.stringify(qrBefore.matrix)) === sha(JSON.stringify(qrAfter.matrix)) &&
     qrBefore.mask === qrAfter.mask && qrBefore.version === qrAfter.version);
}

H('5. The property the palette hoist rests on');
{
  /* Generation composes a layout once per type system and ranks it against
     all eight palettes. That is only sound if geometry does not depend on
     colour. Asserted on the REFERENCE instance: on the fast path the eight
     answers come from one composition, so comparing them there would prove
     nothing about whether they were entitled to. */
  let checked = 0;
  const differing = [];
  for (const L of ref.LAYOUTS) {
    for (const F of ref.FORMATS) {
      const T = ref.TYPE_SYSTEMS[0];
      const shape = pal => {
        const c = ref.compose({ format: F.id, type: T.id, palette: pal.id, density: 'balanced',
          layout: L.id, content: ref.PRESETS[5].c, corner: 0,
          share: { origin: 'https://cardworks.bd', code: 'abc12345' } });
        return ref.stableStringify({ elements: c.elements, trace: c.trace,
          dropped: c.dropped, eliminated: c.eliminated ?? null });
      };
      const first = shape(ref.PALETTES[0]);
      for (const P of ref.PALETTES.slice(1)) {
        checked++;
        if (shape(P) !== first) differing.push(`${L.id}·${F.id}·${P.id}`);
      }
    }
  }
  ok(`composed geometry is identical across every palette (${checked} comparisons)`,
     checked > 100 && differing.length === 0, differing.slice(0, 3).join(', '));
}
{
  /* The eight palette siblings of one layout share their element arrays.
     What makes that safe is the diversity rule: at most one concept per
     layout survives, so nothing a caller is handed aliases anything else it
     is handed. Assert the guarantee rather than trusting it. */
  const g = fast.generate({ industry: 'doctor', personality: ['premium'], format: 'bd-std',
                            density: 'balanced', script: 'latin' }, fast.PRESETS[0].c);
  const layouts = g.picked.map(c => c.layout);
  ok('no two returned concepts share a layout', new Set(layouts).size === layouts.length);
  const arrays = g.picked.map(c => c.composed.elements);
  ok('and no two returned concepts share an element array',
     new Set(arrays).size === arrays.length);
  ok('six concepts came back, so that was not a vacuous check', g.picked.length === 6);
}

H('6. §3.3 — no clock, no unseeded randomness, no I/O');
{
  /* `generate` reports how long it took, and that number is read from a
     clock. What §3.3 forbids is a clock affecting the RESULT, so the test is
     that a clock which behaves completely differently changes `ms` and
     changes nothing else. */
  const t = [0, 17.4, 999999, -3];
  let i = 0;
  const drifting = load({ performance: { now: () => t[(i++) % t.length] } });
  const still = load({ performance: { now: () => 0 } });
  const b = BRIEFS[3];
  const a = drifting.generate(b.brief, b.content);
  const z = still.generate(b.brief, b.content);
  ok('a clock that jumps about changes nothing but the reported duration',
     digest(drifting, a) === digest(still, z));
  ok('and the clock really was different, so that was not a coincidence',
     a.ms !== z.ms, `${a.ms} vs ${z.ms}`);
}
{
  const boom = what => () => { throw new Error(`the engine touched ${what}`); };
  const noRandom = new Proxy(Math, {
    get: (t, k) => k === 'random' ? boom('Math.random') : Reflect.get(t, k)
  });
  const noClock = function Date() { throw new Error('the engine read the clock'); };
  noClock.now = boom('Date.now');
  const io = {};
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage',
                      'sessionStorage', 'indexedDB', 'navigator', 'require', 'process'])
    Object.defineProperty(io, name, { get: boom(name), configurable: true });

  const sealed = load({ Math: noRandom, Date: noClock, ...io });
  let threw = null;
  try {
    for (const b of BRIEFS.slice(0, 12)) sealed.generate(b.brief, b.content);
    for (const s of SPECS.slice(0, 40)) sealed.renderSVG(sealed.compose(s.spec));
  } catch (err) { threw = err.message; }
  ok('generation and composition run with randomness, the clock and every I/O ' +
     'route rigged to throw', threw === null, threw || '');
  ok('and the rigging works, so that was a real constraint',
     (() => { try { io.fetch; return false; } catch { return true; } })());
}
{
  /* Determinism across instances, which is the property the caching model in
     §7.1 is built on: the same brief must return the same six concepts on a
     different machine, in a different process, a year later. */
  const one = load(), two = load();
  let same = 0;
  for (const b of BRIEFS.slice(0, 20))
    if (digest(one, one.generate(b.brief, b.content)) ===
        digest(two, two.generate(b.brief, b.content))) same++;
  ok('two independent engines agree on every brief', same === 20);
  const thrice = BRIEFS[7];
  const d1 = digest(one, one.generate(thrice.brief, thrice.content));
  const d2 = digest(one, one.generate(thrice.brief, thrice.content));
  ok('and one engine agrees with itself on a repeat call', d1 === d2);
}

H('7. The §7.1 caching model');
{
  const C = await import('../lib/cache.mjs');

  ok('every layer §7.1 names has a policy',
     ['candidates', 'preview', 'print', 'explanation'].every(k => C.LAYERS[k]));
  ok('a preview is immutable for a year, as §7.1 states',
     C.cacheControl('preview') === 'public, max-age=31536000, immutable');
  ok('a candidate set lasts seven days and is revalidated',
     C.cacheControl('candidates') === 'public, max-age=604800');
  ok('an explanation lasts thirty days',
     C.cacheControl('explanation') === 'public, max-age=2592000');
  ok('a layer with no policy refuses rather than returning a header that means nothing',
     (() => { try { C.cacheControl('guesswork'); return false; } catch { return true; } })());

  /* The seed is a function of versions, not of a moment, which is the whole
     of why the six concepts a customer saw are the six they get back. */
  const seed = { briefId: 'brf-abc', libraryVersion: 'lib-1', rankerVersion: 'r1' };
  ok('the seed is derived from versions and repeats exactly',
     C.seedFor(seed) === C.seedFor({ ...seed }));
  ok('publishing a library moves the seed', C.seedFor(seed) !== C.seedFor({ ...seed, libraryVersion: 'lib-2' }));
  ok('and the candidate key moves with it',
     C.candidateKey({ vector: { premium: 1 }, libraryVersion: 'lib-1', seed: 's' }) !==
     C.candidateKey({ vector: { premium: 1 }, libraryVersion: 'lib-2', seed: 's' }));

  const k = { specHash: 'abc', engineVersion: 'eng-1' };
  ok('a preview and a print of one design are different keys',
     C.renderKey({ ...k, variant: 'preview' }) !== C.renderKey({ ...k, variant: 'print' }));
  ok('and a new engine is a different key again, because nothing pins the fit ladder',
     C.renderKey(k) !== C.renderKey({ ...k, engineVersion: 'eng-2' }));

  /* A tagged-template stand-in for the Neon client. Enough to prove the
     degrade paths, which are the ones that decide whether an unmigrated
     deploy serves cards or 500s. */
  const sqlThat = (behave) => (strings, ...vals) => behave(strings.join('?'), vals);
  const missing = sqlThat(() => { throw new Error('relation "renders" does not exist'); });
  const empty = sqlThat(() => []);
  const oneRow = sqlThat(() => [{ spec_hash: 'abc', variant: 'preview', engine_version: 'eng-1',
                                  content_type: 'image/svg+xml', body: '<svg/>' }]);

  ok('no database is a miss with a reason, not a throw',
     (await C.getRender(null, k)).reason === 'no-database');
  ok('a deploy without migration 007 is a miss with its own reason',
     (await C.getRender(missing, k)).reason === 'migration-007-not-applied');
  ok('an unrendered design is an ordinary miss', (await C.getRender(empty, k)).reason === 'miss');
  {
    const hit = await C.getRender(oneRow, k);
    ok('and a rendered one is a hit carrying the artefact', hit.hit && hit.render.body === '<svg/>');
  }
  ok('a key with no engine version is refused outright',
     await (async () => { try { await C.getRender(empty, { specHash: 'abc' }); return false; }
                          catch { return true; } })());
  ok('a render row carrying neither artefact nor URL is refused',
     await (async () => {
       try { await C.putRender(empty, { ...k, contentType: 'image/svg+xml' }); return false; }
       catch { return true; } })());
  ok('storing against an unmigrated deploy reports it rather than throwing',
     (await C.putRender(missing, { ...k, contentType: 'image/svg+xml', body: '<svg/>' }))
       .reason === 'migration-007-not-applied');
  ok('a second write of the same key is already-cached, not a second row',
     (await C.putRender(empty, { ...k, contentType: 'image/svg+xml', body: '<svg/>' }))
       .reason === 'already-cached');
  ok('the lifecycle sweep degrades the same way',
     (await C.sweepRenders(missing)).reason === 'migration-007-not-applied');

  ok('the §7.3 ladder takes bulk first and leaves the single card working',
     C.SHED_LADDER[0].disable === 'bulk' && C.shedAllows(0, 'bulk') && !C.shedAllows(1, 'bulk'));
  ok('and a cached preview still serves at every step of it',
     C.shedAllows(3, 'cached-previews'));
}

H('8. What it costs — reported, not asserted');
{
  /* Wall-clock numbers belong in a report, not in a build gate: a loaded CI
     box would fail an assertion about milliseconds while the engine was
     perfectly correct. What is asserted here is the shape of the win —
     that the fast path does strictly less work than the reference path,
     counted in cache misses rather than in time. */
  const SAMPLE = BRIEFS.filter((_, i) => i % 6 === 0);
  const timed = (E) => {
    for (const b of SAMPLE) E.generate(b.brief, b.content);        // warm
    const t0 = Number(process.hrtime.bigint());
    for (const b of SAMPLE) E.generate(b.brief, b.content);
    return (Number(process.hrtime.bigint()) - t0) / 1e6 / SAMPLE.length;
  };
  const withCaches = timed(load());
  const withoutCaches = timed((() => { const E = load(); E.PERF.caches = false; return E; })());
  console.log(`    generate()  ${withCaches.toFixed(2)} ms with reuse, ` +
              `${withoutCaches.toFixed(2)} ms without — ` +
              `${(withoutCaches / withCaches).toFixed(1)}× over ${SAMPLE.length} briefs`);
  ok('the fast path is not slower than the reference path', withCaches < withoutCaches);
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
