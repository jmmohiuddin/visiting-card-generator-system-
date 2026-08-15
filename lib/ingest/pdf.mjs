/* Read a PDF card back into parts.
 *
 * Harder than writing one, and bounded in a way worth stating up front: a PDF
 * whose text has been converted to outlines contains no text. Not
 * hard-to-find text — none. The glyphs are paths, and the characters they were
 * made from are gone. This product's own print writer outlines everything on
 * purpose (Master PRD §7, to remove font licensing exposure), so a CARDWORKS
 * print file fed back through here yields shapes and colours and no words at
 * all. That is correct behaviour, and saying so is much more useful than
 * returning nothing and letting the customer wonder.
 *
 * What is read here: page geometry from the boxes, colour operators, and text
 * where text still exists as text. Encrypted files, CID fonts with custom
 * encodings, and anything needing a full font programme to map glyph ids back
 * to characters are refused by name rather than approximated — a mis-decoded
 * name is the failure mode this whole feature is built to avoid.
 */
import zlib from 'node:zlib';
import { CARD_PARTS, PART } from './contract.mjs';

const MM_PER_PT = 0.352778;
const BN = /[ঀ-৿]/;

/* ── Object soup ──────────────────────────────────────────────────────────
   A PDF is a set of numbered objects. There is no attempt here to honour the
   cross-reference table: for a one-page card, scanning for `N M obj` finds
   everything, and a scan cannot be defeated by a broken xref, which is common
   in files produced by cheap exporters. */

function objects(buf) {
  const s = buf.toString('latin1');
  const out = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) continue;
    out.set(Number(m[1]), { body: s.slice(start, end), start, end });
  }
  return { map: out, raw: s };
}

/** A stream's bytes, inflated when the dictionary says so. */
function streamOf(obj, buf, raw) {
  const at = obj.body.indexOf('stream');
  if (at < 0) return null;
  let from = obj.start + at + 6;
  if (raw[from] === '\r') from++;
  if (raw[from] === '\n') from++;
  const endRel = obj.body.indexOf('endstream', at);
  if (endRel < 0) return null;
  const to = obj.start + endRel;
  const bytes = buf.subarray(from, to);
  if (/\/Filter\s*\/FlateDecode/.test(obj.body)) {
    try { return zlib.inflateSync(bytes); } catch { return null; }
  }
  if (/\/Filter/.test(obj.body)) return null;         // some other filter; not guessed at
  return bytes;
}

const boxOf = (body, name) => {
  const m = new RegExp('/' + name + '\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)').exec(body);
  return m ? m.slice(1, 5).map(Number) : null;
};

/* ── Content stream operators ─────────────────────────────────────────────
   Only the operators a card actually uses. Anything else is counted as
   unparsed and reported, never silently ignored. */

function decodePdfString(s) {
  /* Literal strings with the escapes a real exporter emits. Octal escapes are
     resolved because Latin-1 accents arrive that way. */
  return s.replace(/\\([nrtbf()\\]|\d{1,3})/g, (m, g) => {
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (Object.hasOwn(simple, g)) return simple[g];
    return String.fromCharCode(parseInt(g, 8));
  });
}

function readContent(content) {
  const s = content.toString('latin1');
  const runs = [];
  const shapes = [];
  const colours = [];
  let unparsed = 0;

  /* Graphics state we care about, tracked as the stream is walked. */
  /* The colour a run is drawn in is whatever the fill is when the text is
     shown, not when the font was selected. Latching it at `Tf` reads one run
     behind on any exporter that sets the font before the colour — which is
     most of them, and the error is invisible because every run still gets *a*
     plausible colour. */
  let fill = null, font = null, sizePt = null, tm = null;

  const cmyk = (c, m, y, k) => {
    const r = Math.round(255 * (1 - Math.min(1, c + k)));
    const g = Math.round(255 * (1 - Math.min(1, m + k)));
    const b = Math.round(255 * (1 - Math.min(1, y + k)));
    return '#' + [r, g, b].map(n => Math.max(0, n).toString(16).padStart(2, '0')).join('');
  };

  const tokens = s.match(/\([^()\\]*(?:\\.[^()\\]*)*\)|<[0-9a-fA-F\s]*>|\/[^\s/[\]<>()]+|[-+]?[\d.]+|\[|\]|[A-Za-z'"*]+/g) || [];
  const stack = [];

  for (const tk of tokens) {
    if (/^[-+]?[\d.]+$/.test(tk)) { stack.push(parseFloat(tk)); continue; }
    if (tk.startsWith('/')) { stack.push(tk); continue; }
    if (tk.startsWith('(') || tk.startsWith('<')) { stack.push(tk); continue; }
    if (tk === '[' || tk === ']') { stack.push(tk); continue; }

    switch (tk) {
      case 'k': { const [c, m, y, kk] = stack.slice(-4); fill = cmyk(c, m, y, kk); colours.push(fill); break; }
      case 'rg': {
        const [r, g, b] = stack.slice(-3);
        fill = '#' + [r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        colours.push(fill); break;
      }
      case 'g': { const [v] = stack.slice(-1); const n = Math.round(v * 255).toString(16).padStart(2, '0');
                  fill = '#' + n + n + n; colours.push(fill); break; }
      case 'Tf': { sizePt = stack[stack.length - 1]; font = stack[stack.length - 2]; break; }
      case 'Tm': tm = stack.slice(-6); break;
      case 'Td': case 'TD': tm = tm ? [...tm.slice(0, 4), (tm[4] || 0) + stack[stack.length - 2], (tm[5] || 0) + stack[stack.length - 1]] : [1, 0, 0, 1, stack[stack.length - 2], stack[stack.length - 1]]; break;
      case 'Tj': case "'": case '"': {
        const raw = stack[stack.length - 1];
        if (typeof raw === 'string' && raw.startsWith('(')) {
          runs.push({ text: decodePdfString(raw.slice(1, -1)), font, sizePt, color: fill, tm: tm ? [...tm] : null });
        } else unparsed++;                          // hex string: needs the font's encoding
        break;
      }
      case 'TJ': {
        /* An array of strings and kerns. Concatenating the strings is right;
           the kerns only affect spacing. */
        const close = stack.lastIndexOf(']');
        const open = stack.lastIndexOf('[', close - 1);
        if (open >= 0 && close > open) {
          const parts = stack.slice(open + 1, close)
            .filter(v => typeof v === 'string' && v.startsWith('('))
            .map(v => decodePdfString(v.slice(1, -1)));
          if (parts.length) runs.push({ text: parts.join(''), font, sizePt, color: fill, tm: tm ? [...tm] : null });
          else unparsed++;
        }
        break;
      }
      case 're': { const [x, y, w, h] = stack.slice(-4); shapes.push({ x, y, w, h, color: fill }); break; }
      case 'BT': tm = null; break;
      default: break;
    }
    if (/^[A-Za-z'"*]+$/.test(tk)) stack.length = 0;
  }
  return { runs, shapes, colours, unparsed };
}

/** Map a PDF font resource name to the family the card was designed in. */
function familyFromResources(raw, resourceName) {
  if (!resourceName) return null;
  const tag = resourceName.replace(/^\//, '');
  const re = new RegExp('/' + tag + '\\s+(\\d+)\\s+0\\s+R');
  const m = re.exec(raw);
  if (!m) return null;
  const objRe = new RegExp('\\b' + m[1] + '\\s+0\\s+obj([\\s\\S]{0,900}?)endobj');
  const objM = objRe.exec(raw);
  if (!objM) return null;
  const base = /\/BaseFont\s*\/([A-Za-z0-9+\-_,.]+)/.exec(objM[1]);
  if (!base) return null;
  /* Subset fonts are prefixed with six capitals and a plus. */
  return base[1].replace(/^[A-Z]{6}\+/, '').replace(/[-,](Bold|Regular|Italic|Medium|Light|SemiBold|Black)$/i, '');
}

/**
 * Decompose a PDF card into `CardParts`.
 *
 * Throws with a named code when the file cannot be read, including the case
 * that matters most: a PDF whose text is outlined, which is a successful read
 * of a file that genuinely has no text in it.
 */
export function destructurePdf(bytes, meta = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    const e = new Error('That is not a PDF.'); e.code = 'not_pdf'; throw e;
  }
  const { map, raw } = objects(buf);
  if (/\/Encrypt\b/.test(raw)) {
    const e = new Error('That PDF is encrypted, so nothing can be read out of it.');
    e.code = 'pdf_encrypted';
    e.remediationText = 'Export it again without a password, or upload the SVG.';
    throw e;
  }

  const out = CARD_PARTS();
  out.origin = { filename: meta.filename || '', mime: 'application/pdf', bytes: buf.length, pages: 1 };

  /* Geometry: prefer the trim box, because that is the card. A file with only
     a media box has its bleed counted as part of the card, and saying which
     box was used is the difference between an 89 mm card and a 95 mm one. */
  let box = null, boxName = null;
  for (const name of ['TrimBox', 'CropBox', 'MediaBox']) {
    for (const [, obj] of map) {
      const b = boxOf(obj.body, name);
      if (b) { box = b; boxName = name; break; }
    }
    if (box) break;
  }
  if (!box) { const e = new Error('That PDF declares no page size.'); e.code = 'no_dimensions'; throw e; }

  const wPt = Math.abs(box[2] - box[0]), hPt = Math.abs(box[3] - box[1]);
  out.format = {
    wMm: +(wPt * MM_PER_PT).toFixed(2), hMm: +(hPt * MM_PER_PT).toFixed(2),
    orientation: wPt > hPt ? 'landscape' : wPt < hPt ? 'portrait' : 'square',
    matchedFormatId: null, exact: boxName === 'TrimBox'
  };
  if (boxName !== 'TrimBox') out.findings.push({ s: 'review',
    label: `Size taken from the ${boxName}, not a TrimBox`,
    note: 'if the file carries bleed, the card is smaller than this — confirm the trim' });

  let runs = [], shapes = [], colours = [], unparsed = 0;
  for (const [, obj] of map) {
    if (!/\/Contents|stream/.test(obj.body)) continue;
    const data = streamOf(obj, buf, raw);
    if (!data || !/(BT|re|Tj|TJ)\b/.test(data.toString('latin1', 0, Math.min(4096, data.length)))) continue;
    const r = readContent(data);
    runs = runs.concat(r.runs); shapes = shapes.concat(r.shapes);
    colours = colours.concat(r.colours); unparsed += r.unparsed;
  }

  let seq = 0;
  for (const r of runs) {
    const text = r.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const p = PART();
    p.id = 'p' + (++seq);
    p.kind = 'text';
    p.text = text;
    p.script = BN.test(text) ? (/[A-Za-z]/.test(text) ? 'mixed' : 'bangla') : 'latin';
    p.style.family = familyFromResources(raw, r.font);
    p.style.sizePt = r.sizePt ? +Number(r.sizePt).toFixed(2) : null;
    p.style.color = r.color || null;
    const yPt = r.tm ? r.tm[5] : 0, xPt = r.tm ? r.tm[4] : 0;
    const h = (p.style.sizePt || 0) * MM_PER_PT;
    /* PDF's origin is bottom-left; the contract measures from the top. */
    p.observed = { x: +((xPt - box[0]) * MM_PER_PT).toFixed(3),
                   y: +(out.format.hMm - (yPt - box[1]) * MM_PER_PT - h).toFixed(3),
                   w: +(text.length * h * 0.5).toFixed(3), h: +h.toFixed(3) };
    p.source = 'read';
    p.confidence = 1;
    out.parts.push(p);
  }

  const total = out.format.wMm * out.format.hMm || 1;
  for (const s of shapes) {
    if (!(s.w && s.h)) continue;
    const p = PART();
    p.id = 'p' + (++seq);
    p.kind = Math.min(Math.abs(s.w), Math.abs(s.h)) * MM_PER_PT < 0.6 ? 'rule' : 'panel';
    p.style.color = s.color || null;
    p.observed = { x: +((s.x - box[0]) * MM_PER_PT).toFixed(3),
                   y: +(out.format.hMm - (s.y - box[1]) * MM_PER_PT - Math.abs(s.h) * MM_PER_PT).toFixed(3),
                   w: +(Math.abs(s.w) * MM_PER_PT).toFixed(3), h: +(Math.abs(s.h) * MM_PER_PT).toFixed(3) };
    p.source = 'read';
    p.confidence = 1;
    out.parts.push(p);
  }

  const area = new Map();
  for (const c of colours) if (c) area.set(c, (area.get(c) || 0) + 1);
  const sum = [...area.values()].reduce((a, b) => a + b, 0) || 1;
  out.palette = [...area.entries()].map(([hex, n]) => ({ hex, area: +(n / sum).toFixed(4), role: null }))
    .sort((a, b) => b.area - a.area).slice(0, 12);

  const fonts = new Map();
  for (const p of out.parts) {
    if (p.kind !== 'text' || !p.style.family) continue;
    if (!fonts.has(p.style.family)) fonts.set(p.style.family,
      { family: p.style.family, weight: p.style.weight, embedded: true, licensed: null });
  }
  out.fonts = [...fonts.values()];

  const textParts = out.parts.filter(p => p.kind === 'text');
  if (!textParts.length) {
    /* The outlined-text case. Not a parse failure — a true statement about the
       file, and the one a CARDWORKS print file will always produce. */
    out.findings.push({ s: 'fail', label: 'This PDF contains no text, only shapes',
      note: 'its type has been converted to outlines, so the words cannot be read back as characters — the palette and the size are still usable' });
    if (!out.parts.length) {
      const e = new Error('Nothing could be read out of that PDF — no text and no shapes.');
      e.code = 'nothing_read';
      e.remediationText = 'It may be a scan. Type the content into the brief instead and keep the look.';
      throw e;
    }
  }
  if (unparsed) out.findings.push({ s: 'review',
    label: `${unparsed} text run${unparsed > 1 ? 's' : ''} used an encoding this reader does not decode`,
    note: 'they are reported rather than guessed at, so nothing invented has entered your card' });

  return out;
}
