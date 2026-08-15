/* The vendored face registry.
 *
 * The engine names a face the way CSS does — `"'Libre Franklin',sans-serif"`
 * — because the browser is its renderer. A press file has no font fallback
 * chain: whichever face the writer outlines is the one that gets printed, for
 * good. So the first quoted family in that string is resolved here against
 * binaries that live in this repository, and a family with no binary is an
 * error, never a substitution. Substituting silently is how a customer ends
 * up holding 500 cards set in a face they never saw on screen.
 *
 * Re-vendor with `node lib/pdf/vendor-fonts.mjs assets/fonts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrueTypeFont } from './truetype.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FONT_DIR = path.join(ROOT, 'assets/fonts');

const slug = family => family.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The first quoted family in a CSS font stack — `'Hind Siliguri',sans-serif`
 *  → `Hind Siliguri`. An unquoted stack is taken whole, which is what the
 *  engine's `monospace`/`serif` tails would produce and which then fails
 *  loudly at load rather than quietly picking something. */
export function familyOf(cssStack) {
  const m = /'([^']+)'|"([^"]+)"/.exec(String(cssStack || ''));
  return (m ? (m[1] || m[2]) : String(cssStack || '').split(',')[0]).trim();
}

/* Which weights are actually on disk, discovered rather than declared, so a
   table in this file can never claim a face the repository does not hold. */
let _available = null;
function available() {
  if (_available) return _available;
  _available = new Map();
  let names = [];
  try { names = fs.readdirSync(FONT_DIR); } catch { names = []; }
  for (const n of names) {
    const m = /^(.+)-(\d{3})\.ttf$/.exec(n);
    if (!m) continue;
    if (!_available.has(m[1])) _available.set(m[1], new Map());
    _available.get(m[1]).set(+m[2], path.join(FONT_DIR, n));
  }
  return _available;
}

/* The browser picks the nearest published weight and synthesises the rest.
   Doing the same here is what keeps the printed card and the on-screen proof
   the same object: IBM Plex Mono stops at 700 and Tiro Bangla ships only 400,
   so a request for 800 has to resolve somewhere, and resolving it the way the
   preview already resolved it is the only answer that does not introduce a
   difference the customer never approved. What this writer will NOT do is
   synthesise the missing weight by stroking the outline — a faux-bold plate
   is a fabrication, and the report says so where it matters. */
function nearestWeight(weights, want) {
  let best = null, bestD = Infinity;
  for (const w of weights) {
    const d = Math.abs(w - want) + (w < want ? 0.5 : 0);   // ties break heavier, as CSS does above 500
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

const _loaded = new Map();

/** Load the vendored face for a CSS stack and weight. Throws with the family
 *  named when nothing is vendored for it — the caller turns that into a
 *  blocking finding rather than a stack trace. */
export function loadFace(cssStack, weight) {
  const family = familyOf(cssStack);
  const key = slug(family);
  const byWeight = available().get(key);
  if (!byWeight || !byWeight.size)
    throw new Error(`font ${family} is not vendored — no ${key}-*.ttf in assets/fonts`);

  const resolved = byWeight.has(weight) ? weight : nearestWeight([...byWeight.keys()], weight);
  const cacheKey = key + '/' + resolved;
  let face = _loaded.get(cacheKey);
  if (!face) {
    face = new TrueTypeFont(fs.readFileSync(byWeight.get(resolved)), `${family} ${resolved}`);
    face.family = family;
    face.weight = resolved;
    _loaded.set(cacheKey, face);
  }
  return face;
}

/** Every family the engine's type systems can ask for, and whether it is
 *  present. `render-print` reports this rather than discovering a gap halfway
 *  through writing a file the customer is waiting on. */
export function vendoredFamilies() {
  const out = {};
  for (const [key, byWeight] of available()) out[key] = [...byWeight.keys()].sort((a, b) => a - b);
  return out;
}

/* ── The Bangla wall, and where it moved to ─────────────────────────────
   Bengali is not a per-codepoint script. `ক` + `্` + `ষ` is one glyph, ক্ষ,
   produced by GSUB substitution; `ি` is typed after its consonant and drawn
   before it; `র` before a halant becomes a reph that rides the top of the
   cluster it is not adjacent to. Mapping codepoints straight to glyph ids
   produces a sequence of disconnected letters that is not the word anybody
   typed, and this writer refused the whole script rather than do that.

   `bengali.mjs` now shapes it, against each face's own GSUB and GPOS rather
   than against any table written down here — the four families vendored
   above disagree about which conjuncts they form and by which mechanism, so
   asking the font is the only answer correct for all of them. This range is
   still what decides which path a run takes.

   One thing the engine has not caught up on: it charges a flat 0.62 em per
   Bangla codepoint (assets/engine.js and lib/engine-node.mjs), and shaping
   turns three codepoints into one conjunct. So a composed Bangla run is laid
   out about a fifth wider than it prints. The composition is safe — narrower
   than estimated never leaves the safe area — but the fit ladder is choosing
   a smaller size than the type needs, and the 7.5pt Bangla floor in SCRIPTS
   is being approached earlier than it should be. Closing that means moving
   the browser and server metric tables together, which is not this file's
   to do. */
export const BANGLA_RANGE = /[ঀ-৿]/;

export function hasBangla(text) { return BANGLA_RANGE.test(String(text || '')); }
