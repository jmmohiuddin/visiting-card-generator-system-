/* The print writer's front door.
 *
 * `renderPrintPDF(spec, opts)` is a pure function: the same spec and the same
 * finishes produce byte-identical files, every time, on any machine with this
 * repository checked out. Nothing in the pipeline reads a clock, a random
 * number or the network, which is what makes the golden-file suite Technical
 * Design §11 asks for possible — a byte diff is then always a real change in
 * geometry, never noise.
 *
 * The order of operations matters and is the product, not an implementation
 * detail. Compose, then preflight, then refuse, then write. A file is only
 * ever produced after every blocking check has passed, because §6.3 gives the
 * customer no override and this is where that promise is actually kept.
 */
import crypto from 'node:crypto';
import { engine, engineVersion } from '../engine-node.mjs';
import { Content } from './writer.mjs';
import { writePdf, docGeometry, PT_PER_MM, MARK_MARGIN } from './document.mjs';
import { paintCard } from './artwork.mjs';
import { specialsFor, writeSeparation } from './separations.mjs';
import { tacOf, TAC_LIMIT } from './cmyk.mjs';
import { PrintRefusal, refuse } from './refusal.mjs';
import { vendoredFamilies } from './fonts.mjs';

export { PrintRefusal, docGeometry, PT_PER_MM, MARK_MARGIN, specialsFor, vendoredFamilies };

const CREATOR = 'CARDWORKS print writer';

/* Hashed once. `engineVersion()` re-reads and re-hashes the engine source on
   every call, which is fine at save time and wasteful on the render path,
   already the heaviest step in an otherwise cheap pipeline (§7.2). */
const ENGINE = engineVersion();

/* Overlap uses the same 0.1mm slack the engine's preflight uses, so a card
   that passed there is not failed here over a rounding difference. */
const overlaps = (a, b) =>
  a.x < b.x + b.w - 0.1 && b.x < a.x + a.w - 0.1 &&
  a.y < b.y + b.h - 0.1 && b.y < a.y + a.h - 0.1;

function documentId(spec, finishes, stock) {
  const h = crypto.createHash('sha256')
    .update(JSON.stringify([spec, finishes, stock]))
    .digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

/** Render a composed design to a PDF/X-4 press file plus one plate per
 *  special finish.
 *
 *  @param spec      a DesignSpec, exactly as `specFrom` builds it
 *  @param finishes  the order's finish list; only foil/spot UV/emboss plate
 *  @param stock     'coated' or 'uncoated' — sets the TAC ceiling
 *  @param createdAt an optional PDF date string. Supplying one stamps the
 *                   file and gives up byte-identical output; the default is
 *                   no timestamp at all.
 */
export function renderPrintPDF(spec, { finishes = [], stock = 'coated', createdAt = null } = {}) {
  const E = engine();

  /* The finish list is an argument here and not a field of the spec, because
     it belongs to the ORDER: the same design can be quoted plain and foiled.
     But the safe area depends on it — PRD §7 puts a registered finish at 5 mm
     and a die at 6 mm — so the composer has to be told, or it places content
     at the plain-ink 4 mm and this file goes to a press with the customer's
     name inside the foil's registration tolerance. The order's list wins over
     anything the design record happens to carry, because it is the list that
     will actually be produced. */
  const c = E.compose({ ...spec, finishes });
  if (!c || c.eliminated)
    refuse('layout_eliminated',
      `This content cannot be composed on ${spec.layout}: ${c ? c.eliminated : 'no composition'}. ` +
      `The engine eliminates a layout rather than render it badly, so there is nothing here to print.`);

  /* Server-side preflight, on the server's own composition. The client's
     verdict is not consulted and could not be trusted if it were — a browser
     is the one place in this system a customer can change the answer. */
  const findings = E.preflight(c);
  const blocking = findings.filter(f => f.s === 'fail');
  if (blocking.length)
    refuse('preflight_blocking',
      `Preflight refuses this design: ${blocking.map(f => f.label).join('; ')}. Technical Design §6.3 ` +
      `gives no override on a blocking finding — the card has to change, not the check.`,
      blocking);

  const art = new Content();
  const painted = paintCard(art, c, { gridFor: E.gridFor });

  checkInk(painted.colours, stock);
  const drift = checkGeometry(c, painted.extents, findings);

  const docId = documentId(spec, finishes, stock);

  /* Plates first. A finish the composition cannot carry has to refuse before
     a composite exists, or the customer is handed an ink-only file for a
     card they ordered foiled — which is the failure this whole endpoint is
     built to prevent. */
  const separations = [];
  for (const special of specialsFor(finishes)) {
    const plate = writeSeparation(c, special, { docId, creator: CREATOR });
    if (plate) separations.push(plate);
  }

  const tacUsed = Math.max(...painted.colours.map(x => tacOf(x.hex)));
  const corner = Math.max(0, Math.min(6, Number(spec.corner) || 0));
  const composite = writePdf({
    fmt: c.fmt, art, docId, createdAt, creator: CREATOR,
    title: `CARDWORKS press file — ${c.face.name}, ${c.fmt.w}×${c.fmt.h} mm`,
    subject: [
      `Trim ${c.fmt.w} × ${c.fmt.h} mm, bleed ${c.fmt.bleed} mm, safe area ${c.fmt.safe} mm`,
      'DeviceCMYK throughout, FOGRA39 output intent embedded',
      'all type outlined, no font embedded',
      `maximum ink ${tacUsed}% of ${TAC_LIMIT[stock]}% (${stock})`,
      /* The die is a separate tool and this file does not draw it: the
         artwork bleeds past the corner and the TrimBox records the rectangle
         the die is set from. The radius has to travel with the file anyway,
         so it says so here rather than in the email that carried it. */
      corner ? `die-cut: rounded corners, ${corner} mm radius, cut from the TrimBox` : 'square trim, no die',
      separations.length ? `separations supplied: ${separations.map(p => p.kind).join(', ')}`
                         : 'no special finish'
    ].join(' · ')
  });

  const g = docGeometry(c.fmt);
  return {
    composite, separations, findings, drift, engineVersion: ENGINE,
    document: {
      trimMm: [c.fmt.w, c.fmt.h], bleedMm: c.fmt.bleed, safeMm: c.fmt.safe,
      mediaMm: [g.mediaW, g.mediaH], stock,
      tacLimit: TAC_LIMIT[stock], tacUsed,
      outputIntent: 'FOGRA39 (ISO Coated v2, ECI) — assumed default, replace per press',
      fonts: 'outlined; no font dictionary is written'
    }
  };
}

/* ── Total area coverage ────────────────────────────────────────────────
   §6.1 puts the ceiling at 300% coated and 280% uncoated. Over it, the sheet
   does not dry between impressions and offsets onto the back of the next one
   — a defect that shows up after the run is printed and stacked, which is
   the worst possible time to find it. The element is named because "reduce
   your ink" is not an instruction anybody can act on. */
function checkInk(colours, stock) {
  const limit = TAC_LIMIT[stock];
  if (!limit) refuse('unknown_stock', `Stock must be 'coated' or 'uncoated'; got '${stock}'.`);
  const over = colours
    .map(x => ({ ...x, tac: tacOf(x.hex) }))
    .filter(x => x.tac > limit);
  if (!over.length) return;
  const worst = over.sort((a, b) => b.tac - a.tac)[0];
  refuse('tac_exceeded',
    `Total ink coverage is ${worst.tac}% on ${worst.ref} (${worst.hex}), over the ${limit}% limit for ` +
    `${stock} stock. Choose a lighter palette or move that element to a colour under the limit.`,
    over.map(x => ({ s: 'fail', label: `${x.ref} carries ${x.tac}% ink`, note: `${x.hex}, limit ${limit}%` })));
}

/* ── Geometry, re-measured against the real faces ───────────────────────
   The composer measures text with an approximate advance table (the browser's
   canvas metrics client-side, a per-glyph model in `lib/engine-node.mjs`
   server-side). The writer has the actual font binaries, so it knows what
   every run really measures — and it is the last place that can tell before
   the file reaches a press.

   Technical Design §4.3 wants both sides on one metrics table; until they
   are, this is the reconciliation. A run that drifts but still sits inside
   the safe area and touches nothing is reported as drift and printed. A run
   that leaves the safe area, or lands on another element, is blocking under
   §6.3 and refuses, because those are the two failures that are visible on
   the printed card. */
function checkGeometry(c, extents, findings) {
  const { fmt } = c;
  const solid = extents.filter(e => e.ref !== 'ghost' && e.ref !== 'gridlines');

  const outside = solid.filter(e =>
    e.x < fmt.safe - 0.01 || e.x + e.w > fmt.w - fmt.safe + 0.01);
  if (outside.length)
    refuse('outside_safe_area',
      `Measured against the real faces, ${outside.map(e => e.ref).join(', ')} runs outside the ` +
      `${fmt.safe} mm safe area — ${outside.map(e => `${e.ref} ends at ${(e.x + e.w).toFixed(1)} mm of ` +
      `${(fmt.w - fmt.safe).toFixed(1)} mm`).join('; ')}. The composer measured it with an approximate ` +
      `advance table and the printed glyphs are wider than that estimate.`,
      outside.map(e => ({ s: 'fail', label: `${e.ref} outside the safe area as printed`, note: e.line || '' })));

  const hits = [];
  for (let i = 0; i < solid.length; i++)
    for (let j = i + 1; j < solid.length; j++)
      if (solid[i].ref !== solid[j].ref && overlaps(solid[i], solid[j]))
        hits.push(`${solid[i].ref} × ${solid[j].ref}`);
  if (hits.length)
    refuse('glyph_collision',
      `Measured against the real faces, these elements collide: ${hits.join(', ')}. Preflight passed on ` +
      `estimated widths; the printed glyphs are wider and overlap.`,
      hits.map(h => ({ s: 'fail', label: 'Elements overlap as printed', note: h })));

  /* Reported, not refused: how far the estimate was out. This is the number
     that says when the engine's advance table needs replacing, and it belongs
     in the response rather than in a log nobody reads. */
  const runs = [];
  for (const el of c.elements) {
    if (!el.fit) continue;
    const mine = extents.filter(e => e.ref === (el.ref || el.kind));
    const real = Math.max(0, ...mine.map(e => e.w));
    if (real > 0) runs.push({ ref: el.ref || el.kind, estimatedMm: +el.fit.width.toFixed(3),
                              measuredMm: +real.toFixed(3),
                              deltaPct: +(100 * (real - el.fit.width) / (el.fit.width || 1)).toFixed(1) });
  }
  const worst = runs.reduce((a, b) => Math.abs(b.deltaPct) > Math.abs(a.deltaPct) ? b : a, { deltaPct: 0 });
  return { runs, worstDeltaPct: worst.deltaPct, findingsChecked: findings.length };
}
