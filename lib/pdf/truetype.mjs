/* A TrueType reader, cut to exactly what outlining needs.
 *
 * The library policy is that fonts are outlined and never embedded (PRD §7,
 * blueprint F13), which means the writer cannot hand a font file to the PDF
 * and let a RIP find the glyphs — it has to walk the `glyf` table itself and
 * emit the contours as path operators. That is what this file does: sfnt
 * directory, `head` for the em square, `cmap` for codepoint → glyph, `hmtx`
 * for advances, and `glyf`/`loca` for the outlines, including composites.
 *
 * Nothing here interprets hinting. Hinting exists to make a glyph land on a
 * pixel grid; a press has no pixel grid, and the outline is the truth at
 * 2540 dpi. Ignoring it is correct, not a shortcut.
 */

const tag = (buf, off) => buf.toString('latin1', off, off + 4);

/* TrueType contours are quadratic and PDF paths are cubic, so every off-curve
   point becomes a cubic control pair. The elevation is exact — a quadratic is
   a cubic whose two controls sit two-thirds of the way to the quadratic's
   single control — so no curve is approximated anywhere in this pipeline. */
function quadTo(path, x0, y0, qx, qy, x1, y1) {
  path.push(['c',
    x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0),
    x1 + (2 / 3) * (qx - x1), y1 + (2 / 3) * (qy - y1),
    x1, y1]);
}

export class TrueTypeFont {
  constructor(buf, label) {
    this.buf = buf;
    this.label = label;
    this.tables = {};
    this.glyphCache = new Map();

    const version = buf.readUInt32BE(0);
    if (version !== 0x00010000 && tag(buf, 0) !== 'true')
      throw new Error(`${label}: not a TrueType file (sfnt version 0x${version.toString(16)})`);
    if (tag(buf, 0) === 'OTTO')
      throw new Error(`${label}: CFF outlines, not glyf — this reader only walks quadratic contours`);

    const numTables = buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      this.tables[tag(buf, rec)] = { off: buf.readUInt32BE(rec + 8), len: buf.readUInt32BE(rec + 12) };
    }
    for (const t of ['head', 'maxp', 'cmap', 'hhea', 'hmtx', 'loca', 'glyf'])
      if (!this.tables[t]) throw new Error(`${label}: required table '${t}' is missing`);

    const head = this.tables.head.off;
    this.unitsPerEm = buf.readUInt16BE(head + 18);
    this.indexToLocFormat = buf.readInt16BE(head + 50);
    this.numGlyphs = buf.readUInt16BE(this.tables.maxp.off + 4);
    this.numberOfHMetrics = buf.readUInt16BE(this.tables.hhea.off + 34);
    this.ascender = buf.readInt16BE(this.tables.hhea.off + 4);
    this.descender = buf.readInt16BE(this.tables.hhea.off + 6);

    this.cmap = this.#readCmap();
    this.hasGsub = !!this.tables.GSUB;
  }

  /* ── codepoint → glyph id ─────────────────────────────────────────────
     Google's static instances carry a format 4 Windows BMP subtable and,
     for the Bengali faces, a format 12 one as well. Both are read; a
     codepoint absent from the table returns 0, and the caller must treat
     glyph 0 as a refusal rather than draw the .notdef box. */
  #readCmap() {
    const b = this.buf, base = this.tables.cmap.off;
    const n = b.readUInt16BE(base + 2);
    let best = null, bestScore = -1;
    for (let i = 0; i < n; i++) {
      const rec = base + 4 + i * 8;
      const platform = b.readUInt16BE(rec), encoding = b.readUInt16BE(rec + 2);
      const off = base + b.readUInt32BE(rec + 4);
      const format = b.readUInt16BE(off);
      const score = format === 12 ? 3 : (platform === 3 && encoding === 1 && format === 4) ? 2
                  : (platform === 0 && format === 4) ? 1 : 0;
      if (score > bestScore) { bestScore = score; best = { off, format }; }
    }
    if (!best || bestScore === 0) throw new Error(`${this.label}: no usable cmap subtable`);

    const map = new Map();
    if (best.format === 4) {
      const off = best.off, segX2 = b.readUInt16BE(off + 6), seg = segX2 / 2;
      const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < seg; s++) {
        const end = b.readUInt16BE(ends + s * 2), start = b.readUInt16BE(starts + s * 2);
        if (start === 0xffff) continue;
        const delta = b.readInt16BE(deltas + s * 2), rangeOff = b.readUInt16BE(ranges + s * 2);
        for (let cp = start; cp <= end && cp !== 0x10000; cp++) {
          let g;
          if (rangeOff === 0) g = (cp + delta) & 0xffff;
          else {
            const gi = ranges + s * 2 + rangeOff + (cp - start) * 2;
            if (gi + 1 >= this.buf.length) continue;
            g = b.readUInt16BE(gi);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g) map.set(cp, g);
        }
      }
    } else {
      const off = best.off, groups = b.readUInt32BE(off + 12);
      for (let i = 0; i < groups; i++) {
        const g = off + 16 + i * 12;
        const start = b.readUInt32BE(g), end = b.readUInt32BE(g + 4), gid = b.readUInt32BE(g + 8);
        for (let cp = start; cp <= end; cp++) map.set(cp, gid + (cp - start));
      }
    }
    return map;
  }

  glyphIdFor(codepoint) { return this.cmap.get(codepoint) || 0; }

  /** Advance width in font units, which is the unit GPOS adjusts in — a
   *  positioning table adds design units, not fractions of an em, so the
   *  shaper works here and converts once at the end. */
  advanceRaw(gid) {
    const { off } = this.tables.hmtx;
    const i = Math.min(gid, this.numberOfHMetrics - 1);
    if (i < 0) return 0;
    return this.buf.readUInt16BE(off + i * 4);
  }

  /** Advance width in em units (1.0 = one em), which is the unit the composer
   *  measures in, so a width from here is directly comparable to one from the
   *  engine's metric model. */
  advanceEm(gid) {
    return this.advanceRaw(gid) / this.unitsPerEm;
  }

  #locaAt(i) {
    const { off } = this.tables.loca;
    return this.indexToLocFormat === 0 ? this.buf.readUInt16BE(off + i * 2) * 2 : this.buf.readUInt32BE(off + i * 4);
  }

  /** Contours for a glyph, in font units, as PDF-shaped path commands:
   *  ['m',x,y] ['l',x,y] ['c',x1,y1,x2,y2,x3,y3] ['h']. */
  pathFor(gid, depth = 0) {
    const cached = this.glyphCache.get(gid);
    if (cached) return cached;
    if (depth > 5) throw new Error(`${this.label}: composite glyph ${gid} nests too deeply`);

    const start = this.#locaAt(gid), end = this.#locaAt(gid + 1);
    if (end <= start) { this.glyphCache.set(gid, []); return []; }  // a blank glyph, e.g. space

    const b = this.buf, g = this.tables.glyf.off + start;
    const numberOfContours = b.readInt16BE(g);
    const path = numberOfContours >= 0 ? this.#simpleGlyph(g, numberOfContours) : this.#compositeGlyph(g, depth);
    this.glyphCache.set(gid, path);
    return path;
  }

  #simpleGlyph(g, numberOfContours) {
    const b = this.buf;
    const endPts = [];
    for (let i = 0; i < numberOfContours; i++) endPts.push(b.readUInt16BE(g + 10 + i * 2));
    const nPoints = numberOfContours ? endPts[numberOfContours - 1] + 1 : 0;
    let p = g + 10 + numberOfContours * 2;
    p += 2 + b.readUInt16BE(p);                       // skip the hinting program

    const flags = new Uint8Array(nPoints);
    for (let i = 0; i < nPoints;) {
      const f = b[p++]; flags[i++] = f;
      if (f & 0x08) { let r = b[p++]; while (r-- > 0 && i < nPoints) flags[i++] = f; }
    }
    const xs = new Int16Array(nPoints), ys = new Int16Array(nPoints);
    let v = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 0x02) { const d = b[p++]; v += (f & 0x10) ? d : -d; }
      else if (!(f & 0x10)) { v += b.readInt16BE(p); p += 2; }
      xs[i] = v;
    }
    v = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & 0x04) { const d = b[p++]; v += (f & 0x20) ? d : -d; }
      else if (!(f & 0x20)) { v += b.readInt16BE(p); p += 2; }
      ys[i] = v;
    }

    const path = [];
    let s = 0;
    for (const e of endPts) {
      this.#emitContour(path, flags, xs, ys, s, e);
      s = e + 1;
    }
    return path;
  }

  /* A TrueType contour is a ring of points that alternates on- and off-curve
     freely: two consecutive off-curve points imply an on-curve point at their
     midpoint, and a contour may open on an off-curve point. Both cases are
     handled here rather than assumed away, because Bengali and Playfair both
     produce them and getting either wrong shows up as a torn letterform. */
  #emitContour(path, flags, xs, ys, s, e) {
    const n = e - s + 1;
    if (n <= 0) return;
    const on = i => (flags[s + ((i % n) + n) % n] & 0x01) !== 0;
    const px = i => xs[s + ((i % n) + n) % n];
    const py = i => ys[s + ((i % n) + n) % n];

    let startIdx = 0;
    while (startIdx < n && !on(startIdx)) startIdx++;
    let sx, sy;
    if (startIdx === n) {                 // every point is off-curve
      startIdx = 0;
      sx = (px(0) + px(1)) / 2; sy = (py(0) + py(1)) / 2;
    } else { sx = px(startIdx); sy = py(startIdx); }

    path.push(['m', sx, sy]);
    let cx = sx, cy = sy, ctrl = null;
    for (let k = 1; k <= n; k++) {
      const i = startIdx + k;
      const x = px(i), y = py(i);
      if (on(i)) {
        if (ctrl) { quadTo(path, cx, cy, ctrl[0], ctrl[1], x, y); ctrl = null; }
        else path.push(['l', x, y]);
        cx = x; cy = y;
      } else {
        if (ctrl) {
          const mx = (ctrl[0] + x) / 2, my = (ctrl[1] + y) / 2;
          quadTo(path, cx, cy, ctrl[0], ctrl[1], mx, my);
          cx = mx; cy = my;
        }
        ctrl = [x, y];
      }
    }
    if (ctrl) quadTo(path, cx, cy, ctrl[0], ctrl[1], sx, sy);
    path.push(['h']);
  }

  #compositeGlyph(g, depth) {
    const b = this.buf;
    let p = g + 10;
    const out = [];
    for (;;) {
      const flags = b.readUInt16BE(p), glyphIndex = b.readUInt16BE(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 0x0001) { dx = b.readInt16BE(p); dy = b.readInt16BE(p + 2); p += 4; }
      else { dx = b.readInt8(p); dy = b.readInt8(p + 1); p += 2; }
      if (!(flags & 0x0002)) { dx = 0; dy = 0; }     // point-matched components carry no offset we can honour

      let a = 1, bb = 0, c = 0, d = 1;
      const f2 = () => { const v = b.readInt16BE(p) / 16384; p += 2; return v; };
      if (flags & 0x0008) { a = d = f2(); }
      else if (flags & 0x0040) { a = f2(); d = f2(); }
      else if (flags & 0x0080) { a = f2(); bb = f2(); c = f2(); d = f2(); }

      for (const cmd of this.pathFor(glyphIndex, depth + 1)) {
        const t = [cmd[0]];
        for (let i = 1; i < cmd.length; i += 2) {
          const x = cmd[i], y = cmd[i + 1];
          t.push(a * x + c * y + dx, bb * x + d * y + dy);
        }
        out.push(t);
      }
      if (!(flags & 0x0020)) break;
    }
    return out;
  }
}
