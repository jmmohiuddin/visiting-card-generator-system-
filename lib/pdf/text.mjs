/* Text, turned into filled paths.
 *
 * This is the whole reason `lib/pdf` exists rather than a call to a PDF
 * library: the output carries no font dictionary of any kind, so a run of
 * text has to become the same thing a drawn rule is — a path with a fill.
 * The advantage is not only licensing (PRD §7 makes outlining a hard library
 * policy). It is that a file with no fonts in it cannot render differently on
 * the press's RIP than it did on the proof, because there is nothing left for
 * the RIP to substitute.
 */
import { loadFace, hasBangla } from './fonts.mjs';
import { shapeBengali, isDefaultIgnorable } from './bengali.mjs';
import { refuse } from './refusal.mjs';

/* ── What Bangla still refuses, and why that list is short now ──────────
   Bengali text is shaped, not spelled: GSUB turns ক + ্ + ষ into the single
   conjunct ক্ষ, moves ি to the left of the consonant it follows in memory,
   and lifts র before a halant onto the cluster as a reph. This file used to
   refuse the whole script rather than outline it a codepoint at a time,
   because a card whose Bangla face is subtly wrong is not caught at the
   proof — the customer reads what they meant to write — and is then caught
   by every person handed one of the 500 cards afterwards.

   `bengali.mjs` now does the shaping, against the font's own tables, and
   `tests/shaping.test.mjs` checks it glyph for glyph against headless
   Chromium over the conjunct matrix and a card vocabulary. So the blanket
   refusal is gone and three specific ones remain, all raised from
   `bengali.mjs` with their own codes:

     bangla_no_bengali_script   the face carries no bng2/beng shaping rules
     bangla_unreadable_lookup   a layout subtable this reader cannot parse,
                                which would mean a rule silently not firing
     bangla_broken_cluster      text that is not a well-formed syllable

   The last is the one worth defending. A shaper for a screen answers a
   broken cluster with a dotted circle, which tells the person typing that
   something is wrong. A press file has no one to tell, so it refuses.

   What is NOT refused and is worth knowing: Latin inside a Bangla run is
   passed through unkerned, exactly as an all-Latin run is. The browser
   kerns it, so a mixed line can measure a few tenths of a percent narrower
   on screen than on the plate. That is the Latin path's long-standing
   behaviour and the geometry check in index.mjs is what catches it. */

/* One run, resolved to positioned glyphs in em units.
 *
 * Latin is spelled: one codepoint, one glyph, one advance, and this is the
 * whole of it. Bengali is shaped, so it goes through `bengali.mjs`, which
 * asks the font's own GSUB and GPOS what the cluster becomes. Both come back
 * in the same shape — a list of glyph ids with an advance and an offset —
 * so everything below this line is written once and does not branch on
 * script. Tracking is applied per glyph gap by the caller, not here.
 */
function glyphRun(face, text) {
  if (hasBangla(text)) {
    return shapeBengali(text, face).map(g => ({
      gid: g.gid,
      advEm: g.xAdvance / face.unitsPerEm,
      dxEm: g.xOffset / face.unitsPerEm,
      dyEm: g.yOffset / face.unitsPerEm
    }));
  }
  /* A zero-width joiner or a soft hyphen has no business on a plate, and a
     font may carry a visible proof-sheet glyph for one. The Bengali path
     drops them after shaping, where they still do their work; the Latin path
     has no work for them to do, so they go before the glyph lookup rather
     than being refused for a glyph they should never have been given. */
  return [...String(text)]
    .filter(ch => !isDefaultIgnorable(ch.codePointAt(0)))
    .map(ch => {
      const gid = glyphFor(face, ch);
      return { gid, advEm: face.advanceEm(gid), dxEm: 0, dyEm: 0 };
    });
}

/** Advance widths for a run, in millimetres, using the real face. The
 *  arithmetic mirrors the engine's `measure()` exactly — per-glyph advances
 *  plus `track` on the n−1 gaps — so a width from here and a width from the
 *  composer differ only by the accuracy of the metrics, never by the method.
 *
 *  For Bengali the glyph count is not the character count: ক + ্ + ষ is three
 *  characters and one glyph, so tracking is counted on the gaps between the
 *  glyphs that actually get drawn. Tracking the codepoints instead would add
 *  space inside a conjunct, which is not a place space belongs. */
export function measureRun(text, cssStack, weight, trackEm, sizeMm) {
  const face = loadFace(cssStack, weight);
  const run = glyphRun(face, text);
  let em = 0;
  for (const g of run) em += g.advEm;
  return (em + trackEm * Math.max(0, run.length - 1)) * sizeMm;
}

function glyphFor(face, ch) {
  const gid = face.glyphIdFor(ch.codePointAt(0));
  if (!gid) {
    const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    refuse('glyph_missing',
      `${face.family} ${face.weight} has no glyph for U+${hex} (“${ch}”). The vendored subset in ` +
      `assets/fonts does not cover this character, and a press file must never fall back to .notdef.`);
  }
  return gid;
}

/** The outlines of one line, in millimetres, as path commands. `x` is the
 *  left edge of the run and `y` is the baseline, both measured from the
 *  top-left of the artwork — the same frame the composer's geometry is in.
 *
 *  Returned rather than emitted because a finish plate needs the same path
 *  three times: once to fill it, once to choke it, and once to measure
 *  whether the choke left a plate a press can cut.
 */
export function outlineRun(text, { cssStack, weight, sizeMm, trackEm, x, y }) {
  const face = loadFace(cssStack, weight);
  const run = glyphRun(face, text);
  const s = sizeMm / face.unitsPerEm;
  const ops = [];

  let pen = x;
  for (const g of run) {
    /* A shaped mark carries an offset from the glyph it hangs on — a reph
       sits above the cluster it follows in the buffer, and a matra below the
       consonant before it — so the pen is not the whole story for Bengali. */
    const ox = pen + g.dxEm * sizeMm, oy = y - g.dyEm * sizeMm;
    for (const cmd of face.pathFor(g.gid)) {
      if (cmd[0] === 'h') { ops.push(['h']); continue; }
      const t = [cmd[0]];
      for (let i = 1; i < cmd.length; i += 2) t.push(ox + cmd[i] * s, oy - cmd[i + 1] * s);
      ops.push(t);
    }
    pen += (g.advEm + trackEm) * sizeMm;
  }
  return { ops, width: pen - x - (run.length ? trackEm * sizeMm : 0) };
}

/** Push an outlined run into a content stream as a path, without painting it. */
export function runPath(content, text, opts) {
  const { ops, width } = outlineRun(text, opts);
  for (const op of ops) {
    if (op[0] === 'm') content.moveTo(op[1], op[2]);
    else if (op[0] === 'l') content.lineTo(op[1], op[2]);
    else if (op[0] === 'c') content.curveTo(op[1], op[2], op[3], op[4], op[5], op[6]);
    else content.close();
  }
  return width;
}

/** The same run, filled in one CMYK colour. TrueType contours wind so that
 *  the non-zero rule leaves counters open; an even-odd fill would punch the
 *  wrong holes out of every 'a' and 'e'. */
export function drawRun(content, text, opts) {
  content.fillCmyk(opts.cmyk);
  const w = runPath(content, text, opts);
  content.fill();
  return w;
}
