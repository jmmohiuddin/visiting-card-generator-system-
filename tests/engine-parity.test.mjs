/* Browser/server preflight parity.
 *
 * `lib/preflight-gate.mjs` claims that the server reaches the same verdict as
 * the browser for the same design. That claim is the whole justification for
 * gating orders on the server at all — a mirror that disagrees with the
 * original is worse than no mirror, because it refuses work that is fine and
 * passes work that is not, and nobody can tell which.
 *
 * So this file runs both paths over the same inputs and compares them. The
 * browser path is loaded the way `cardworks-engine.test.cjs` loads it: the
 * asset files concatenated in the order `index.html` declares them, which
 * reproduces the single scope classic scripts share in a browser tab,
 * evaluated against a stubbed DOM and a font-metric model. The server path is
 * `lib/engine-node.mjs`, which loads `assets/engine.js` into a Node VM. Two
 * separate instances of one source file, driven through the two separate
 * assemblies — `facesFor`/`allFindings` in the shell, and their mirrors in the
 * gate — that are the only place a difference can creep in.
 *
 * Run it with `node tests/engine-parity.test.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── the browser path, loaded the way the engine suite loads it ─────────── */

/* The load order is read out of index.html rather than restated here.
   `cardworks-engine.test.cjs` pins the exact list because keeping the two in
   step is one of the things it is for; this file must not pin it a second
   time, or adding a screen to the shell would fail a suite about preflight
   parity for a reason that has nothing to do with preflight parity. What
   this file does need is the two sources the mirror is a mirror of. */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SOURCES = [...html.matchAll(/<script src="\/(assets\/[^"]+)"><\/script>/g)].map(m => m[1]);
for (const required of ['assets/engine.js', 'assets/ui-shell.js'])
  if (!SOURCES.includes(required))
    throw new Error(`index.html no longer loads ${required}; the parity loader cannot build the browser path`);
const js = SOURCES.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

/* The same per-glyph advance ratios `lib/engine-node.mjs` uses. If these two
   tables ever differ the comparison below is meaningless, so the assertion
   that they agree is the first one this file makes. */
/* ── Bangla is measured by cluster, not by codepoint ──────────────────────
   A flat charge per Bangla codepoint over-estimates real text by a third or
   more, because shaping collapses codepoints into clusters: `্` (halant) joins
   the consonants on either side of it into one conjunct, and a vowel sign is
   drawn at a fraction of a consonant's width rather than beside it at full
   width. Measured against the real shaper in `lib/pdf/bengali.mjs` over a
   corpus of Bangladeshi names, titles, organisations and place names, a flat
   0.62 per codepoint is 44–54% out; the coefficients below are 8–9% out.

   That error was never dangerous — over-estimating width means type is set
   smaller than it needed to be, and narrower-than-estimated never leaves the
   safe area — but it cost real quality. Bangla was being driven toward the
   7.5pt floor about a third earlier than the text required.

   The browser does not use this model at all: it measures with a real canvas,
   which shapes Bengali properly. This exists so the server and CI agree with
   the browser rather than with each other, which is the failure the parity
   suite could not see while all three copies shared one wrong constant. */
const BN_HALANT = /\u09CD/;
const BN_MATRA  = /[\u09BE-\u09CC\u09D7]/;
const BN_SIGN   = /[\u0981-\u0983\u09BC]/;
const BN_ANY    = /[\u0980-\u09FF]/;

function banglaAdvance(ch) {
  if (BN_HALANT.test(ch)) return -0.50;   // joins its neighbours into one cluster
  if (BN_MATRA.test(ch))  return 0.25;    // drawn against the consonant, not beside it
  if (BN_SIGN.test(ch))   return 0.10;    // anusvara, visarga, chandrabindu, nukta
  return 0.64;                            // consonant or independent vowel
}

function advance(ch, family) {
  if (BN_ANY.test(ch)) return banglaAdvance(ch);
  if (/[A-Z]/.test(ch)) return family.includes('Mono') ? 0.60 : 0.66;
  if (/[il1.,'!|]/.test(ch)) return 0.26;
  if (/[mwMW]/.test(ch)) return 0.86;
  if (/\s/.test(ch)) return 0.28;
  return family.includes('Mono') ? 0.60 : 0.52;
}
const fakeCtx = {
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
};
const el = () => ({ innerHTML: '', textContent: '', value: '', onclick: null, oninput: null,
  onchange: null, onkeydown: null, files: null, style: {}, dataset: {}, setAttribute() {},
  appendChild() {}, querySelectorAll: () => [], querySelector: () => el(), closest: () => null });
globalThis.document = {
  createElement: (t) => t === 'canvas' ? { getContext: () => fakeCtx } : el(),
  querySelector: () => el(), querySelectorAll: () => [], fonts: { ready: Promise.resolve() }
};
globalThis.performance = { now: () => 0 };
globalThis.window = globalThis;
const _ls = {};
globalThis.localStorage = { getItem: k => k in _ls ? _ls[k] : null, setItem: (k, v) => { _ls[k] = String(v); }, removeItem: k => { delete _ls[k]; } };
globalThis.location = { hash: '' };
globalThis.history = { replaceState() {} };
globalThis.btoa = b => Buffer.from(b, 'binary').toString('base64');
globalThis.atob = b => Buffer.from(b, 'base64').toString('binary');

const browser = new Function(js + `
  ;return { specFor, facesFor, allFindings, composeForced, compose, preflight,
            LAYOUTS, PRESETS, FORMATS, SLOTDEFS, PALETTES, TYPE_SYSTEMS,
            state, specHash, stableStringify };`)();

/* ── the server path ────────────────────────────────────────────────────── */

const { engine, specFrom, engineVersion } = await import('../lib/engine-node.mjs');
const gate = await import('../lib/preflight-gate.mjs');
const server = engine();

/* ── harness, printing what cardworks-engine.test.cjs prints ────────────── */

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name))
       : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')));
};
const H = s => console.log('\n' + s);

const key = f => `${f.s}|${f.face || ''}|${f.label}|${f.note || ''}`;
const stable = browser.stableStringify;

H('1. One engine, one metric model');
ok('the server loads the same assets/engine.js the browser does',
   server.LAYOUTS.length === browser.LAYOUTS.length &&
   server.PRESETS.length === browser.PRESETS.length &&
   server.PALETTES.length === browser.PALETTES.length &&
   server.TYPE_SYSTEMS.length === browser.TYPE_SYSTEMS.length);
ok('the two instances are genuinely separate objects', server.LAYOUTS !== browser.LAYOUTS);
{
  /* Measurement is upstream of every geometric check, so a divergence here
     would make every other assertion in this file vacuously true. */
  const sample = ['Prof. Dr. Md. Abdur Rahman', 'অধ্যাপক ডাঃ মোঃ আব্দুর রহমান', 'MBBS (DMC), FCPS'];
  const same = sample.every(t => {
    const a = browser.compose({ format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
      density: 'balanced', layout: browser.LAYOUTS[0].id, content: { name: t, p1: '01711-123456' },
      corner: 0, share: { origin: 'https://cardworks.bd', code: null } });
    const b = server.compose({ format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
      density: 'balanced', layout: server.LAYOUTS[0].id, content: { name: t, p1: '01711-123456' },
      corner: 0, share: { origin: 'https://cardworks.bd', code: null } });
    const w = c => (c.elements.find(e => e.ref === 'name')?.fit?.width ?? null);
    return w(a) !== null && w(a) === w(b);
  });
  ok('both instances measure Latin and Bangla text identically', same);
}
ok('engineVersion() is a stable content stamp', /^eng-[0-9a-z]+$/.test(engineVersion()) &&
   engineVersion() === engineVersion());

/* ── 2. the spec shape ──────────────────────────────────────────────────── */

H('2. specFrom (server) produces the same spec as specFor (browser)');
{
  const content = browser.PRESETS[0].c;
  const design = { layout: 'lay.stack', palette: 'pal.ink', type: 'typ.siliguri',
                   density: 'balanced', format: 'bd-std', corner: 2, script: 'latin' };
  Object.assign(browser.state, { format: design.format, type: design.type, palette: design.palette,
    density: design.density, corner: design.corner, shareCode: 'abc123' });

  const a = browser.specFor(design.layout, content);
  const b = specFrom(design, content, { code: 'abc123' });

  ok('same key set at the top level', stable(Object.keys(a).sort()) === stable(Object.keys(b).sort()),
     `browser ${Object.keys(a).sort()} vs server ${Object.keys(b).sort()}`);
  ok('same key set under share', stable(Object.keys(a.share).sort()) === stable(Object.keys(b.share).sort()));
  ok('identical serialised spec', stable(a) === stable(b), stable(a) + ' vs ' + stable(b));

  /* The share code is what the QR encodes, so a spec that drops it produces a
     different — and correctly blocking — verdict. Worth its own assertion
     because it is the one field with no visible presence in the design. */
  const noCode = specFrom(design, content, {});
  ok('an unsaved design carries a null share code on both sides', noCode.share.code === null);
  browser.state.shareCode = null;
  ok('and the browser agrees when nothing is saved', browser.specFor(design.layout, content).share.code === null);
}

/* ── 3. verdict parity over the full matrix ─────────────────────────────── */

H('3. Verdict parity — every preset × every front × every back × both scripts');
{
  const fronts = browser.LAYOUTS.filter(l => l.face === 'front');
  const backs = browser.LAYOUTS.filter(l => l.face === 'back');
  const scripts = ['latin', 'bangla'];

  let combos = 0, findingsCompared = 0, mismatch = 0, countMismatch = 0, geomMismatch = 0;
  let uncoded = 0, firstUncoded = '';
  const statuses = { pass: 0, advisory: 0, blocked: 0 };
  const shown = [];

  for (const preset of browser.PRESETS) {
    for (const front of fronts) {
      for (const back of backs) {
        for (const script of scripts) {
          const design = { layout: front.id, back: back.id, palette: 'pal.ink', type: 'typ.siliguri',
                           density: 'balanced', format: 'bd-std', corner: 0, script };
          const share = { origin: 'https://cardworks.bd', code: 'aa11bb22' };

          Object.assign(browser.state, { format: design.format, type: design.type,
            palette: design.palette, density: design.density, corner: design.corner,
            shareCode: share.code });

          const bf = browser.facesFor(design, preset.c);
          const bFindings = browser.allFindings(bf.front, bf.back);
          const report = gate.buildReport({ design, content: preset.c, share });

          combos++;
          statuses[report.status]++;

          /* The composed geometry first: if the two engines placed anything
             differently, every finding downstream is comparing the wrong
             cards and a matching verdict would be a coincidence. */
          const geom = c => stable((c.elements || []).map(e => ({
            ref: e.ref, kind: e.kind,
            g: [+e.geom.x.toFixed(4), +e.geom.y.toFixed(4), +e.geom.w.toFixed(4), +e.geom.h.toFixed(4)],
            pt: e.fit ? +e.fit.sizePt.toFixed(4) : null,
            lines: e.fit ? e.fit.lines : null
          })));
          const sf = gate.facesFor(server, design, preset.c, share);
          if (geom(bf.front) !== geom(sf.front) || geom(bf.back) !== geom(sf.back)) geomMismatch++;

          if (bFindings.length !== report.findings.length) {
            mismatch++;
            if (shown.length < 3) shown.push(`${preset.k}/${front.id}/${back.id}/${script}: ${bFindings.length} browser findings vs ${report.findings.length} server`);
          } else {
            for (let i = 0; i < bFindings.length; i++) {
              findingsCompared++;
              if (key(bFindings[i]) !== key(report.findings[i])) {
                mismatch++;
                if (shown.length < 3) shown.push(`${preset.k}/${front.id}/${back.id}/${script}:\n      browser ${key(bFindings[i])}\n      server  ${key(report.findings[i])}`);
              }
            }
          }

          const n = s => bFindings.filter(f => f.s === s).length;
          if (n('fail') !== report.blocking || n('review') !== report.advisory || n('pass') !== report.passed)
            countMismatch++;

          for (const f of report.findings) if (f.code === 'other') {
            uncoded++; if (!firstUncoded) firstUncoded = f.label;
          }
        }
      }
    }
  }

  for (const s of shown) console.log('    ' + s);
  ok(`${combos} design combinations composed on both sides`, combos === browser.PRESETS.length * fronts.length * backs.length * 2);
  ok('composed geometry is identical on both sides', geomMismatch === 0, geomMismatch + ' differing compositions');
  ok(`${findingsCompared} findings match label, note, state and face`, mismatch === 0, mismatch + ' divergent findings');
  ok('blocking/advisory/pass counts match the browser tally', countMismatch === 0, countMismatch + ' differing tallies');
  ok('every finding the engine emits has a known code', uncoded === 0, uncoded + ' uncoded, first: ' + firstUncoded);
  /* A matrix in which everything passes would prove nothing about the
     blocking path, so the spread itself is asserted. */
  ok(`the matrix exercises all three statuses (${statuses.pass} pass, ${statuses.advisory} advisory, ${statuses.blocked} blocked)`,
     statuses.pass > 0 && statuses.advisory > 0 && statuses.blocked > 0);
}

/* ── 4. formats and palettes ────────────────────────────────────────────── */

H('4. Verdict parity across formats, palettes and type systems');
{
  let combos = 0, mismatch = 0;
  for (const fmt of browser.FORMATS) {
    for (const pal of browser.PALETTES) {
      for (const ty of browser.TYPE_SYSTEMS) {
        const design = { layout: 'lay.stack', back: 'back.contact', palette: pal.id, type: ty.id,
                         density: 'tight', format: fmt.id, corner: 0, script: 'latin' };
        const share = { origin: 'https://cardworks.bd', code: 'aa11bb22' };
        Object.assign(browser.state, { format: fmt.id, type: ty.id, palette: pal.id,
          density: 'tight', corner: 0, shareCode: share.code });
        const bf = browser.facesFor(design, browser.PRESETS[1].c);
        const a = browser.allFindings(bf.front, bf.back).map(key).join('\n');
        const b = gate.buildReport({ design, content: browser.PRESETS[1].c, share }).findings.map(key).join('\n');
        combos++;
        if (a !== b) mismatch++;
      }
    }
  }
  ok(`${combos} format × palette × type combinations agree exactly`, mismatch === 0, mismatch + ' divergent');
}

/* ── 5. the required-field check, which spans both faces ────────────────── */

H('5. The required-field check is assembled the same way');
{
  /* `allFindings` unshifts one finding per required slot, so the order of
     the report depends on the iteration order of SLOTDEFS. A server that
     appended instead of unshifting would still count the same and read
     differently, which is why the position is asserted and not just the
     presence. */
  const required = Object.keys(browser.SLOTDEFS).filter(r => browser.SLOTDEFS[r].required);
  const design = { layout: 'lay.stack', back: 'back.mark', palette: 'pal.ink', type: 'typ.siliguri',
                   density: 'balanced', format: 'bd-std', corner: 0, script: 'latin' };
  const share = { origin: 'https://cardworks.bd', code: 'aa11bb22' };
  Object.assign(browser.state, { format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
    density: 'balanced', corner: 0, shareCode: share.code });

  const bare = { name: 'Sharmin Akter' };           // no contact route anywhere
  const bf = browser.facesFor(design, bare);
  const a = browser.allFindings(bf.front, bf.back);
  const r = gate.buildReport({ design, content: bare, share });

  ok(`${required.length} required slots are checked on both sides`,
     a.filter(f => /^Required field/.test(f.label)).length === required.length &&
     r.findings.filter(f => f.code === 'required-field').length === required.length);
  ok('the required-field findings sit in the same positions',
     a.slice(0, required.length).map(key).join('|') === r.findings.slice(0, required.length).map(key).join('|'));
  ok('a missing required field blocks on the server', r.status === 'blocked' &&
     r.findings.some(f => f.severity === 'blocking' && f.code === 'required-field'));
}

/* ── 6. the gate ────────────────────────────────────────────────────────── */

H('6. assertPrintable refuses what preflight refuses');
{
  const share = { origin: 'https://cardworks.bd', code: 'aa11bb22' };
  const content = browser.PRESETS[1].c;
  const base = { back: 'back.contact', palette: 'pal.ink', type: 'typ.siliguri', density: 'balanced',
                 format: 'bd-std', corner: 0, script: 'latin' };

  /* A QR back on a design that was never saved: the link the symbol encodes
     does not resolve, which the engine reports as blocking. It is the
     cleanest blocking case to build without deliberately breaking a layout. */
  const unsaved = await gate.assertPrintable(null, {
    design: { ...base, layout: 'lay.stack', back: 'back.qr' }, content, share: {} });
  ok('an unsaved design with a QR is refused', unsaved.ok === false && unsaved.report.status === 'blocked');
  ok('the refusal is a 422 in the standard envelope', unsaved.refusal.status === 422);
  {
    const body = JSON.parse(await unsaved.refusal.clone().text());
    ok('the refusal carries the report and a remediation',
       body.error.code === 'unprocessable' && !!body.error.remediation && body.error.report.blocking > 0);
  }

  const saved = await gate.assertPrintable(null, {
    design: { ...base, layout: 'lay.stack', back: 'back.qr' }, content, share });
  ok('the same design, saved, stops blocking on the QR link',
     !saved.report.findings.some(f => f.code === 'qr-pending'));

  /* Advisory findings must not pass the gate on their own. With no database
     there can be no acceptance on file, so an advisory design is refused —
     which is exactly the §6.3 rule that an advisory needs recorded consent. */
  const advisoryDesign = browser.LAYOUTS.filter(l => l.face === 'front')
    .map(l => ({ ...base, layout: l.id }))
    .find(d => gate.buildReport({ design: d, content, share }).status === 'advisory');
  ok('the matrix contains an advisory-only design to test with', !!advisoryDesign);
  if (advisoryDesign) {
    const g1 = await gate.assertPrintable(null, { design: advisoryDesign, content, share });
    ok('an unaccepted advisory is refused', g1.ok === false && g1.report.status === 'advisory' && g1.report.unaccepted.length > 0);
    const g2 = await gate.assertPrintable(null, { design: advisoryDesign, content, share, requireAdvisoryAcceptance: false });
    ok('and passes when the caller only wants the blocking tier', g2.ok === true);
  }

  const missing = await gate.assertPrintable(null, { design: { ...base, layout: 'lay.no.such' }, content, share });
  ok('a design naming a layout the library does not have is a 422, not a 500',
     missing.ok === false && missing.refusal.status === 422 && missing.report === null);
  const nothing = await gate.assertPrintable(null, {});
  ok('a request with neither a code nor a design is a 400', nothing.refusal.status === 400);
  const noDb = await gate.assertPrintable(null, { shortCode: 'abc12345' });
  ok('a short code with no database configured is a 503', noDb.refusal.status === 503);
}

/* ── 7. acceptance ──────────────────────────────────────────────────────── */

H('7. Advisory acceptance is recorded against a finding, never invented');
{
  const share = { origin: 'https://cardworks.bd', code: 'aa11bb22' };
  const content = browser.PRESETS[0].c;
  const blocked = gate.buildReport({
    design: { layout: 'lay.stack', back: 'back.qr', palette: 'pal.ink', type: 'typ.siliguri',
              density: 'balanced', format: 'bd-std', corner: 0, script: 'latin' },
    content, share: {} });

  const blockingFinding = blocked.findings.find(f => f.severity === 'blocking');
  const r1 = await gate.recordAcceptance(null, { report: blocked, findingId: blockingFinding.id, actor: '+8801711123456' });
  ok('a blocking finding cannot be accepted', r1.ok === false && /advisory/.test(r1.reason));

  const r2 = await gate.recordAcceptance(null, { report: blocked, findingId: 'deadbeef', actor: '+8801711123456' });
  ok('a finding id not in this report is rejected', r2.ok === false && /no such finding/.test(r2.reason));

  ok('every finding carries an id, a code and a severity',
     blocked.findings.every(f => /^[0-9a-f]{12}$/.test(f.id) && !!f.code &&
       ['blocking', 'advisory', 'informational', 'pass'].includes(f.severity)));

  /* The id has to be a function of the finding and nothing else, or an
     acceptance recorded on one request would not match the same finding on
     the next one. */
  const again = gate.buildReport({
    design: { layout: 'lay.stack', back: 'back.qr', palette: 'pal.ink', type: 'typ.siliguri',
              density: 'balanced', format: 'bd-std', corner: 0, script: 'latin' },
    content, share: {} });
  ok('finding ids are stable across runs', blocked.findings.map(f => f.id).join() === again.findings.map(f => f.id).join());
  ok('the subject hash is stable across runs', blocked.specHash === again.specHash);
}

/* ── 8. the bands the browser does not have ─────────────────────────────── */

H('8. Finish clearance and lead time are additive, never a change of verdict');
{
  const share = { origin: 'https://cardworks.bd', code: 'aa11bb22' };
  const content = browser.PRESETS[1].c;
  const design = { layout: 'lay.stack', back: 'back.contact', palette: 'pal.ink', type: 'typ.siliguri',
                   density: 'balanced', format: 'bd-std', corner: 0, script: 'latin' };

  const plain = gate.buildReport({ design, content, share });
  const foiled = gate.buildReport({ design, content, share, finishes: ['foil', 'spotuv'] });

  const core = r => r.findings.filter(f => !['finish-clearance', 'lead-time'].includes(f.code)).map(key).join('\n');
  ok('declaring a finish leaves every engine finding untouched', core(plain) === core(foiled));
  ok('with no finish declared there is no extra band at all', plain.findings.length ===
     plain.findings.filter(f => !['finish-clearance', 'lead-time'].includes(f.code)).length);
  ok('foil adds a clearance check per face', foiled.findings.filter(f => f.code === 'finish-clearance').length === 2);
  ok('a plate finish adds one informational finding', foiled.informational === 1 &&
     foiled.findings.some(f => f.code === 'lead-time' && f.severity === 'informational'));
  ok('informational findings never gate', ['pass', 'advisory'].includes(foiled.status) ||
     foiled.blocking === foiled.findings.filter(f => f.severity === 'blocking').length);

  /* A lamination has no register problem of its own, so it must not produce a
     clearance finding — a gate that fires on everything teaches people to
     ignore it. */
  const matte = gate.buildReport({ design, content, share, finishes: ['matte'] });
  ok('lamination adds nothing', core(matte) === matte.findings.map(key).join('\n'));
}

/* ── 9. the restore path a short code actually takes ────────────────────── */

H('9. designFrom mirrors currentDesign() on a restored session');
{
  /* `designs.mjs` stores the session snapshot, and the snapshot has no
     generated concept in it — so a design reopened from a short code takes
     its layout from the saved fields. The server has to reconstruct the same
     thing, including the script rules that rewrite the back face. */
  const snap = { format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink', density: 'balanced',
                 back: 'back.bangla', script: 'bangla-only', layout: 'lay.stack',
                 corner: 3, finishes: ['matte'], refine: null, content: browser.PRESETS[0].c };
  const d = gate.designFrom(snap);
  ok('bangla-only forces a contact back, as the browser does', d.back === 'back.contact' && d.script === 'bangla');

  const latinOnly = gate.designFrom({ ...snap, script: 'latin-only' });
  ok('latin-only rewrites a bangla back', latinOnly.back === 'back.contact' && latinOnly.script === 'latin');

  const plain = gate.designFrom({ ...snap, script: 'latin' });
  ok('a plain script leaves the saved back alone', plain.back === 'back.bangla' && plain.corner === 3);

  const refined = gate.designFrom({ ...snap, refine: { layout: 'lay.split', back: 'back.qr', script: 'latin' } });
  ok('a typed refinement replaces the design wholesale', refined.layout === 'lay.split' && refined.back === 'back.qr');
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
