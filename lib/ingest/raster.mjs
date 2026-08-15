/* What a photograph or a flat export can honestly give us, and what it cannot.
 *
 * This is the format where it is easiest to cheat and worst to. A PNG of a
 * card contains its text as pixels; reading it back requires OCR, and there is
 * no OCR here. The temptation is to guess — to return a plausible name and a
 * plausible font so the screen looks like it worked. That guess would not be
 * caught at the proof either, because the customer reads what they meant to
 * write, and it would be caught by the five hundred people handed the printed
 * card.
 *
 * So this file extracts only what is measurable — dimensions, real resolution,
 * the colours actually present, ink coverage — and refuses the rest by name.
 * The refusal carries the path that does work: type the content into the brief
 * and keep the palette we read off the artwork.
 *
 * PNG is decoded for real, because zlib is in the standard library and a true
 * palette is worth having. JPEG is not: there is no DCT decoder here, so a
 * JPEG yields its header facts and an explicit statement that its colours were
 * not sampled. Reporting a guessed palette as a measured one is the same lie
 * in a smaller font.
 */
import zlib from 'node:zlib';
import { CARD_PARTS } from './contract.mjs';

const MM_PER_IN = 25.4;

/* ── PNG ──────────────────────────────────────────────────────────────── */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunks(buf) {
  const out = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    out.push({ type, data });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Undo PNG's per-scanline filters. Getting this wrong produces an image that
 *  looks like static, which is at least loud — but the palette derived from it
 *  would be quiet nonsense, so it is worth doing exactly. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      const x = line[i];
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: {
          const e = new Error('That PNG uses a scanline filter we do not understand.');
          e.code = 'png_filter'; throw e;
        }
      }
      cur[i] = v & 0xff;
    }
  }
  return out;
}

function decodePng(buf) {
  const chunks = pngChunks(buf);
  const ihdr = chunks.find(c => c.type === 'IHDR');
  if (!ihdr) { const e = new Error('That PNG has no header chunk.'); e.code = 'png_broken'; throw e; }

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  const phys = chunks.find(c => c.type === 'pHYs');
  let dpi = null;
  if (phys && phys.data[8] === 1) {                       // unit 1 = metres
    const ppmX = phys.data.readUInt32BE(0);
    if (ppmX > 0) dpi = Math.round(ppmX * 0.0254);
  }

  /* Interlaced and 16-bit PNGs are refused rather than approximated. Both are
     rare in card artwork and both need a different reader; guessing at the
     pixel layout would yield a palette that is confidently wrong. */
  if (interlace !== 0) { const e = new Error('That PNG is interlaced, which this reader cannot decode.'); e.code = 'png_interlaced'; throw e; }
  if (depth !== 8) { const e = new Error(`That PNG is ${depth}-bit; this reader handles 8-bit.`); e.code = 'png_depth'; throw e; }

  let pixels = null;
  if (colorType === 2 || colorType === 6 || colorType === 0 || colorType === 4) {
    const idat = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
    if (idat.length) {
      const bpp = CHANNELS[colorType];
      const raw = zlib.inflateSync(idat);
      pixels = { data: unfilter(raw, width, height, bpp), bpp, width, height, colorType };
    }
  } else if (colorType === 3) {
    /* Indexed colour: the palette is already the answer, no decode needed. */
    const plte = chunks.find(c => c.type === 'PLTE');
    if (plte) {
      const entries = [];
      for (let i = 0; i + 2 < plte.data.length; i += 3)
        entries.push('#' + [plte.data[i], plte.data[i + 1], plte.data[i + 2]]
          .map(n => n.toString(16).padStart(2, '0')).join(''));
      return { width, height, dpi, indexed: entries, pixels: null };
    }
  }
  return { width, height, dpi, indexed: null, pixels };
}

/* ── Colour sampling ──────────────────────────────────────────────────────
   Quantised to a 6-level cube per channel before counting, because a JPEG
   round-trip or an anti-aliased edge turns one black into four hundred
   near-blacks, and a palette listing four hundred blacks is not a palette. */
function samplePalette(pixels, maxSamples = 60000) {
  const { data, bpp, width, height, colorType } = pixels;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / maxSamples));
  const bucket = new Map();
  let inkSum = 0, counted = 0;

  for (let i = 0; i < total; i += step) {
    const at = i * bpp;
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = data[at]; }
    else if (colorType === 4) { r = g = b = data[at]; a = data[at + 1]; }
    else if (colorType === 2) { r = data[at]; g = data[at + 1]; b = data[at + 2]; }
    else { r = data[at]; g = data[at + 1]; b = data[at + 2]; a = data[at + 3]; }
    if (a < 16) continue;

    const q = (v) => Math.round(v / 51) * 51;              // six levels per channel
    const key = (q(r) << 16) | (q(g) << 8) | q(b);
    bucket.set(key, (bucket.get(key) || 0) + 1);

    /* Total area coverage, the naive RGB→CMYK way the engine already uses to
       catch the 300% cliff. Enough to tell a customer their solid-black
       background will not dry, which is the actual failure. */
    const c = 1 - r / 255, m = 1 - g / 255, y = 1 - b / 255;
    const k = Math.min(c, m, y);
    const d = 1 - k || 1;
    inkSum += ((c - k) / d + (m - k) / d + (y - k) / d + k) * 100;
    counted++;
  }

  const hex = (key) => '#' + [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff]
    .map(n => Math.min(255, n).toString(16).padStart(2, '0')).join('');

  const sum = [...bucket.values()].reduce((a, b) => a + b, 0) || 1;
  const palette = [...bucket.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([key, n]) => ({ hex: hex(key), area: +(n / sum).toFixed(4), role: null }));

  return { palette, meanTac: counted ? +(inkSum / counted).toFixed(1) : null };
}

/* ── JPEG ─────────────────────────────────────────────────────────────── */

function readJpeg(buf) {
  let at = 2, width = 0, height = 0, dpi = null;
  while (at + 4 < buf.length) {
    if (buf[at] !== 0xff) { at++; continue; }
    const marker = buf[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const len = buf.readUInt16BE(at + 2);
    if (marker === 0xe0 && buf.toString('latin1', at + 4, at + 9) === 'JFIF\0') {
      const unit = buf[at + 11];
      const xd = buf.readUInt16BE(at + 12);
      if (unit === 1 && xd > 0) dpi = xd;
      if (unit === 2 && xd > 0) dpi = Math.round(xd * 2.54);
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = buf.readUInt16BE(at + 5);
      width = buf.readUInt16BE(at + 7);
      break;
    }
    at += 2 + len;
  }
  if (!width || !height) { const e = new Error('No frame header found in that JPEG.'); e.code = 'jpeg_broken'; throw e; }
  return { width, height, dpi };
}

/* ── The public entry ─────────────────────────────────────────────────── */

/**
 * Read what is measurable from a raster card, and state what is not.
 *
 * Returns a `CardParts` with **zero text parts** — always, by construction.
 * There is no path through this function that invents a string or a font name,
 * and `tests/destructure.test.mjs` asserts that rather than trusting it.
 */
export function destructureRaster(bytes, meta = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const isPng = buf.subarray(0, 8).equals(PNG_MAGIC);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpeg) {
    const e = new Error('That is not a PNG or a JPEG.');
    e.code = 'not_raster'; throw e;
  }

  const out = CARD_PARTS();
  out.origin = { filename: meta.filename || '', mime: isPng ? 'image/png' : 'image/jpeg',
                 bytes: buf.length, pages: 1 };

  const info = isPng ? decodePng(buf) : readJpeg(buf);
  const dpi = info.dpi || null;

  /* Without a stated resolution there is no way to know the physical size, so
     the card is measured against the standard trim rather than invented: at
     89 mm wide, what resolution would this pixel count be? That is the number
     that decides whether the artwork can be printed at all. */
  const assumedWidthMm = 89;
  const effectiveDpi = dpi || +(info.width / (assumedWidthMm / MM_PER_IN)).toFixed(0);
  const wMm = dpi ? +(info.width / dpi * MM_PER_IN).toFixed(2) : assumedWidthMm;
  const hMm = dpi ? +(info.height / dpi * MM_PER_IN).toFixed(2)
                  : +(assumedWidthMm * info.height / info.width).toFixed(2);

  out.format = {
    wMm, hMm,
    orientation: info.width > info.height ? 'landscape' : info.width < info.height ? 'portrait' : 'square',
    matchedFormatId: null, exact: !!dpi
  };

  if (info.indexed) {
    out.palette = info.indexed.slice(0, 12).map(hex => ({ hex, area: 0, role: null }));
    out.findings.push({ s: 'pass', label: `${info.indexed.length} colours read from the file's own palette`, note: '' });
  } else if (info.pixels) {
    const { palette, meanTac } = samplePalette(info.pixels);
    out.palette = palette;
    out.findings.push({ s: 'pass', label: `${palette.length} colours sampled from the artwork`,
      note: 'quantised, so near-identical shades are counted once' });
    if (meanTac !== null && meanTac > 300) out.findings.push({ s: 'fail',
      label: `Average ink coverage is ${meanTac}%, over the 300% limit`,
      note: 'solid dark areas will not dry on coated stock and will offset onto the next sheet' });
    else if (meanTac !== null) out.findings.push({ s: 'pass', label: `Average ink coverage ${meanTac}%`, note: 'under the 300% limit' });
  } else {
    out.findings.push({ s: 'review', label: 'Colours were not sampled from this file',
      note: isJpeg ? 'JPEG pixel data needs a decoder this build does not carry'
                   : 'this PNG stores its pixels in a form this reader does not decode' });
  }

  /* The refusal that keeps this feature honest. */
  out.findings.push({ s: 'fail', label: 'Text and fonts cannot be read out of an image',
    note: 'the words on this card are pixels, not characters — nothing here has guessed at them' });

  if (effectiveDpi < 300) out.findings.push({ s: 'fail',
    label: `Artwork is ${effectiveDpi} dpi at card size, below the 300 dpi print minimum`,
    note: 'it will look soft on paper; the original vector file would fix it' });
  else out.findings.push({ s: 'pass', label: `Artwork is ${effectiveDpi} dpi at card size`, note: 'at or above the 300 dpi minimum' });

  if (!dpi) out.findings.push({ s: 'review', label: 'The file does not say what size it is meant to print at',
    note: `measured against the standard ${assumedWidthMm} mm trim — confirm before printing` });

  out.quality = { score: 0, band: 'poor' };
  return out;
}
