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
function advance(ch, family) {
  if (/[ঀ-৿]/.test(ch)) return 0.62;                    // Bangla clusters are wide
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
const ENGINE_SRC = path.join(ROOT, 'assets/engine.js');

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
