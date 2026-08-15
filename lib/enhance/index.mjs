/* Make someone else's card printable, without redesigning it behind their back.
 *
 * The customer this serves is attached to the card they already have. A shop
 * made it, or they made it in Word, and they do not want six new concepts —
 * they want this one, working. Master PRD §1.1 says a non-designer cannot tell
 * whether a file will print correctly and only finds out after paying for a
 * run; that is the same promise this product already makes, applied to artwork
 * it did not compose.
 *
 * ── The distinction the whole feature rests on ────────────────────────────
 *
 * REPAIR is objectively correct and changes nothing about how the card looks
 * to its owner. Adding bleed, pulling type out of the guillotine's path,
 * converting to CMYK, raising 5pt type to the floor. Nobody has to be asked
 * whether they want their card to survive being cut out.
 *
 * IMPROVE is a matter of taste. A better type pairing, a corrected hierarchy,
 * a palette that actually contrasts. These are opinions, they are always
 * optional, and they are always shown as a change the customer can decline.
 *
 * Conflating the two is the way to lose this customer. Someone who is proud of
 * their card will forgive being told it would be cut off; they will not forgive
 * a tool that quietly replaced their typeface and called it a fix.
 */
import { engine } from '../engine-node.mjs';
import { toContent, toDesign } from '../ingest/index.mjs';

const MM_PER_PT = 0.352778;

/** Repairs and improvements are described before they are applied, so the
 *  screen can list them and the customer can turn any improvement off. */
export const TIER = { repair: 'repair', improve: 'improve' };

/* ── The catalogue ────────────────────────────────────────────────────────
   Each entry decides for itself whether it applies to this card, and returns
   the change it would make. Nothing here mutates; `enhance()` does that, once,
   from the list the customer accepted. */

const REPAIRS = [
  {
    id: 'bleed',
    tier: TIER.repair,
    label: 'Add 3 mm bleed on every edge',
    why: 'Without bleed, the guillotine leaves a white sliver on at least one edge of most of the run.',
    applies: (parts) => !parts.bleedMm || parts.bleedMm < 3,
    change: () => ({ bleedMm: 3 })
  },
  {
    id: 'safe_area',
    tier: TIER.repair,
    label: 'Pull content out of the trim margin',
    why: 'The guillotine drifts up to 1.5 mm. Anything closer than 4 mm to the edge can be cut off, and it will be on some cards and not others in the same box.',
    applies: (parts, ctx) => ctx.tightCount > 0,
    /* The composer already places everything inside the safe area, so the
       repair is to let it place them rather than to nudge anything: this is
       exactly why the recompose step exists. */
    change: () => ({ recompose: true })
  },
  {
    id: 'type_floor',
    tier: TIER.repair,
    label: 'Raise type that is below the print floor',
    why: 'Type under the floor survives a screen and disappears on paper under office light. Bangla collapses earlier than Latin because its conjuncts stack.',
    applies: (parts, ctx) => ctx.underFloor.length > 0,
    change: (parts, ctx) => ({
      raise: ctx.underFloor.map(p => ({ id: p.id, from: p.style.sizePt, to: ctx.floorFor(p) }))
    })
  },
  {
    id: 'cmyk',
    tier: TIER.repair,
    label: 'Convert colour to CMYK for press',
    why: 'An RGB file gets converted by whoever prints it, with whatever profile they happen to have. Converting here means the colour on the proof is the colour that was approved.',
    applies: () => true,
    change: () => ({ colorSpace: 'cmyk' })
  },
  {
    id: 'ink',
    tier: TIER.repair,
    label: 'Bring ink coverage under the limit',
    why: 'Over 300% total coverage the sheet does not dry and offsets onto the next one. It is the defect a press notices and a customer does not.',
    applies: (parts, ctx) => ctx.tacOver,
    change: () => ({ recompose: true })
  }
];

const IMPROVEMENTS = [
  {
    id: 'hierarchy',
    tier: TIER.improve,
    label: 'Make the name outrank the role',
    why: 'When the name and the title are close in size, neither reads first and the card takes a second longer to use.',
    applies: (parts, ctx) => ctx.hierarchyRatio !== null && ctx.hierarchyRatio < 1.6,
    change: () => ({ recompose: true, enforceHierarchy: true })
  },
  {
    id: 'type_pairing',
    tier: TIER.improve,
    label: 'Re-set in a checked type pairing',
    why: 'The families on this card have not been tested at card sizes. The library pairings have, including their Bangla conjuncts.',
    applies: (parts, ctx) => ctx.unknownFamilies.length > 0,
    change: (parts, ctx) => ({ type: ctx.suggestedType })
  },
  {
    id: 'palette',
    tier: TIER.improve,
    label: 'Use a palette that holds its contrast',
    why: 'The current colours fall under 4.5:1 at card size, which is legible on a backlit screen and marginal on paper.',
    applies: (parts, ctx) => ctx.contrast !== null && ctx.contrast < 4.5,
    change: (parts, ctx) => ({ palette: ctx.suggestedPalette })
  },
  {
    id: 'routes',
    tier: TIER.improve,
    label: 'Move surplus contact routes to the back',
    why: 'Past five routes on one face, none of them get read. Moving the rest to the back keeps them without crowding the front.',
    applies: (parts, ctx) => ctx.routeCount > 5,
    change: () => ({ recompose: true, moveRoutesToBack: true })
  },
  {
    id: 'grid',
    tier: TIER.improve,
    label: 'Align everything to one grid',
    why: 'Elements placed by eye sit a millimetre off each other. On a card that small it reads as untidy without anyone being able to say why.',
    applies: () => true,
    change: () => ({ recompose: true })
  }
];

/** Everything known about this card that the catalogue needs to decide. */
function context(parts) {
  const E = engine();
  const texts = parts.parts.filter(p => p.kind === 'text' && p.dropped !== true);
  const floorFor = (p) => p.script === 'latin' ? E.SCRIPTS.latin.minPt : E.SCRIPTS.bangla.minPt;
  const fmt = E.FORMATS.find(f => f.id === parts.format.matchedFormatId);
  const safe = fmt ? fmt.safe : 4;

  const tight = parts.parts.filter(p => {
    if (!(p.observed.w > 0 && p.observed.h > 0)) return false;
    if (p.kind === 'panel' && p.observed.w >= parts.format.wMm * 0.98) return false;
    return p.observed.x < safe - 0.2 || p.observed.y < safe - 0.2 ||
           p.observed.x + p.observed.w > parts.format.wMm - safe + 0.2 ||
           p.observed.y + p.observed.h > parts.format.hMm - safe + 0.2;
  });

  const name = texts.find(p => p.slot === 'name');
  const role = texts.find(p => p.slot === 'role');
  const known = E.TYPE_SYSTEMS.map(t => (t.latin + ' ' + t.bangla).toLowerCase());
  const unknownFamilies = [...new Set(texts.map(p => p.style.family).filter(Boolean))]
    .filter(f => !known.some(k => k.includes(f.toLowerCase())));

  const contrast = parts.palette.length >= 2
    ? E.contrast(parts.palette[0].hex, parts.palette[1].hex) : null;

  const tacFinding = parts.findings.find(f => /ink coverage/i.test(f.label) && f.s === 'fail');

  return {
    floorFor,
    underFloor: texts.filter(p => p.style.sizePt && p.style.sizePt < floorFor(p)),
    tightCount: tight.length,
    tight,
    hierarchyRatio: name?.style.sizePt && role?.style.sizePt
      ? name.style.sizePt / role.style.sizePt : null,
    unknownFamilies,
    suggestedType: toDesign(parts).type,
    suggestedPalette: toDesign(parts).palette,
    contrast,
    tacOver: !!tacFinding,
    routeCount: texts.filter(p => p.slot === 'contact').length,
    safe
  };
}

/**
 * What could be done to this card, split by tier and with nothing applied.
 *
 * The screen shows this list; the customer accepts or declines each
 * improvement; `enhance()` is then called with the ids they kept. Repairs are
 * listed too, so nothing happens to their card that they were not told about,
 * but they are not presented as optional.
 */
export function plan(parts) {
  const ctx = context(parts);
  const consider = (entry) => entry.applies(parts, ctx)
    ? { id: entry.id, tier: entry.tier, label: entry.label, why: entry.why,
        detail: entry.change(parts, ctx) }
    : null;

  return {
    repairs: REPAIRS.map(consider).filter(Boolean),
    improvements: IMPROVEMENTS.map(consider).filter(Boolean),
    quality: parts.quality,
    findings: parts.findings
  };
}

/**
 * Apply the repairs and the accepted improvements, and return a card that has
 * been through the real composer and the real preflight.
 *
 * Deterministic by construction: the accepted ids are sorted before they are
 * applied, so the same card and the same choices produce byte-identical output
 * and the caching model in Technical Design §7.1 keeps working.
 */
export function enhance(parts, { accept = [], declineAll = false } = {}) {
  const ctx = context(parts);
  const applied = [];
  const acceptedSet = new Set(declineAll ? [] : accept);

  const chosen = [
    ...REPAIRS.filter(r => r.applies(parts, ctx)),
    ...IMPROVEMENTS.filter(i => i.applies(parts, ctx) && acceptedSet.has(i.id))
  ].sort((a, b) => a.id.localeCompare(b.id));

  const working = structuredClone(parts);
  const over = {};

  for (const entry of chosen) {
    const change = entry.change(parts, ctx);
    applied.push({ id: entry.id, tier: entry.tier, label: entry.label });

    if (change.raise) {
      for (const r of change.raise) {
        const p = working.parts.find(x => x.id === r.id);
        if (p) p.style.sizePt = r.to;
      }
    }
    if (change.type) over.type = change.type;
    if (change.palette) over.palette = change.palette;
    if (change.bleedMm) working.bleedMm = change.bleedMm;
    if (change.colorSpace) working.colorSpace = change.colorSpace;
  }

  /* Recomposing is not one of the changes — it is what makes all of them real.
     The composer places everything inside the safe area, on the grid, under
     the ink limit, above the type floor, because that is what it does for
     every card. So "fix the geometry" is spelled "let the composer do it". */
  const design = { ...toDesign(working), ...over };
  const content = toContent(working, { includeUnsure: true });

  const E = engine();
  const spec = {
    format: design.format, type: design.type, palette: design.palette,
    density: design.density, layout: design.layout, content,
    corner: design.corner || 0,
    share: { origin: 'https://cardworks.bd', code: null }
  };

  let composed;
  try { composed = E.compose(spec); }
  catch (err) {
    return { ok: false, reason: 'This card cannot be recomposed from what was read out of it.',
             detail: String(err && err.message), applied, plan: plan(parts) };
  }
  if (composed.eliminated) {
    /* Honest failure. The content does not fit any layout at a legible size,
       which is the constraint-conflict case the product already has a screen
       for — and the answer is the same three costed options, not a worse card. */
    return { ok: false, reason: `No layout can hold this card's content at a legible size: ${composed.eliminated}`,
             alternatives: ['move the qualifications to the back', 'switch to portrait',
                            'use a larger trim size'],
             applied, plan: plan(parts) };
  }

  const findings = E.preflight(composed);

  /* The "after" score is derived from the composed card's own preflight, not by
     re-assessing the parts. Re-assessing would read the uploaded file's
     geometry, which the composer has just replaced — so a repaired card would
     report the defect it no longer has, and the before/after the customer is
     shown would say the repair did nothing. */
  const blocking = findings.filter(f => f.s === 'fail').length;
  const advisory = findings.filter(f => f.s === 'review').length;
  const passed = findings.filter(f => f.s === 'pass').length;
  const score = Math.max(0, Math.min(100,
    Math.round(100 * passed / Math.max(1, passed + advisory + blocking * 2))));

  return {
    ok: true,
    applied,
    design, content,
    svg: E.renderSVG(composed),
    findings,
    blocking, advisory, passed,
    before: { quality: parts.quality, findings: parts.findings },
    after: { quality: { score, band: blocking ? 'poor' : advisory > 1 ? 'fair' : 'good' } },
    /* Every improvement the customer declined, so the screen can keep offering
       them rather than forgetting they existed. */
    declined: IMPROVEMENTS.filter(i => i.applies(parts, ctx) && !acceptedSet.has(i.id))
      .map(i => ({ id: i.id, label: i.label, why: i.why }))
  };
}
