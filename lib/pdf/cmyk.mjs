/* Colour, converted in exactly one place.
 *
 * The engine's palettes are hex, because its renderer is a browser. A press
 * file is DeviceCMYK throughout — a PDF/X-4 that carries an RGB value is a
 * file the press either rejects or, worse, converts with a profile nobody
 * agreed on. So every colour the writer emits passes through `toCmyk` here,
 * and nothing else in lib/pdf is allowed to know what a hex string is.
 *
 * The separation below is the same 100% GCR arithmetic the engine's preflight
 * uses (assets/engine.js `tac`), deliberately: a preflight that reports 214%
 * ink and a writer that lays down something else is a preflight that is not
 * telling the truth. It is a device-independent approximation, not a
 * colorimetric conversion — no ICC transform is applied. FOGRA39 is the
 * default output intent because PRD §7 says to assume it until a per-press
 * profile is confirmed; when a Dhaka press hands over its actual profile,
 * that profile replaces `assets/icc/ISOcoated_v2_eci.icc` AND this function
 * grows a real B2A lookup through it. Both, together, or neither.
 */

/** Total area coverage limits. Coated is the 300 gsm art card every Nilkhet
 *  press runs by default; uncoated is the lower limit because the sheet has
 *  no barrier and the ink sits wet on the fibre. */
export const TAC_LIMIT = { coated: 300, uncoated: 280 };

function rgbOf(hex) {
  const h = String(hex).replace('#', '');
  const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(n)) throw new Error(`not a colour: ${hex}`);
  return [0, 2, 4].map(i => parseInt(n.substr(i, 2), 16) / 255);
}

/** hex → DeviceCMYK, each component 0..1. */
export function toCmyk(hex) {
  const [r, g, b] = rgbOf(hex);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
}

/** Total ink for a colour, as the percentage a press cares about. */
export function tacOf(hex) {
  const { c, m, y, k } = toCmyk(hex);
  return Math.round((c + m + y + k) * 100);
}

/* The engine paints its gridlines at 55% and its ghost monogram at 14%
   opacity. Constant alpha is legal in PDF/X-4, but a transparency group is a
   thing a press RIP can flatten differently from the proof, and the whole
   point of this file is that what is on screen is what comes off the press.
   Both of those overlays sit on one flat ground, so the composite can be
   computed here and laid down opaque. There is then no transparency in the
   output at all, which is a stronger guarantee than accounting for it. */
export function flatten(hex, alpha, groundHex) {
  const fg = rgbOf(hex), bg = rgbOf(groundHex);
  const mix = fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
  return '#' + mix.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
