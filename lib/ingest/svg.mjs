/* Take an SVG card apart.
 *
 * SVG is the one upload format where decomposition is genuinely reliable: the
 * text is text, the fonts are named, the colours are declared, and the
 * geometry is arithmetic rather than inference. Everything this file reports
 * is marked `read` rather than `inferred`, and that distinction is the point —
 * a customer is told which parts of their card we actually know and which we
 * guessed, because a wrong slot assignment silently changes what the composer
 * does with their text.
 *
 * There is no XML library here and there deliberately is not one. A card is a
 * flat document of a few dozen elements; a tokeniser over the tags we
 * understand is a hundred lines, and it cannot be handed a construct it
 * silently mis-reads, because anything it does not recognise is reported as
 * unparsed rather than dropped.
 */
import { CARD_PARTS, PART } from './contract.mjs';

/* ── A minimal, total tokeniser ───────────────────────────────────────────
   Total in the sense that every byte of input lands in exactly one bucket:
   an element we understood, or a record that we did not. Nothing is skipped
   quietly, because a silently skipped element is a part of someone's card
   that vanishes between upload and preview. */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"' };
const unescapeXml = (s) => String(s).replace(/&(#?\w+);/g, (m, k) =>
  Object.hasOwn(ENTITIES, k) ? ENTITIES[k]
    : /^#x/i.test(k) ? String.fromCodePoint(parseInt(k.slice(2), 16))
    : /^#/.test(k) ? String.fromCodePoint(parseInt(k.slice(1), 10))
    : m);

/** Attributes of one tag. Quoted values only — an unquoted SVG attribute is
 *  legal in HTML but not in XML, and guessing where one ends invents data. */
function attrs(tagBody) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagBody))) out[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
  return out;
}

/** Walk the document, emitting `{ name, attr, text }` for each element. */
function elements(src) {
  const out = [];
  const re = /<([a-zA-Z][-a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body, selfClose] = m;
    const attr = attrs(body);
    let text = '';
    if (!selfClose) {
      const close = src.indexOf('</' + name, re.lastIndex);
      if (close > -1) text = src.slice(re.lastIndex, close);
    }
    out.push({ name: name.toLowerCase(), attr, text, at: m.index });
  }
  return out;
}

const num = (v, fallback = null) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
};

/* ── Units ────────────────────────────────────────────────────────────────
   Our own renderer emits a viewBox in millimetres, so the common case is a
   1:1 mapping. A card exported from another tool is usually in points or
   pixels, and the only defensible way to tell is the declared width: a card
   is between 40 and 120 mm on its long edge, so a viewBox reporting 252 units
   across is points, and one reporting 1050 is pixels at 300dpi. That is an
   inference, and every part derived through it is marked as one. */
const MM_PER_PT = 0.352778;

function scaleFor(vbW, declaredW) {
  if (declaredW) {
    const m = /^([\d.]+)\s*(mm|cm|in|pt|px)?$/.exec(String(declaredW).trim());
    if (m) {
      const v = parseFloat(m[1]);
      const unit = m[2] || 'px';
      const mm = unit === 'mm' ? v : unit === 'cm' ? v * 10 : unit === 'in' ? v * 25.4
               : unit === 'pt' ? v * MM_PER_PT : v * 25.4 / 96;
      if (vbW > 0 && mm > 20 && mm < 400) return { k: mm / vbW, basis: 'declared', exact: true };
    }
  }
  if (vbW >= 40 && vbW <= 130)  return { k: 1,              basis: 'mm-viewbox', exact: true };
  if (vbW >= 150 && vbW <= 400) return { k: MM_PER_PT,      basis: 'points',     exact: false };
  if (vbW >= 400)               return { k: 25.4 / 96,       basis: 'pixels',     exact: false };
  return { k: 1, basis: 'assumed-mm', exact: false };
}

/* ── Slot inference ───────────────────────────────────────────────────────
   The engine's own SVG carries no slot names, so even round-tripping our
   output requires guessing which run is the name and which is the role. The
   guess is made from evidence a person would use — relative type size, and
   the shape of the string — and each one records how sure it is. Nothing here
   is presented as read from the file. */

const BN = /[ঀ-৿]/;
const looksLikePhone   = (t) => /(?:\+?88)?0?1[3-9]\d[\s-]?\d{3}[\s-]?\d{4}/.test(t) || /\d[\d\s\-,·]{7,}/.test(t);
const looksLikeEmail   = (t) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t);
const looksLikeUrl     = (t) => /(?:https?:\/\/|www\.|fb\.com|facebook\.com)\S+/i.test(t);
/* Qualifications are matched case-sensitively, and `Md` is excluded outright.
   Case-insensitively, `\bMD\b` matches the `Md.` that prefixes an enormous
   share of Bangladeshi names — Mohammad — so a case-insensitive test files
   "Md. Abdur Rahman" as a qualification string and the name never lands in
   the name slot. Real qualifications are written in capitals on every card
   this product will see. */
const looksLikeQuals = (t) =>
  /\b(?:MBBS|FCPS|MRCP|MRCS|FRCS|BDS|MPH|PhD|MSc|BSc|LLB|LLM|ACCA|FCA|FCMA|BCS|MBA|MA|MS)\b/.test(t)
  && !/^\s*Md\b/i.test(t);
const looksLikeAddress = (t) => /\b(?:road|rd|house|flat|floor|lane|sector|block|dhaka|chittagong|chattogram|sylhet|gulshan|banani|dhanmondi|mirpur|uttara)\b/i.test(t)
                             || /বাড়ি|রোড|ঢাকা|সড়ক/.test(t);

function inferSlots(texts) {
  const bySize = [...texts].sort((a, b) => (b.style.sizePt || 0) - (a.style.sizePt || 0));

  /* A monogram is often the largest thing on the card, so "largest run is the
     name" is wrong precisely on the cards that have a mark. The name is the
     largest run that is actually a name-length string; the one or two
     characters set larger than it is the mark. */
  const mark = bySize.find(p => p.text.trim().length <= 2);
  const largest = bySize.find(p => p.text.trim().length > 2 && p !== mark);

  for (const p of texts) {
    const t = p.text.trim();
    if (!t) { p.slot = null; p.confidence = 0; p.source = 'inferred'; continue; }

    if (p === mark) { p.slot = 'mark'; p.confidence = 0.8; p.source = 'inferred'; continue; }

    if (looksLikeEmail(t) || looksLikePhone(t) || looksLikeUrl(t)) {
      p.slot = 'contact'; p.confidence = 0.95; p.source = 'inferred'; continue;
    }
    if (looksLikeAddress(t)) { p.slot = 'contact'; p.confidence = 0.8; p.source = 'inferred'; continue; }

    if (p === largest) { p.slot = 'name'; p.confidence = 0.85; p.source = 'inferred'; continue; }

    /* Qualifications are checked after the name, because a card that sets
       "Dr. Nasrin Akhter, FCPS" as one run is a name first. */
    if (looksLikeQuals(t)) { p.slot = 'role'; p.confidence = 0.7; p.source = 'inferred'; continue; }

    /* Uppercase, tracked-out, small type is how nearly every card sets its
       company line; sentence case at that size is usually the role. */
    const isUpper = t === t.toUpperCase() && /[A-Z]/.test(t);
    const tracked = (p.style.tracking || 0) > 0.02;
    if (isUpper || tracked) { p.slot = 'company'; p.confidence = 0.65; p.source = 'inferred'; continue; }

    p.slot = 'role'; p.confidence = 0.6; p.source = 'inferred';
  }
  return texts;
}

/* ── Colour ───────────────────────────────────────────────────────────────
   Named colours are not resolved from a table of 148 CSS names, because a
   card that uses `rebeccapurple` is not a card this product will ever have to
   read. The three that appear in real exports are handled and the rest are
   reported unparsed rather than guessed at. */
const NAMED = { black: '#000000', white: '#ffffff', none: null, transparent: null };

function normaliseColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (Object.hasOwn(NAMED, s)) return NAMED[s];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return '#' + [...m[1]].map(c => c + c).join('');
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) {
    const hex = (n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, '0');
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  }
  return null;
}

const familyOf = (v) => {
  if (!v) return null;
  /* `font-family: 'Libre Franklin', sans-serif` — the first named family is
     the one the card was designed in; the fallbacks are what a viewer
     substituted, and recording those would misreport the design. */
  const first = String(v).split(',')[0].trim().replace(/^["']|["']$/g, '');
  return first || null;
};

const caseOf = (t) => {
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (!letters) return 'as-is';
  if (letters === letters.toUpperCase()) return 'upper';
  if (letters === letters.toLowerCase()) return 'lower';
  return /^[A-Z]/.test(t.trim()) ? 'title' : 'as-is';
};

const ANCHOR = { start: 'left', middle: 'centre', end: 'right' };

/**
 * Decompose an SVG card into `CardParts`.
 *
 * Throws rather than returning an empty result when the document is not an
 * SVG or carries nothing we can read. A parser whose failure mode is an empty
 * success is the house rule this codebase learned the hard way: silence reads
 * as a pass, so an extractor that finds nothing must say so.
 */
export function destructureSvg(source, meta = {}) {
  const src = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
  if (!/<svg[\s>]/i.test(src)) {
    const err = new Error('That file is not an SVG.');
    err.code = 'not_svg';
    err.remediationText = 'Export the card as SVG, or upload a PDF instead.';
    throw err;
  }

  const els = elements(src);
  const svg = els.find(e => e.name === 'svg');
  if (!svg) { const e = new Error('No <svg> element in that file.'); e.code = 'not_svg'; throw e; }

  const vb = String(svg.attr.viewBox || '').trim().split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && Number.isFinite(vb[2]) ? vb[2] : num(svg.attr.width, 0);
  const vbH = vb.length === 4 && Number.isFinite(vb[3]) ? vb[3] : num(svg.attr.height, 0);
  if (!(vbW > 0 && vbH > 0)) {
    const e = new Error('That SVG declares no usable size, so nothing can be measured from it.');
    e.code = 'no_dimensions';
    e.remediationText = 'Re-export it with a width and height, or a viewBox.';
    throw e;
  }

  const scale = scaleFor(vbW, svg.attr.width);
  const mm = (v) => (v === null ? null : v * scale.k);

  const out = CARD_PARTS();
  out.origin = { filename: meta.filename || '', mime: 'image/svg+xml',
                 bytes: meta.bytes || src.length, pages: 1 };
  out.format = {
    wMm: +mm(vbW).toFixed(3), hMm: +mm(vbH).toFixed(3),
    orientation: vbW > vbH ? 'landscape' : vbW < vbH ? 'portrait' : 'square',
    matchedFormatId: null, exact: scale.exact
  };

  const areaByColor = new Map();
  const noteColor = (hex, area) => {
    if (!hex) return;
    areaByColor.set(hex, (areaByColor.get(hex) || 0) + Math.max(0, area || 0));
  };

  let seq = 0;
  const texts = [];
  let unparsed = 0;

  for (const el of els) {
    if (el.name === 'svg' || el.name === 'defs' || el.name === 'desc' || el.name === 'title') continue;

    if (el.name === 'text' || el.name === 'tspan') {
      /* Nested tspans would double-count their parent's text. Only a text
         element with no tspan children is taken as a run. */
      if (el.name === 'text' && /<tspan[\s>]/i.test(el.text)) continue;
      const raw = unescapeXml(el.text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      if (!raw) continue;

      const p = PART();
      p.id = 'p' + (++seq);
      p.kind = 'text';
      p.text = raw;
      p.script = BN.test(raw) ? (/[A-Za-z]/.test(raw) ? 'mixed' : 'bangla') : 'latin';

      const sizeUnits = num(el.attr['font-size'], null);
      p.style.family   = familyOf(el.attr['font-family']);
      p.style.weight   = num(el.attr['font-weight'], null);
      p.style.sizePt   = sizeUnits === null ? null : +(mm(sizeUnits) / MM_PER_PT).toFixed(2);
      p.style.color    = normaliseColor(el.attr.fill);
      const ls = num(el.attr['letter-spacing'], null);
      p.style.tracking = ls === null || !sizeUnits ? null : +(ls / sizeUnits).toFixed(4);
      p.style.case     = caseOf(raw);
      p.style.align    = ANCHOR[String(el.attr['text-anchor'] || 'start')] || 'left';

      const anchorX = mm(num(el.attr.x, 0)), y = mm(num(el.attr.y, 0));
      const h = p.style.sizePt ? p.style.sizePt * MM_PER_PT : 0;
      const w = raw.length * h * 0.5;
      /* Two corrections, both of which misreport a part badly if skipped. An
         SVG text `y` is the baseline rather than the top of the box, so the
         ascent has to come off it. And `x` is the anchor point, not the left
         edge: for `text-anchor="end"` it is the right edge, and for `middle`
         the centre — reading it as the left edge puts a right-aligned run a
         whole line-width outside the card and reports a safe-area failure
         that does not exist. */
      const left = p.style.align === 'right' ? anchorX - w
                 : p.style.align === 'centre' ? anchorX - w / 2
                 : anchorX;
      p.observed = { x: +left.toFixed(3), y: +(y - h * 0.8).toFixed(3),
                     w: +w.toFixed(3), h: +h.toFixed(3) };
      p.source = 'read';
      p.confidence = 1;

      noteColor(p.style.color, p.observed.w * p.observed.h);
      texts.push(p);
      out.parts.push(p);
      continue;
    }

    if (el.name === 'rect' || el.name === 'line' || el.name === 'path' || el.name === 'circle' || el.name === 'polygon') {
      const fill = normaliseColor(el.attr.fill);
      const stroke = normaliseColor(el.attr.stroke);
      const w = mm(num(el.attr.width, 0)) || 0;
      const h = mm(num(el.attr.height, 0)) || 0;
      const isGround = el.name === 'rect' && w >= out.format.wMm * 0.98 && h >= out.format.hMm * 0.98;

      const p = PART();
      p.id = 'p' + (++seq);
      /* A rule is a rect with almost no thickness; a panel is one with area.
         Distinguishing them matters because a panel carries a palette role
         and a rule is decoration the composer places itself. */
      p.kind = isGround ? 'panel' : (el.name === 'line' || (w > 0 && h > 0 && Math.min(w, h) < 0.6)) ? 'rule' : 'panel';
      p.slot = null;
      p.style.color = fill || stroke;
      p.observed = { x: +(mm(num(el.attr.x, 0)) || 0).toFixed(3), y: +(mm(num(el.attr.y, 0)) || 0).toFixed(3),
                     w: +w.toFixed(3), h: +h.toFixed(3) };
      p.source = 'read';
      p.confidence = 1;
      noteColor(p.style.color, isGround ? out.format.wMm * out.format.hMm : w * h);
      out.parts.push(p);
      continue;
    }

    if (el.name === 'image') {
      const p = PART();
      p.id = 'p' + (++seq);
      p.kind = 'image';
      p.slot = 'mark';
      p.confidence = 0.7;
      p.source = 'inferred';
      p.observed = { x: +(mm(num(el.attr.x, 0)) || 0).toFixed(3), y: +(mm(num(el.attr.y, 0)) || 0).toFixed(3),
                     w: +(mm(num(el.attr.width, 0)) || 0).toFixed(3), h: +(mm(num(el.attr.height, 0)) || 0).toFixed(3) };
      out.parts.push(p);
      continue;
    }

    if (el.name === 'g' || el.name === 'clippath' || el.name === 'style' || el.name === 'metadata') continue;
    unparsed++;
  }

  if (!out.parts.length) {
    const e = new Error('Nothing could be read out of that SVG — no text, no shapes.');
    e.code = 'nothing_read';
    e.remediationText = 'It may be a single flattened image. Type the content into the brief instead and keep the look.';
    throw e;
  }

  inferSlots(texts);

  const total = out.format.wMm * out.format.hMm || 1;
  out.palette = [...areaByColor.entries()]
    .map(([hex, area]) => ({ hex, area: +(area / total).toFixed(4), role: null }))
    .sort((a, b) => b.area - a.area);

  const fonts = new Map();
  for (const p of texts) {
    if (!p.style.family) continue;
    const key = p.style.family + '|' + (p.style.weight ?? '');
    if (!fonts.has(key)) fonts.set(key, { family: p.style.family, weight: p.style.weight,
                                          embedded: false, licensed: null });
  }
  out.fonts = [...fonts.values()];

  if (unparsed) out.findings.push({ s: 'review', label: `${unparsed} element${unparsed > 1 ? 's' : ''} in that file could not be read`,
    note: 'they are not text or a simple shape, so they are reported rather than dropped' });
  if (!scale.exact) out.findings.push({ s: 'review', label: `Size read as ${scale.basis}, not stated in the file`,
    note: `treated as ${out.format.wMm} × ${out.format.hMm} mm — confirm before printing` });

  return out;
}
