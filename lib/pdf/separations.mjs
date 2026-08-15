/* One plate per special finish.
 *
 * A foil block, a spot-UV screen and an embossing die are all the same thing
 * to the file that describes them: a solid shape, on its own page, in its own
 * named colorant, with nothing else on the sheet. Technical Design §4.2 and
 * §6.1 fix the rest — 100% K on white, spot-named, overprint off, 2mm trim
 * clearance and a 0.3mm choke.
 *
 * The finish rides on the mark or monogram, which is the smallest plate that
 * still reads and therefore the cheapest one a Dhaka press can quote. That
 * carrier set is taken from the engine's `separationSVG` so the proof the
 * customer approved and the plate the press cuts are the same shapes.
 */
import { Content } from './writer.mjs';
import { writePdf } from './document.mjs';
import { outlineRun, measureRun } from './text.mjs';
import { pathMetrics } from './geom.mjs';
import { refuse } from './refusal.mjs';

/* The clearance a block needs from the trim. A foil block that reaches the
   edge lifts the sheet and tears it, and the guillotine's drift means "at the
   edge" is anywhere within a couple of millimetres of the line. */
const TRIM_CLEARANCE = 2;

/* Choke: the plate is pulled inside the printed shape so that when the foil
   lands a fraction out of register it still sits on ink rather than beside
   it. Implemented as a fill followed by a zero-tint stroke of the same path
   at twice the choke — the stroke is centred on the outline, so it eats
   exactly `CHOKE` inward and paints `CHOKE` outward onto plate that is
   already blank. That is an exact erosion of the shape, not an approximation
   of one by scaling, which would distort the letterform.

   ⚠ 0.3 mm is Technical Design §4.2's figure and it is UNVALIDATED on paper,
   like the cost constants. It is a large trap: a monogram set at 5 mm has
   stems near 0.7 mm, and taking 0.6 mm out of a 0.7 mm stem leaves a
   hairline. `RETAINED_FLOOR` below is what stops a plate that thin from
   reaching a press; if the Phase 0 foil test (PRD §8.1) says a Dhaka block
   registers better than 0.3 mm, this is the one number to change. */
const CHOKE = 0.3;

/* How much of the plate has to survive the choke. Below this the block is
   more outline than shape and the foil will not release cleanly. */
const RETAINED_FLOOR = 0.45;

/** The finishes that produce a plate, keyed by both the product's own finish
 *  ids and the identifiers Technical Design §6.1 names them by. Lamination
 *  and rounded corners are absent on purpose: lamination is applied to the
 *  whole sheet and needs no artwork, and a rounded corner is a die the press
 *  sets from the TrimBox and the spec's corner radius. */
export const SPECIALS = {
  foil:       { kind: 'foil_gold', spot: 'FoilGold', label: 'Gold foil' },
  foil_gold:  { kind: 'foil_gold', spot: 'FoilGold', label: 'Gold foil' },
  spotuv:     { kind: 'spot_uv',   spot: 'SpotUV',   label: 'Spot UV' },
  spot_uv:    { kind: 'spot_uv',   spot: 'SpotUV',   label: 'Spot UV' },
  emboss:     { kind: 'emboss',    spot: 'Emboss',   label: 'Embossing' }
};

/** Which finishes in a list produce a plate, de-duplicated and in a fixed
 *  order so two renders of one order never differ by list order. */
export function specialsFor(finishes) {
  const seen = new Map();
  for (const f of finishes || []) {
    const s = SPECIALS[String(f).toLowerCase()];
    if (s) seen.set(s.kind, s);
  }
  return [...seen.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/* The same carriers, at the same sizes and baselines, as `artwork.mjs` paints
   them. The engine's `separationSVG` puts every carrier on one baseline
   (g.h * 0.78) regardless of kind, which leaves the plate a fraction of a
   millimetre off the ink it is meant to sit on — see the report; this side
   follows the artwork, because a plate that does not align with its element
   is worse than no plate. */
function carriersOf(c) {
  const out = [];
  for (const el of c.elements) {
    const g = el.geom;
    if (el.kind === 'mark' && !el.logo) out.push({ ref: el.ref, glyph: el.glyph || 'N', weight: 700, sizeMm: g.h * 0.58, cx: g.x + g.w / 2, baseline: g.y + g.h * 0.72 });
    else if (el.kind === 'mono' || el.kind === 'bigmono') out.push({ ref: el.ref, glyph: el.glyph || 'N', weight: 700, sizeMm: g.h * 0.9, cx: g.x + g.w / 2, baseline: g.y + g.h * 0.80 });
    else if (el.kind === 'ghost') out.push({ ref: el.ref, glyph: el.glyph || 'N', weight: 800, sizeMm: g.h, cx: g.x + g.w / 2, baseline: g.y + g.h * 0.86 });
  }
  return out;
}

/** Build the plate for one special. Returns `{ kind, spot, label, bytes,
 *  areaPct }`, or null when the composition carries nothing this finish can
 *  ride on — a card with no mark cannot be foiled, and saying so is better
 *  than shipping an empty plate the press will still charge a block for. */
export function writeSeparation(c, special, { docId, creator }) {
  const carriers = carriersOf(c);
  if (!carriers.length) return null;

  const { fmt } = c;
  const measured = carriers.map(car => {
    const w = measureRun(car.glyph, c.type.latin, car.weight, 0, car.sizeMm);
    const x = car.cx - w / 2;
    // The cap height of these faces sits near 0.72em; the box below is the
    // area the block actually occupies, which is what the clearance check and
    // the plate-area quote both need.
    return { ...car, x, w, y: car.baseline - car.sizeMm * 0.72, h: car.sizeMm * 0.9 };
  });

  const tight = measured.filter(m =>
    m.x < TRIM_CLEARANCE || m.y < TRIM_CLEARANCE ||
    m.x + m.w > fmt.w - TRIM_CLEARANCE || m.y + m.h > fmt.h - TRIM_CLEARANCE);
  if (tight.length)
    refuse('finish_crosses_trim_clearance',
      `${special.label} cannot be produced on this composition: ${tight.map(t => t.ref).join(', ')} ` +
      `comes within ${TRIM_CLEARANCE} mm of the trim. A block that close to the edge lifts and tears ` +
      `the sheet, and trim drift can put it over the cut line. Choose a layout that keeps the mark ` +
      `inside the clearance, or drop this finish.`,
      [{ s: 'fail', label: `${special.label} crosses the ${TRIM_CLEARANCE} mm trim clearance`, note: tight.map(t => t.ref).join(', ') }]);

  const outlines = measured.map(m => outlineRun(m.glyph,
    { cssStack: c.type.latin, weight: m.weight, sizeMm: m.sizeMm, trackEm: 0, x: m.x, y: m.baseline }));

  /* What the choke leaves behind, measured before anything is written.
     Area minus perimeter × 2 × choke is the eroded shape to first order. */
  const before = outlines.reduce((s2, o) => {
    const g2 = pathMetrics(o.ops);
    return { area: s2.area + g2.area, perimeter: s2.perimeter + g2.perimeter };
  }, { area: 0, perimeter: 0 });
  const retained = before.area ? Math.max(0, before.area - before.perimeter * CHOKE) / before.area : 0;
  if (retained < RETAINED_FLOOR)
    refuse('choke_consumes_plate',
      `${special.label} cannot be produced from ${measured.map(m => m.ref).join(', ')} at this size: a ` +
      `${CHOKE} mm choke leaves ${(retained * 100).toFixed(0)}% of the plate, and a block that thin will ` +
      `not release the foil. Enlarge the mark, or ask the press whether its registration allows a ` +
      `smaller choke than the ${CHOKE} mm this build assumes.`,
      [{ s: 'fail', label: `${special.label} plate retains only ${(retained * 100).toFixed(0)}% after choke`,
         note: `${CHOKE} mm choke, floor ${(RETAINED_FLOOR * 100)}%` }]);

  /* Fill the shape at full tint, then stroke the same path at zero tint to
     choke it. No white ground is painted: a blank PDF page IS white, and an
     explicit 0% rectangle only gives a RIP something extra to interpret. */
  const art = new Content();
  const emit = () => { for (const o of outlines) for (const op of o.ops) {
    if (op[0] === 'm') art.moveTo(op[1], op[2]);
    else if (op[0] === 'l') art.lineTo(op[1], op[2]);
    else if (op[0] === 'c') art.curveTo(op[1], op[2], op[3], op[4], op[5], op[6]);
    else art.close();
  } };
  art.push('/CSSpot cs').push('1 scn'); emit(); art.fill();
  art.push('/CSSpot CS').push('0 SCN').lineWidth(CHOKE * 2); emit(); art.stroke();

  const areaPct = +(100 * measured.reduce((s2, m) => s2 + m.w * m.h, 0) / (fmt.w * fmt.h)).toFixed(1);
  const bytes = writePdf({
    fmt, docId, creator, art,
    title: `CARDWORKS ${special.label} plate — ${fmt.w}×${fmt.h} mm`,
    subject: `${special.label} plate, 100% K on white, overprint off, ${CHOKE} mm choke, ` +
             `${TRIM_CLEARANCE} mm trim clearance, plate area ${areaPct}% of the card`,
    spot: { name: special.spot, alternate: [0, 0, 0, 1] }   // 100% K on white, as §6.1 requires
  });

  return { kind: special.kind, spot: special.spot, label: special.label, bytes, areaPct,
           chokeMm: CHOKE, retainedPct: +(retained * 100).toFixed(1),
           carriers: measured.map(m => m.ref) };
}
