/* Take a card apart, judge it, and hand it to the composer.
 *
 * The three readers each know one format. This file picks between them by
 * looking at the bytes rather than trusting the declared content type, scores
 * what came back against the print rules the engine already enforces, and
 * translates the result into the vocabulary the composer speaks — so an
 * uploaded card and a generated one converge on the same `compose()` call and
 * therefore carry the same guarantee.
 *
 * That convergence is the whole design. Nothing downstream of here can tell
 * whether a card was briefed or uploaded, which means an uploaded card cannot
 * take a shortcut around preflight.
 */
import { CONFIDENT } from './contract.mjs';
import { destructureSvg } from './svg.mjs';
import { destructurePdf } from './pdf.mjs';
import { destructureRaster } from './raster.mjs';
import { engine } from '../engine-node.mjs';

const MM_PER_PT = 0.352778;

/** Sniff the format from the bytes. A client-supplied content type is a hint
 *  from someone who may be wrong or hostile; the magic bytes are the file. */
export function sniff(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  const head = b.subarray(0, 2048).toString('utf8');
  if (/<svg[\s>]/i.test(head) || /<\?xml/.test(head) && /<svg/i.test(b.toString('utf8', 0, 65536))) return 'svg';
  return null;
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Decompose an uploaded card. Throws with a named `code` when it cannot be
 * read; never returns an empty success, because an extractor whose failure
 * mode is silence reads as a pass.
 */
export function destructure(bytes, meta = {}) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!b.length) { const e = new Error('That file is empty.'); e.code = 'empty'; throw e; }
  if (b.length > MAX_BYTES) {
    const e = new Error(`That file is ${(b.length / 1048576).toFixed(1)} MB; the limit is 8 MB.`);
    e.code = 'too_large';
    e.remediationText = 'Export it at a smaller size, or upload the vector original.';
    throw e;
  }

  const kind = sniff(b);
  if (!kind) {
    const e = new Error('That file is not an SVG, PDF, PNG or JPEG.');
    e.code = 'unsupported';
    e.remediationText = 'Ask whoever made the card for the original file — an SVG or PDF reads best.';
    throw e;
  }
  if (meta.mime && !meta.mime.includes(kind === 'jpeg' ? 'jpeg' : kind) && !(kind === 'svg' && /svg|xml/.test(meta.mime))) {
    /* Not fatal, but worth recording: a mismatch is usually a renamed file
       rather than an attack, and the reader that ran is the honest answer. */
    meta.mimeMismatch = true;
  }

  const parts = kind === 'svg' ? destructureSvg(b, meta)
              : kind === 'pdf' ? destructurePdf(b, meta)
              : destructureRaster(b, meta);

  if (meta.mimeMismatch) parts.findings.push({ s: 'review',
    label: `The file said it was ${meta.mime} but its contents are ${kind}`,
    note: `read as ${kind}, which is what the bytes actually are` });

  matchFormat(parts);
  assess(parts);
  return parts;
}

/* ── Format ───────────────────────────────────────────────────────────────
   Snapping to a library format is what lets the composer take over. A card
   that arrives at 88.9 × 50.8 is an inch card, not an error, and saying so
   beats silently resizing someone's artwork. */
export function matchFormat(parts) {
  const E = engine();
  let best = null, bestErr = Infinity;
  for (const f of E.FORMATS) {
    for (const [w, h] of [[f.w, f.h], [f.h, f.w]]) {
      const err = Math.abs(parts.format.wMm - w) + Math.abs(parts.format.hMm - h);
      if (err < bestErr) { bestErr = err; best = f; }
    }
  }
  /* Two millimetres of slack: the difference between 89 × 51 and the 3.5 × 2
     inch card is 0.1 mm on one edge, and both should land on the same record.
     Beyond that the card is genuinely a different size and pretending
     otherwise would crop someone's design. */
  if (best && bestErr <= 2) {
    parts.format.matchedFormatId = best.id;
    if (bestErr > 0.4) parts.findings.push({ s: 'review',
      label: `Trim read as ${parts.format.wMm} × ${parts.format.hMm} mm, closest to ${best.name}`,
      note: `treated as ${best.id} — a ${bestErr.toFixed(1)} mm difference, within press tolerance` });
  } else {
    parts.findings.push({ s: 'fail',
      label: `${parts.format.wMm} × ${parts.format.hMm} mm is not a size this library prints`,
      note: 'the nearest standard is 89 × 51 mm; the design would need re-composing to fit it' });
  }
  return parts;
}

/* ── The print audit ──────────────────────────────────────────────────────
   These are the defects that actually appear on shop-made cards in this
   market, checked against the same constants the engine enforces so an
   uploaded card is judged by exactly the standard a generated one meets. */
export function assess(parts) {
  const E = engine();
  const fmt = E.FORMATS.find(f => f.id === parts.format.matchedFormatId);
  const safe = fmt ? fmt.safe : 4;
  const texts = parts.parts.filter(p => p.kind === 'text');

  if (texts.length) {
    const floors = { latin: E.SCRIPTS.latin.minPt, bangla: E.SCRIPTS.bangla.minPt };
    const under = texts.filter(p => p.style.sizePt && p.style.sizePt <
      (p.script === 'latin' ? floors.latin : floors.bangla));
    if (under.length) {
      const worst = Math.min(...under.map(p => p.style.sizePt));
      parts.findings.push({ s: 'fail',
        label: `${under.length} text ${under.length > 1 ? 'runs are' : 'run is'} below the print floor — smallest is ${worst} pt`,
        note: `${floors.latin} pt is the Latin floor and ${floors.bangla} pt the Bangla floor on 300 gsm; below that it disappears under office light` });
    } else {
      parts.findings.push({ s: 'pass', label: 'All type is at or above the print floor', note: '' });
    }

    /* Hierarchy. The engine requires the name to outrank the role by 1.6×;
       a card where everything is the same size reads as a list, not a card. */
    const name = texts.find(p => p.slot === 'name');
    const role = texts.find(p => p.slot === 'role');
    if (name?.style.sizePt && role?.style.sizePt) {
      const ratio = name.style.sizePt / role.style.sizePt;
      parts.findings.push(ratio >= 1.6
        ? { s: 'pass', label: `Hierarchy is clear — the name is ${ratio.toFixed(1)}× the role`, note: '' }
        : { s: 'review', label: `The name is only ${ratio.toFixed(1)}× the role`, note: 'under 1.6× the two lines compete and neither reads first' });
    }

    const bangla = texts.filter(p => p.script !== 'latin');
    if (bangla.length) {
      const families = [...new Set(bangla.map(p => p.style.family).filter(Boolean))];
      const known = E.TYPE_SYSTEMS.filter(t => t.banglaOk).map(t => t.bangla).join(' ');
      const unknown = families.filter(f => !known.includes(f));
      if (unknown.length) parts.findings.push({ s: 'review',
        label: `Bangla is set in ${unknown.join(', ')}, which is not in this library`,
        note: 'conjuncts and matras may not hold at small sizes; it will be re-set in a family that has been checked' });
    }
  }

  /* Safe area, measured on what was read rather than on what we would have
     composed. A card printed to the trim loses 1–2 mm to the guillotine, and
     this is the single most common defect on a shop-made card. */
  const positioned = parts.parts.filter(p => p.observed.w > 0 && p.observed.h > 0);
  if (positioned.length && fmt) {
    const tight = positioned.filter(p =>
      p.observed.x < safe - 0.2 || p.observed.y < safe - 0.2 ||
      p.observed.x + p.observed.w > parts.format.wMm - safe + 0.2 ||
      p.observed.y + p.observed.h > parts.format.hMm - safe + 0.2);
    /* A full-bleed ground is meant to run off the edge; it is not a defect. */
    const real = tight.filter(p => !(p.kind === 'panel' && p.observed.w >= parts.format.wMm * 0.98));
    parts.findings.push(real.length
      ? { s: 'fail', label: `${real.length} element${real.length > 1 ? 's sit' : ' sits'} inside the ${safe} mm safe area`,
          note: 'the guillotine drifts up to 1.5 mm; anything this close can be cut off' }
      : { s: 'pass', label: `Everything clears the ${safe} mm safe area`, note: '' });
  }

  if (parts.palette.length >= 2) {
    /* Contrast between the two colours carrying the most area is a fair proxy
       for whether the card is readable, and uses the engine's own function so
       the threshold is the one preflight will apply later. */
    const [a, b] = parts.palette;
    const ratio = E.contrast(a.hex, b.hex);
    parts.findings.push(ratio >= 4.5
      ? { s: 'pass', label: `Text contrast ${ratio.toFixed(1)}:1 against the ground`, note: '' }
      : { s: ratio >= 3 ? 'review' : 'fail', label: `Text contrast is only ${ratio.toFixed(1)}:1`,
          note: 'under 4.5:1 it fails at card size in ordinary light' });
  }

  const lowConfidence = parts.parts.filter(p => p.confidence < CONFIDENT).length;
  if (lowConfidence) parts.findings.push({ s: 'review',
    label: `${lowConfidence} part${lowConfidence > 1 ? 's could' : ' could'} not be identified with confidence`,
    note: 'confirm what each one is before composing — a wrong guess changes how it is treated' });

  const fails = parts.findings.filter(f => f.s === 'fail').length;
  const reviews = parts.findings.filter(f => f.s === 'review').length;
  const passes = parts.findings.filter(f => f.s === 'pass').length;
  const score = Math.max(0, Math.min(100, Math.round(100 * passes / Math.max(1, passes + reviews + fails * 2))));
  parts.quality = { score, band: fails ? 'poor' : reviews > 1 ? 'fair' : 'good' };
  return parts;
}

/* ── Into the engine's vocabulary ─────────────────────────────────────────
   The composer takes a content record, not a part list. Only parts we are
   confident about contribute; a low-confidence guess is left out rather than
   quietly filed under the wrong field, because a name that arrives in the
   role slot is worse than a name that arrives nowhere and gets asked about. */
export function toContent(parts, { includeUnsure = false } = {}) {
  const pick = (slot) => parts.parts.filter(p =>
    p.kind === 'text' && p.slot === slot && (includeUnsure || p.confidence >= CONFIDENT));

  const first = (slot) => (pick(slot)[0] || {}).text || '';
  const contacts = pick('contact').map(p => p.text);

  /* Contact runs arrive as whole lines — "01711-123456 · 01911-654321 ·
     a@b.bd" — so they are split on the separators a card actually uses and
     each fragment routed by what it looks like. */
  const flat = contacts.flatMap(t => t.split(/\s*[·|•,]\s*|\s{3,}/)).map(s => s.trim()).filter(Boolean);
  /* A Bangladeshi mobile is eleven digits beginning 01[3-9], and it is written
     with a hyphen or a space as often as not — 01711-123456, 01711 123456,
     +8801711123456. Matching the punctuation is a losing game, so the digits
     are extracted and counted instead. A pattern that assumed one grouping
     silently filed every hyphenated number under the address. */
  const digitsOf = (t) => t.replace(/[^\d]/g, '');
  const isBdMobile = (t) => /^(?:88)?01[3-9]\d{8}$/.test(digitsOf(t));
  const phones = flat.filter(isBdMobile);
  const emails = flat.filter(t => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t));
  const webs   = flat.filter(t => /(?:https?:\/\/|www\.|fb\.com|facebook\.com)/i.test(t));
  const rest   = flat.filter(t => !phones.includes(t) && !emails.includes(t) && !webs.includes(t));

  const bn = (slot) => (parts.parts.find(p => p.kind === 'text' && p.slot === slot && p.script === 'bangla') || {}).text || '';

  return {
    logo: null,
    name: first('name'), role: first('role'), company: first('company'), quals: '',
    bname: bn('name'), brole: bn('role'), bcompany: bn('company'),
    p1: phones[0] || '', p2: phones[1] || '',
    email: emails[0] || '', web: webs[0] || '',
    addr: rest.join(', ')
  };
}

/** The library palette closest to what the card actually used, by the sum of
 *  perceptual distance across the roles that carry the most area. */
export function nearestPalette(parts) {
  const E = engine();
  if (!parts.palette.length) return E.PALETTES[0].id;
  const rgb = (hex) => { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const dist = (a, b) => { const [x, y, z] = rgb(a), [p, q, r] = rgb(b);
    return Math.hypot(x - p, y - q, z - r); };

  const ground = parts.palette[0].hex;
  const ink = (parts.palette[1] || parts.palette[0]).hex;
  let best = E.PALETTES[0], bestErr = Infinity;
  for (const pal of E.PALETTES) {
    const err = dist(pal.bg, ground) + dist(pal.fg, ink);
    if (err < bestErr) { bestErr = err; best = pal; }
  }
  return best.id;
}

/** The library type system closest to the families the card used. Falls back
 *  to the workhorse rather than to whichever record happens to be first. */
export function nearestType(parts) {
  const E = engine();
  const families = parts.fonts.map(f => (f.family || '').toLowerCase().replace(/[^a-z]/g, ''));
  if (families.length) {
    for (const t of E.TYPE_SYSTEMS) {
      const latin = (t.latin || '').toLowerCase().replace(/[^a-z,]/g, '');
      if (families.some(f => f && latin.includes(f))) return t.id;
    }
    /* A serif card should not be re-set in a grotesque just because no exact
       match exists — that changes the card's character, not just its font. */
    const serif = families.some(f => /times|georgia|garamond|playfair|minion|serif|book/.test(f));
    const hit = E.TYPE_SYSTEMS.find(t => serif === /playfair|serif|tiro/i.test(t.latin + t.bangla));
    if (hit) return hit.id;
  }
  return (E.TYPE_SYSTEMS.find(t => t.id === 'typ.siliguri') || E.TYPE_SYSTEMS[0]).id;
}

/** A design record the composer accepts, derived from an uploaded card. */
export function toDesign(parts, over = {}) {
  const E = engine();
  const fmtId = parts.format.matchedFormatId || 'bd-std';
  const texts = parts.parts.filter(p => p.kind === 'text');
  const hasBangla = texts.some(p => p.script !== 'latin');
  const fmt = E.FORMATS.find(f => f.id === fmtId);
  const front = E.LAYOUTS.filter(l => l.face === 'front' &&
    (!fmt || fmt.orientation === 'landscape' || (l.orientations || {})[fmt.orientation]));
  return {
    format: fmtId,
    palette: nearestPalette(parts),
    type: nearestType(parts),
    density: 'balanced',
    layout: (front[0] || E.LAYOUTS[0]).id,
    back: hasBangla ? 'back.bangla' : 'back.contact',
    script: hasBangla && !texts.some(p => p.script === 'latin') ? 'bangla' : 'latin',
    finishes: [],
    corner: 0,
    ...over
  };
}
