/* Changing one part of a card, without opening a canvas.
 *
 * This is the file the "take a card apart and restyle it" feature runs on, and
 * the constraint from `contract.mjs` is enforced here rather than trusted:
 *
 *   An operation changes what a part IS. It never changes where a part SITS.
 *
 * Every operation below re-selects a value from a validated set and hands the
 * result back to the composer. `observed` geometry is carried along as
 * evidence about the uploaded file and is never read by anything that composes
 * — `assertGeometryUnused` proves that rather than asserting it in prose.
 *
 * The second rule is that a refusal explains itself. An edit surface that
 * greys a control out teaches nothing; one that says "7.5 pt is the smallest
 * size Bangla conjuncts survive on 300 gsm" teaches the thing the product
 * exists to know. So every rejection carries a reason and a list of what the
 * customer can do instead.
 */
import { PART_OPS, isPartOp, refuseEdit, CONFIDENT } from './contract.mjs';
import { engine } from '../engine-node.mjs';
import { toContent, toDesign } from './index.mjs';

const MM_PER_PT = 0.352778;

/* The engine's slot vocabulary. A part can only be assigned to a slot the
   composer actually has, and `required` decides whether it may be dropped. */
const slotInfo = () => {
  const E = engine();
  return E.SLOTDEFS;
};

/** Which library colours are offerable for a part, and why the rest are not.
 *
 *  Contrast is checked against the ground the part actually sits on, at
 *  rendered size, using the engine's own function — so the answer here is the
 *  answer preflight will give later, rather than a second opinion that can
 *  drift from it. */
export function coloursFor(parts, part) {
  const E = engine();
  const ground = (parts.palette[0] || { hex: '#ffffff' }).hex;
  const seen = new Set();
  const out = [];
  for (const pal of E.PALETTES) {
    for (const [role, hex] of Object.entries(pal)) {
      if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) continue;
      if (seen.has(hex.toLowerCase())) continue;
      seen.add(hex.toLowerCase());
      const ratio = E.contrast(hex, ground);
      /* Text has to clear 4.5:1 at card size. A rule or a panel is not read,
         so it is held to 3:1 — enough to be visible without pretending a
         hairline needs to pass a text threshold. */
      const floor = part.kind === 'text' ? 4.5 : 3;
      /* Two decimals in the refusal, one in the display. Rounding 4.49 to
         "4.5" and then saying it is under 4.5 reads as a contradiction, and a
         refusal a customer thinks is a bug is a refusal they try to argue
         with. */
      out.push({ hex, role, ratio: +ratio.toFixed(1), palette: pal.id,
                 available: ratio >= floor,
                 why: ratio >= floor ? null
                   : `${ratio.toFixed(2)}:1 against this ground, under the ${floor}:1 a ${part.kind === 'text' ? 'reader' : 'visible mark'} needs at card size` });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

/** Which type systems can set this part. A family that cannot render the
 *  part's script is not offered for it — the engine already records which
 *  families have been checked for Bangla, and offering one that has not been
 *  is how a conjunct breaks on paper. */
export function familiesFor(part) {
  const E = engine();
  const needsBangla = part.script === 'bangla' || part.script === 'mixed';
  return E.TYPE_SYSTEMS.map(t => ({
    id: t.id, name: t.name,
    latin: t.latin, bangla: t.bangla,
    available: needsBangla ? !!t.banglaOk : true,
    why: needsBangla && !t.banglaOk
      ? 'this pairing has no Bangla family that has been checked for conjuncts'
      : null
  }));
}

/** The size range a part may move through. The floor is the engine's, per
 *  script, and it is a hard stop rather than a suggestion. */
export function sizeRangeFor(part) {
  const E = engine();
  const floorPt = part.script === 'latin' ? E.SCRIPTS.latin.minPt : E.SCRIPTS.bangla.minPt;
  /* A ceiling exists for a real reason: type larger than about a third of the
     card's height cannot be composed alongside anything else, and the ladder
     would eliminate every layout rather than return a card. */
  return { floorPt, ceilingPt: 36, stepRatio: 1.125 };
}

const STEPS = (() => {
  /* A geometric scale rather than arbitrary point values, so a step reads as
     a step at every size — one point between 6 and 7 is a sixth of the type,
     between 30 and 31 it is invisible. */
  const out = [];
  for (let pt = 5; pt <= 40; pt = +(pt * 1.125).toFixed(3)) out.push(+pt.toFixed(2));
  return out;
})();

function stepFrom(sizePt, direction, range) {
  const cur = sizePt || range.floorPt;
  const idx = STEPS.reduce((best, v, i) => Math.abs(v - cur) < Math.abs(STEPS[best] - cur) ? i : best, 0);
  const next = STEPS[idx + (direction > 0 ? 1 : -1)];
  if (next === undefined) return null;
  if (next < range.floorPt) return null;
  if (next > range.ceilingPt) return null;
  return next;
}

/**
 * Apply one bounded operation to a decomposed card.
 *
 * Returns `{ ok: true, parts }` with a new parts object, or the refusal shape
 * from the contract. Never mutates its input: a customer's undo depends on the
 * previous state still being the previous state.
 */
export function applyPartOp(parts, op) {
  if (!isPartOp(op)) {
    return refuseEdit(`\`${op && op.type}\` is not something this editor can do.`,
      Object.keys(PART_OPS).map(k => k));
  }
  const next = structuredClone(parts);
  const part = next.parts.find(p => p.id === op.partId);
  if (!part) return refuseEdit('That part is not on this card any more.', []);

  const E = engine();

  switch (op.type) {
    case PART_OPS.setColor: {
      const options = coloursFor(next, part);
      const chosen = options.find(o => o.hex.toLowerCase() === String(op.value || '').toLowerCase());
      if (!chosen) return refuseEdit(`${op.value} is not a colour in this library.`,
        options.filter(o => o.available).slice(0, 6).map(o => o.hex));
      if (!chosen.available) return refuseEdit(chosen.why,
        options.filter(o => o.available).slice(0, 6).map(o => o.hex));
      part.style.color = chosen.hex;
      break;
    }

    case PART_OPS.setFamily: {
      const options = familiesFor(part);
      const chosen = options.find(o => o.id === op.value);
      if (!chosen) return refuseEdit(`${op.value} is not a type system in this library.`,
        options.filter(o => o.available).map(o => o.id));
      if (!chosen.available) return refuseEdit(chosen.why,
        options.filter(o => o.available).map(o => o.id));
      part.style.family = part.script === 'latin' ? chosen.latin : chosen.bangla;
      part.typeSystem = chosen.id;
      break;
    }

    case PART_OPS.stepSize: {
      const range = sizeRangeFor(part);
      const dir = Number(op.value) >= 0 ? 1 : -1;
      const to = stepFrom(part.style.sizePt, dir, range);
      if (to === null) {
        return dir < 0
          ? refuseEdit(`${range.floorPt} pt is the smallest size this survives printing — ` +
              (part.script === 'latin'
                ? 'below it, Latin type disappears under office light'
                : 'below it, Bangla conjuncts collapse into each other on 300 gsm art card'),
              ['shorten the text instead', 'move it to the back of the card'])
          : refuseEdit(`${range.ceilingPt} pt is as large as this can go and still leave room for the rest of the card.`,
              ['drop a contact route to free space', 'choose a layout that gives this part more room']);
      }
      part.style.sizePt = to;
      break;
    }

    case PART_OPS.setWeight: {
      const w = Number(op.value);
      /* The vendored OFL families ship 400–800. Asking for 900 silently gets a
         synthesised bold from a viewer and a different weight from the press. */
      const available = [400, 500, 600, 700, 800];
      if (!available.includes(w)) return refuseEdit(
        `Weight ${op.value} is not one this family ships, and a synthesised weight prints differently than it previews.`,
        available.map(String));
      part.style.weight = w;
      break;
    }

    case PART_OPS.setCase: {
      const allowed = ['upper', 'lower', 'title', 'as-is'];
      if (!allowed.includes(op.value)) return refuseEdit(`${op.value} is not a case option.`, allowed);
      /* Bangla has no letter case. Offering it would be a control that does
         nothing, which reads as the app being broken. */
      if (part.script !== 'latin' && op.value !== 'as-is')
        return refuseEdit('Bangla has no upper or lower case, so this cannot change.', ['as-is']);
      part.style.case = op.value;
      break;
    }

    case PART_OPS.setAlign: {
      const allowed = ['left', 'centre', 'right'];
      if (!allowed.includes(op.value)) return refuseEdit(`${op.value} is not an alignment.`, allowed);
      part.style.align = op.value;
      break;
    }

    case PART_OPS.assignSlot: {
      const defs = slotInfo();
      if (op.value !== null && !Object.hasOwn(defs, op.value))
        return refuseEdit(`There is no \`${op.value}\` slot on a card.`, Object.keys(defs));
      part.slot = op.value;
      /* A customer correcting a guess has told us something we did not know,
         so the confidence becomes certainty and the source becomes their
         answer rather than our inference. */
      part.confidence = 1;
      part.source = 'read';
      break;
    }

    case PART_OPS.toggle: {
      const defs = slotInfo();
      const def = part.slot ? defs[part.slot] : null;
      const turningOff = part.dropped !== true;
      if (turningOff && def && def.required) {
        const others = next.parts.filter(p => p.id !== part.id && p.slot === part.slot && p.dropped !== true);
        if (!others.length) return refuseEdit(
          `A card cannot be printed without its ${part.slot}.`,
          ['assign this part to a different slot first', 'edit the text instead of removing it']);
      }
      part.dropped = turningOff;
      break;
    }

    default:
      return refuseEdit(`\`${op.type}\` is not something this editor can do.`, Object.keys(PART_OPS));
  }

  /* Every edit re-derives the whole card, so the finding count on screen is
     always the finding count for what the customer is looking at. */
  const check = previewOf(next);
  if (!check.ok) return refuseEdit(check.reason, check.alternatives || []);
  next.preview = check;
  return { ok: true, parts: next, preview: check };
}

/** Apply a sequence, stopping at the first refusal so a customer is never told
 *  that four of their six changes went through. */
export function applyPartOps(parts, ops) {
  let cur = parts;
  const applied = [];
  for (const op of ops) {
    const r = applyPartOp(cur, op);
    if (!r.ok) return { ok: false, parts: cur, applied, refusal: r };
    cur = r.parts;
    applied.push(op);
  }
  return { ok: true, parts: cur, applied, preview: cur.preview };
}

/**
 * Compose and preflight the current state of a decomposed card.
 *
 * This is the only route from parts to pixels, and it goes through the
 * engine's `compose` — which means the geometry on screen is the composer's,
 * derived from slots and constraints, and not the geometry the uploaded file
 * happened to have.
 */
export function previewOf(parts) {
  const E = engine();
  const live = { ...parts, parts: parts.parts.filter(p => p.dropped !== true) };
  const content = toContent(live, { includeUnsure: true });
  if (!content.name) {
    return { ok: false, reason: 'This card has no name on it yet, so there is nothing to compose around.',
             alternatives: ['assign one of the text parts to the name slot'] };
  }
  const design = toDesign(live);

  /* A part whose family the customer changed picks its type system; otherwise
     the nearest match to the original stands. */
  const withType = live.parts.find(p => p.typeSystem);
  if (withType) design.type = withType.typeSystem;

  /* The per-slot style channel. Without it every one of these operations was
     recorded on the part and never reached the page: the composer re-derived
     everything from the content and the design record, so "make this bolder"
     was accepted, stored, and silently did nothing — which reads as the app
     being broken, and is the defect blueprint finding F8 names.

     Case is applied here rather than to the text, because the composer has to
     do the uppercasing itself: measuring mixed case and rendering capitals
     understates the width by about 12%, which is the collision bug the engine
     suite already guards against. */
  const slotStyle = {};
  for (const p of live.parts) {
    if (!p.slot || p.kind !== 'text') continue;
    const o = {};
    if (p.style.color) o.color = p.style.color;
    if (typeof p.style.weight === 'number') o.weightNum = p.style.weight;
    if (typeof p.style.sizePt === 'number') o.sizePt = p.style.sizePt;
    if (p.style.case === 'upper') o.upper = true;
    else if (p.style.case === 'lower' || p.style.case === 'title') o.upper = false;
    if (p.style.align) o.align = p.style.align === 'centre' ? 'center' : p.style.align;
    if (Object.keys(o).length) slotStyle[p.slot] = o;
  }

  const spec = {
    format: design.format, type: design.type, palette: design.palette,
    density: design.density, layout: design.layout, content, corner: design.corner || 0,
    slotStyle,
    share: { origin: 'https://cardworks.bd', code: null }
  };

  let composed;
  try { composed = E.compose(spec); }
  catch (err) {
    return { ok: false, reason: 'That change leaves a card the composer cannot build.',
             alternatives: ['undo the last change'], detail: String(err && err.message) };
  }
  if (composed.eliminated) {
    return { ok: false, reason: `No layout can hold this card: ${composed.eliminated}`,
             alternatives: ['make the longest text smaller', 'move a contact route to the back',
                            'switch to portrait'] };
  }

  const findings = E.preflight(composed);
  return {
    ok: true, design, content, composed,
    svg: E.renderSVG(composed),
    findings,
    blocking: findings.filter(f => f.s === 'fail').length,
    advisory: findings.filter(f => f.s === 'review').length,
    passed:   findings.filter(f => f.s === 'pass').length
  };
}

/**
 * Prove that nothing on the composing path reads a part's `observed` box.
 *
 * The constraint that keeps this feature inside the product's guarantee is
 * that uploaded geometry is evidence, never an instruction. That is easy to
 * state and easy to violate by accident, so it is checked by poisoning every
 * `observed` value with a number that would be obvious in the output and
 * confirming the composed result is byte-identical.
 */
export function assertGeometryUnused(parts) {
  const clean = previewOf(parts);
  if (!clean.ok) return { ok: false, reason: 'the card does not compose, so the check cannot run' };
  const poisoned = structuredClone(parts);
  for (const p of poisoned.parts) p.observed = { x: -9999, y: -9999, w: 9999, h: 9999 };
  const after = previewOf(poisoned);
  if (!after.ok) return { ok: false, reason: 'poisoning the geometry changed whether the card composes' };
  return {
    ok: clean.svg === after.svg,
    reason: clean.svg === after.svg ? null
      : 'composed output changed when observed geometry changed — geometry is reaching the composer'
  };
}
