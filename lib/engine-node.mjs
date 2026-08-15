/* The engine, running server-side — the same source the browser loads.
 *
 * Technical Design §10 item 3 asks for a server-side preflight mirror, and
 * §3.3 says the engine must stay a pure function of (brief, library, seed).
 * Those two together rule out a reimplementation: a second copy of the fit
 * ladder would drift from the first, and the drift would show up as a card
 * that passed in the browser and failed at the press.
 *
 * So this loads `assets/engine.js` verbatim and evaluates it against a
 * minimal DOM and a font-metric model — the same technique the 162-assertion
 * test suite already uses. There is exactly one engine.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Per-glyph advance ratios approximating the real faces. Lifted from the
   browser suite so server and CI measure text identically; when opentype.js
   metrics land with the print writer (Technical Design §4.3) both sides
   should move to that table together, never one at a time. */
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

const measureCtx = {
  font: '',
  measureText(t) {
    const m = /(\d+)px\s+(.+)$/.exec(this.font) || [0, '200', 'sans'];
    const px = +m[1], fam = m[2];
    let w = 0; for (const ch of t) w += advance(ch, fam) * px;
    const bn = /[ঀ-৿]/.test(t);
    return {
      width: w,
      fontBoundingBoxAscent: px * (bn ? 0.95 : 0.80),
      fontBoundingBoxDescent: px * (bn ? 0.35 : 0.20)
    };
  }
};

const stubEl = () => ({
  innerHTML: '', textContent: '', value: '', onclick: null, oninput: null, onchange: null,
  onkeydown: null, files: null, style: {}, dataset: {}, setAttribute() {}, appendChild() {},
  querySelectorAll: () => [], querySelector: () => stubEl(), closest: () => null
});

/* Only the engine half is evaluated. The shell files drive a DOM that does
   not exist here, and nothing server-side has any business calling them. */
/* Where assets/engine.js is depends on who is asking. Locally ROOT is the
   repository. Inside a bundled serverless function it is not: esbuild inlines
   this module into the handler, so `import.meta.url` resolves under
   netlify/functions and ROOT lands on `netlify/`, where there is no assets
   directory. The failure was ENOENT deep inside the preflight gate, which
   reported it to the customer as "a component it names no longer exists" —
   the wrong cause, and one they could not have acted on.

   So try the candidates rather than assume one, and if none exist say which
   were tried instead of surfacing a bare ENOENT. */
const ENGINE_CANDIDATES = [
  path.join(ROOT, 'assets/engine.js'),
  path.join(ROOT, '../assets/engine.js'),
  path.join(process.cwd(), 'assets/engine.js'),
  '/var/task/assets/engine.js'
];
const ENGINE_SRC = ENGINE_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!ENGINE_SRC) {
  throw new Error('assets/engine.js not found. Looked in: ' + ENGINE_CANDIDATES.join(', ')
    + ' — a bundled function must ship it (netlify.toml included_files).');
}

const EXPORTS = [
  'compose', 'renderSVG', 'preflight', 'specHash', 'stableStringify',
  'generate', 'scoreCandidate', 'explain', 'resolveIntent', 'quote', 'fitSlot', 'contrast',
  'classifyInstruction', 'applyOps', 'gradeLogo', 'qrPayload', 'parseCSV', 'bulkGenerate',
  'printDocSVG', 'separationSVG', 'gridFor', 'slotsFor',
  'LAYOUTS', 'PRESETS', 'FORMATS', 'TYPE_SYSTEMS', 'PALETTES', 'SCRIPTS', 'SLOTDEFS',
  'INDUSTRIES', 'AXES', 'W', 'LAYOUT_AXES', 'EDIT_OPS', 'EDIT_RULES', 'GRIDS', 'QR',
  'PRESS_BASE', 'FINISH_COST', 'DELIVERY', 'MARGIN'
];

let cached = null;

/** Load (once) and return the engine's public surface. */
export function engine() {
  if (cached) return cached;

  const src = fs.readFileSync(ENGINE_SRC, 'utf8');
  const sandbox = {
    document: {
      createElement: (t) => t === 'canvas' ? { getContext: () => measureCtx } : stubEl(),
      querySelector: () => stubEl(),
      querySelectorAll: () => [],
      fonts: { ready: Promise.resolve() }
    },
    performance: { now: () => 0 },
    localStorage: (() => {
      const s = {};
      return { getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: k => { delete s[k]; } };
    })(),
    location: { hash: '' },
    history: { replaceState() {} },
    btoa: b => Buffer.from(b, 'binary').toString('base64'),
    atob: b => Buffer.from(b, 'base64').toString('binary'),
    TextEncoder, TextDecoder, console, Math, Date, JSON, Map, Set, Promise
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const handle = `\n;({ ${EXPORTS.join(', ')} });`;
  cached = vm.runInNewContext(src + handle, sandbox, { filename: 'assets/engine.js' });
  return cached;
}

/** Build the spec the composer takes, from a stored design record.
 *
 *  The browser's `specFor` reads the live UI state; there is no UI here, so
 *  the same shape is assembled from an explicit record instead. Any field
 *  added to a spec in the browser has to be added here too — the parity test
 *  in `tests/engine-parity.test.mjs` is what catches it when it is not.
 */
export function specFrom(design, content, share = {}) {
  return {
    format: design.format, type: design.type, palette: design.palette,
    density: design.density || 'balanced', layout: design.layout,
    content, corner: design.corner || 0,
    share: { origin: share.origin || 'https://cardworks.bd', code: share.code || null }
  };
}

/** The engine version stamped onto anything persisted, so a spec always
 *  records which library composed it (Technical Design §7.1). */
export function engineVersion() {
  const src = fs.readFileSync(ENGINE_SRC, 'utf8');
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
  return 'eng-' + h.toString(36);
}
