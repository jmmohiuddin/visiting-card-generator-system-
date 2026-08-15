/* OpenType Layout — GSUB and GPOS, read straight out of the font binary.
 *
 * `truetype.mjs` answers "which glyph is this codepoint" and "what does that
 * glyph look like". That is the whole job for Latin and roughly a third of it
 * for Bengali, where the glyph a reader sees is chosen by substitution rules
 * the font carries in its own tables. This file reads those tables and runs
 * them; `bengali.mjs` decides which of them to run and in what order.
 *
 * The division matters because the rules are not the same across the four
 * Bangla families in assets/fonts. Noto Sans Bengali forms ক্ষ with a chained
 * context lookup, Hind Siliguri with a plain ligature, and the two disagree
 * about whether ব takes a below-base form at all. A table of conjuncts
 * written into this repository would therefore be wrong for at least one of
 * them, and wrong in the specific way nobody notices — a conjunct that is a
 * real glyph, just not the one the word needs. So nothing here knows any
 * Bengali. It knows Coverage, ClassDef and the eight lookup formats, and the
 * font supplies the language.
 *
 * Read against the OpenType 1.9 spec chapters on GSUB, GPOS and the common
 * layout tables (learn.microsoft.com/en-us/typography/opentype/spec/gsub,
 * /gpos, /chapter2), and against HarfBuzz's hb-ot-layout-*.hh for the parts
 * the spec describes but does not pin down — chiefly how a contextual lookup
 * re-indexes its input sequence after a nested lookup has changed the buffer
 * length.
 *
 * Device tables are read past and ignored, for the same reason `truetype.mjs`
 * ignores hinting: a device table adjusts a value at a named pixel-per-em, and
 * a press has no pixels. Ignoring them at 2540 dpi is the correct answer, not
 * a shortcut.
 */

const tag = (b, o) => b.toString('latin1', o, o + 4);

/* ── The common tables ──────────────────────────────────────────────────── */

/* Coverage maps a glyph id to its index within the lookup's own arrays. The
   returned Map is the coverage index, not a boolean, because every format
   that uses coverage also indexes something parallel by it. */
function readCoverage(b, off) {
  const fmt = b.readUInt16BE(off);
  const map = new Map();
  if (fmt === 1) {
    const n = b.readUInt16BE(off + 2);
    for (let i = 0; i < n; i++) map.set(b.readUInt16BE(off + 4 + i * 2), i);
  } else if (fmt === 2) {
    const n = b.readUInt16BE(off + 2);
    for (let i = 0; i < n; i++) {
      const r = off + 4 + i * 6;
      const start = b.readUInt16BE(r), end = b.readUInt16BE(r + 2), first = b.readUInt16BE(r + 4);
      for (let g = start; g <= end; g++) map.set(g, first + (g - start));
    }
  } else {
    throw new Error(`unknown Coverage format ${fmt}`);
  }
  return map;
}

/* ClassDef is total: a glyph absent from the table is class 0, which is what
   the format-2 ranges leave out rather than spell. */
function readClassDef(b, off) {
  if (!off) return new Map();
  const fmt = b.readUInt16BE(off);
  const map = new Map();
  if (fmt === 1) {
    const start = b.readUInt16BE(off + 2), n = b.readUInt16BE(off + 4);
    for (let i = 0; i < n; i++) map.set(start + i, b.readUInt16BE(off + 6 + i * 2));
  } else if (fmt === 2) {
    const n = b.readUInt16BE(off + 2);
    for (let i = 0; i < n; i++) {
      const r = off + 4 + i * 6;
      const start = b.readUInt16BE(r), end = b.readUInt16BE(r + 2), cls = b.readUInt16BE(r + 4);
      for (let g = start; g <= end; g++) map.set(g, cls);
    }
  } else {
    throw new Error(`unknown ClassDef format ${fmt}`);
  }
  return map;
}

/* The eight ValueRecord fields, in the order their presence bits sit in the
   value format. The last four are device offsets, counted so the cursor
   lands right and then thrown away. */
const VF_BITS = ['xPlacement', 'yPlacement', 'xAdvance', 'yAdvance',
                 'xPlaDevice', 'yPlaDevice', 'xAdvDevice', 'yAdvDevice'];

const valueRecordSize = (format) => {
  let n = 0;
  for (let i = 0; i < 8; i++) if (format & (1 << i)) n += 2;
  return n;
};

/* A ValueRecord is a sparse struct whose present fields are named by a bit
   mask on the enclosing subtable. Only the four placement/advance fields are
   kept; the four device offsets are counted so the cursor lands right. */
function readValueRecord(b, off, format) {
  const v = { xPlacement: 0, yPlacement: 0, xAdvance: 0, yAdvance: 0 };
  let p = off;
  for (let i = 0; i < 8; i++) {
    if (!(format & (1 << i))) continue;
    if (i < 4) v[VF_BITS[i]] = b.readInt16BE(p);
    p += 2;
  }
  return v;
}

/* Anchor format 2 names a contour point on the glyph as well as a coordinate.
   Honouring the point would mean running the glyph's hinting program to find
   where that point ended up, which this pipeline deliberately does not do —
   so the coordinate the table also carries is used, which is what the format
   is required to supply for exactly this case. */
function readAnchor(b, off) {
  if (!off) return null;
  return { x: b.readInt16BE(off + 2), y: b.readInt16BE(off + 4) };
}

function readMarkArray(b, off) {
  const n = b.readUInt16BE(off);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = off + 2 + i * 4;
    out.push({ cls: b.readUInt16BE(r), anchor: readAnchor(b, off + b.readUInt16BE(r + 2)) });
  }
  return out;
}

/* BaseArray, LigatureAttach and Mark2Array are all the same shape: a count,
   then a row of `classCount` anchor offsets per entry. */
function readAnchorMatrix(b, off, classCount) {
  const rows = b.readUInt16BE(off);
  const out = [];
  for (let i = 0; i < rows; i++) {
    const row = [];
    for (let c = 0; c < classCount; c++) {
      const o = b.readUInt16BE(off + 2 + (i * classCount + c) * 2);
      row.push(o ? readAnchor(b, off + o) : null);
    }
    out.push(row);
  }
  return out;
}

/* ── Lookup subtables ───────────────────────────────────────────────────── */

function readSequenceRules(b, off, arity) {
  /* Both the glyph-keyed (format 1) and class-keyed (format 2) rule sets have
     this shape; `arity` is 1 for a plain context and 3 for a chained one. */
  const n = b.readUInt16BE(off);
  const rules = [];
  for (let i = 0; i < n; i++) {
    const r = off + b.readUInt16BE(off + 2 + i * 2);
    if (arity === 1) {
      const glyphCount = b.readUInt16BE(r), lookupCount = b.readUInt16BE(r + 2);
      const input = [];
      for (let k = 0; k < glyphCount - 1; k++) input.push(b.readUInt16BE(r + 4 + k * 2));
      rules.push({ backtrack: [], input, lookahead: [],
                   records: readSeqLookups(b, r + 4 + (glyphCount - 1) * 2, lookupCount) });
    } else {
      let p = r;
      const btCount = b.readUInt16BE(p); p += 2;
      const backtrack = []; for (let k = 0; k < btCount; k++) { backtrack.push(b.readUInt16BE(p)); p += 2; }
      const inCount = b.readUInt16BE(p); p += 2;
      const input = []; for (let k = 0; k < inCount - 1; k++) { input.push(b.readUInt16BE(p)); p += 2; }
      const laCount = b.readUInt16BE(p); p += 2;
      const lookahead = []; for (let k = 0; k < laCount; k++) { lookahead.push(b.readUInt16BE(p)); p += 2; }
      const lookupCount = b.readUInt16BE(p); p += 2;
      rules.push({ backtrack, input, lookahead, records: readSeqLookups(b, p, lookupCount) });
    }
  }
  return rules;
}

function readSeqLookups(b, off, count) {
  const out = [];
  for (let i = 0; i < count; i++)
    out.push({ seqIdx: b.readUInt16BE(off + i * 4), lookupIdx: b.readUInt16BE(off + i * 4 + 2) });
  return out;
}

/* The offsets in a format-3 context are measured from the start of the
   subtable, not from the array that holds them, so `base` is passed in
   separately from where the array sits. */
function readCoverageList(b, arrayOff, count, base) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(readCoverage(b, base + b.readUInt16BE(arrayOff + i * 2)));
  return out;
}

function readSubst(b, off, type) {
  const fmt = b.readUInt16BE(off);
  switch (type) {
    case 1: {
      const cov = readCoverage(b, off + b.readUInt16BE(off + 2));
      if (fmt === 1) { const delta = b.readInt16BE(off + 4); return { type, fmt, cov, delta }; }
      const n = b.readUInt16BE(off + 4), subs = [];
      for (let i = 0; i < n; i++) subs.push(b.readUInt16BE(off + 6 + i * 2));
      return { type, fmt, cov, subs };
    }
    case 2: case 3: {
      const cov = readCoverage(b, off + b.readUInt16BE(off + 2));
      const n = b.readUInt16BE(off + 4), sets = [];
      for (let i = 0; i < n; i++) {
        const s = off + b.readUInt16BE(off + 6 + i * 2);
        const c = b.readUInt16BE(s), seq = [];
        for (let k = 0; k < c; k++) seq.push(b.readUInt16BE(s + 2 + k * 2));
        sets.push(seq);
      }
      return { type, fmt, cov, sets };
    }
    case 4: {
      const cov = readCoverage(b, off + b.readUInt16BE(off + 2));
      const n = b.readUInt16BE(off + 4), sets = [];
      for (let i = 0; i < n; i++) {
        const s = off + b.readUInt16BE(off + 6 + i * 2);
        const c = b.readUInt16BE(s), ligs = [];
        for (let k = 0; k < c; k++) {
          const l = s + b.readUInt16BE(s + 2 + k * 2);
          const glyph = b.readUInt16BE(l), comps = b.readUInt16BE(l + 2), rest = [];
          for (let m = 0; m < comps - 1; m++) rest.push(b.readUInt16BE(l + 4 + m * 2));
          ligs.push({ glyph, components: rest });
        }
        /* Longest first. The spec requires the font to order them so, but a
           shorter ligature listed first would silently win over the longer
           one it is a prefix of, which is exactly a wrong conjunct. */
        ligs.sort((x, y) => y.components.length - x.components.length);
        sets.push(ligs);
      }
      return { type, fmt, cov, sets };
    }
    case 5: return readContext(b, off, fmt, 1, type);
    case 6: return readContext(b, off, fmt, 3, type);
    case 7: {
      const extType = b.readUInt16BE(off + 2);
      return readSubst(b, off + b.readUInt32BE(off + 4), extType);
    }
    default:
      throw new Error(`GSUB lookup type ${type} is not implemented`);
  }
}

function readPos(b, off, type) {
  const fmt = b.readUInt16BE(off);
  switch (type) {
    case 1: {
      const cov = readCoverage(b, off + b.readUInt16BE(off + 2));
      const vf = b.readUInt16BE(off + 4);
      if (fmt === 1) return { type, fmt, cov, value: readValueRecord(b, off + 6, vf) };
      const n = b.readUInt16BE(off + 6), sz = valueRecordSize(vf), values = [];
      for (let i = 0; i < n; i++) values.push(readValueRecord(b, off + 8 + i * sz, vf));
      return { type, fmt, cov, values };
    }
    case 2: {
      const cov = readCoverage(b, off + b.readUInt16BE(off + 2));
      const vf1 = b.readUInt16BE(off + 4), vf2 = b.readUInt16BE(off + 6);
      const s1 = valueRecordSize(vf1), s2 = valueRecordSize(vf2);
      if (fmt === 1) {
        const n = b.readUInt16BE(off + 8), sets = [];
        for (let i = 0; i < n; i++) {
          const s = off + b.readUInt16BE(off + 10 + i * 2);
          const c = b.readUInt16BE(s), pairs = new Map();
          for (let k = 0; k < c; k++) {
            const r = s + 2 + k * (2 + s1 + s2);
            pairs.set(b.readUInt16BE(r),
                      [readValueRecord(b, r + 2, vf1), readValueRecord(b, r + 2 + s1, vf2)]);
          }
          sets.push(pairs);
        }
        return { type, fmt, cov, sets, hasV2: vf2 !== 0 };
      }
      const cd1 = readClassDef(b, off + b.readUInt16BE(off + 8));
      const cd2 = readClassDef(b, off + b.readUInt16BE(off + 10));
      const c1 = b.readUInt16BE(off + 12), c2 = b.readUInt16BE(off + 14);
      const grid = [];
      for (let i = 0; i < c1; i++) {
        const row = [];
        for (let k = 0; k < c2; k++) {
          const r = off + 16 + (i * c2 + k) * (s1 + s2);
          row.push([readValueRecord(b, r, vf1), readValueRecord(b, r + s1, vf2)]);
        }
        grid.push(row);
      }
      return { type, fmt, cov, cd1, cd2, grid, hasV2: vf2 !== 0 };
    }
    case 4: case 6: {
      const markCov = readCoverage(b, off + b.readUInt16BE(off + 2));
      const baseCov = readCoverage(b, off + b.readUInt16BE(off + 4));
      const classCount = b.readUInt16BE(off + 6);
      const marks = readMarkArray(b, off + b.readUInt16BE(off + 8));
      const bases = readAnchorMatrix(b, off + b.readUInt16BE(off + 10), classCount);
      return { type, fmt, markCov, baseCov, classCount, marks, bases };
    }
    case 5: {
      const markCov = readCoverage(b, off + b.readUInt16BE(off + 2));
      const ligCov = readCoverage(b, off + b.readUInt16BE(off + 4));
      const classCount = b.readUInt16BE(off + 6);
      const marks = readMarkArray(b, off + b.readUInt16BE(off + 8));
      const arrayOff = off + b.readUInt16BE(off + 10);
      const n = b.readUInt16BE(arrayOff), ligs = [];
      for (let i = 0; i < n; i++)
        ligs.push(readAnchorMatrix(b, arrayOff + b.readUInt16BE(arrayOff + 2 + i * 2), classCount));
      return { type, fmt, markCov, ligCov, classCount, marks, ligs };
    }
    case 7: return readContext(b, off, fmt, 1, type);
    case 8: return readContext(b, off, fmt, 3, type);
    case 9: {
      const extType = b.readUInt16BE(off + 2);
      return readPos(b, off + b.readUInt32BE(off + 4), extType);
    }
    default:
      throw new Error(`GPOS lookup type ${type} is not implemented`);
  }
}

/* Contextual and chained-contextual share three formats between GSUB and
   GPOS, differing only in which lookup list the nested records index. */
function readContext(b, off, fmt, arity, type) {
  if (fmt === 1) {
    const cov = readCoverage(b, off + b.readUInt16BE(off + 2));
    const n = b.readUInt16BE(off + 4), sets = [];
    for (let i = 0; i < n; i++) {
      const o = b.readUInt16BE(off + 6 + i * 2);
      sets.push(o ? readSequenceRules(b, off + o, arity) : []);
    }
    return { type, fmt, kind: 'ctx', by: 'glyph', arity, cov, sets };
  }
  if (fmt === 2) {
    const cov = readCoverage(b, off + b.readUInt16BE(off + 2));
    let p = off + 4;
    let btClass = null, inClass, laClass = null;
    if (arity === 3) {
      btClass = readClassDef(b, off + b.readUInt16BE(p)); p += 2;
      inClass = readClassDef(b, off + b.readUInt16BE(p)); p += 2;
      laClass = readClassDef(b, off + b.readUInt16BE(p)); p += 2;
    } else {
      inClass = readClassDef(b, off + b.readUInt16BE(p)); p += 2;
    }
    const n = b.readUInt16BE(p); p += 2;
    const sets = [];
    for (let i = 0; i < n; i++) {
      const o = b.readUInt16BE(p + i * 2);
      sets.push(o ? readSequenceRules(b, off + o, arity) : []);
    }
    return { type, fmt, kind: 'ctx', by: 'class', arity, cov, btClass, inClass, laClass, sets };
  }
  if (fmt === 3) {
    if (arity === 1) {
      const count = b.readUInt16BE(off + 2), lookupCount = b.readUInt16BE(off + 4);
      const input = readCoverageList(b, off + 6, count, off);
      return { type, fmt, kind: 'ctx', by: 'coverage', arity,
               backtrack: [], input, lookahead: [],
               records: readSeqLookups(b, off + 6 + count * 2, lookupCount) };
    }
    let p = off + 2;
    const btCount = b.readUInt16BE(p); p += 2;
    const backtrack = readCoverageList(b, p, btCount, off); p += btCount * 2;
    const inCount = b.readUInt16BE(p); p += 2;
    const input = readCoverageList(b, p, inCount, off); p += inCount * 2;
    const laCount = b.readUInt16BE(p); p += 2;
    const lookahead = readCoverageList(b, p, laCount, off); p += laCount * 2;
    const lookupCount = b.readUInt16BE(p); p += 2;
    return { type, fmt, kind: 'ctx', by: 'coverage', arity,
             backtrack, input, lookahead, records: readSeqLookups(b, p, lookupCount) };
  }
  throw new Error(`unknown contextual format ${fmt}`);
}

/* ── GDEF ───────────────────────────────────────────────────────────────── */

export const GLYPH_BASE = 1, GLYPH_LIGATURE = 2, GLYPH_MARK = 3;

function readGdef(b, off) {
  const classOff = b.readUInt16BE(off + 4);
  const markAttachOff = b.readUInt16BE(off + 10);
  const major = b.readUInt16BE(off), minor = b.readUInt16BE(off + 2);
  const gdef = {
    classes: classOff ? readClassDef(b, off + classOff) : new Map(),
    markAttach: markAttachOff ? readClassDef(b, off + markAttachOff) : new Map(),
    markSets: []
  };
  if (major === 1 && minor >= 2) {
    const setsOff = b.readUInt16BE(off + 12);
    if (setsOff) {
      const s = off + setsOff, n = b.readUInt16BE(s + 2);
      for (let i = 0; i < n; i++) gdef.markSets.push(readCoverage(b, s + b.readUInt32BE(s + 4 + i * 4)));
    }
  }
  return gdef;
}

/* ── The table as a whole ───────────────────────────────────────────────── */

export class LayoutTable {
  constructor(buf, off, kind, label) {
    this.kind = kind;
    this.label = label;
    const b = buf;
    const scriptOff = off + b.readUInt16BE(off + 4);
    const featOff = off + b.readUInt16BE(off + 6);
    const lookupOff = off + b.readUInt16BE(off + 8);

    this.scripts = new Map();
    const sc = b.readUInt16BE(scriptOff);
    for (let i = 0; i < sc; i++) {
      const rec = scriptOff + 2 + i * 6;
      const s = scriptOff + b.readUInt16BE(rec + 4);
      const defOff = b.readUInt16BE(s);
      const langs = new Map();
      const ln = b.readUInt16BE(s + 2);
      for (let k = 0; k < ln; k++) {
        const lr = s + 4 + k * 6;
        langs.set(tag(b, lr), readLangSys(b, s + b.readUInt16BE(lr + 4)));
      }
      this.scripts.set(tag(b, rec), { def: defOff ? readLangSys(b, s + defOff) : null, langs });
    }

    this.features = [];
    const fc = b.readUInt16BE(featOff);
    for (let i = 0; i < fc; i++) {
      const rec = featOff + 2 + i * 6;
      const f = featOff + b.readUInt16BE(rec + 4);
      const n = b.readUInt16BE(f + 2), lookups = [];
      for (let k = 0; k < n; k++) lookups.push(b.readUInt16BE(f + 4 + k * 2));
      this.features.push({ tag: tag(b, rec), lookups });
    }

    this.lookups = [];
    const lc = b.readUInt16BE(lookupOff);
    for (let i = 0; i < lc; i++) {
      const l = lookupOff + b.readUInt16BE(lookupOff + 2 + i * 2);
      const type = b.readUInt16BE(l), flag = b.readUInt16BE(l + 2), n = b.readUInt16BE(l + 4);
      const lk = { index: i, type, flag, markFilteringSet: -1, subtables: [], unreadable: null };
      if (flag & 0x0010) lk.markFilteringSet = b.readUInt16BE(l + 6 + n * 2);
      for (let k = 0; k < n; k++) {
        const s = l + b.readUInt16BE(l + 6 + k * 2);
        try {
          lk.subtables.push(kind === 'GSUB' ? readSubst(b, s, type) : readPos(b, s, type));
        } catch (e) {
          /* Kept and named rather than dropped. A subtable this reader cannot
             parse is a rule that will not fire, and a rule that does not fire
             in Bengali is a missing conjunct — so the shaper asks about this
             list and refuses rather than printing whatever it managed. */
          lk.unreadable = `${kind} lookup ${i} (type ${type}): ${e.message}`;
        }
      }
      this.lookups.push(lk);
    }
  }

  /** Feature indices for a script/language, preferring the script's own
   *  default language system. An unknown script returns null so the caller
   *  can fall back rather than shape with the Latin feature set. */
  langSys(scriptTags, langTag) {
    for (const s of scriptTags) {
      const script = this.scripts.get(s);
      if (!script) continue;
      const ls = (langTag && script.langs.get(langTag)) || script.def;
      if (ls) return { script: s, ...ls };
    }
    return null;
  }

  /** Lookup indices for one feature tag within a language system, in the
   *  order the font lists them. Empty when the font has no such feature,
   *  which is normal — Hind Siliguri ships no `cjct` at all. */
  lookupsFor(ls, featureTag) {
    if (!ls) return [];
    const out = [];
    for (const fi of ls.features) {
      const f = this.features[fi];
      if (f && f.tag === featureTag) out.push(...f.lookups);
    }
    return out;
  }
}

function readLangSys(b, off) {
  const required = b.readUInt16BE(off + 2);
  const n = b.readUInt16BE(off + 4), features = [];
  for (let i = 0; i < n; i++) features.push(b.readUInt16BE(off + 6 + i * 2));
  if (required !== 0xffff) features.unshift(required);
  return { required, features };
}

/** GSUB, GPOS and GDEF for a face, parsed once and cached on it. A face with
 *  no GSUB gets `null` — that is a fact about the font, not an error, and the
 *  caller decides whether it can proceed without one. */
export function layoutFor(face) {
  if (face._layout) return face._layout;
  const b = face.buf;
  const L = { gsub: null, gpos: null, gdef: null };
  if (face.tables.GSUB) L.gsub = new LayoutTable(b, face.tables.GSUB.off, 'GSUB', face.label);
  if (face.tables.GPOS) L.gpos = new LayoutTable(b, face.tables.GPOS.off, 'GPOS', face.label);
  if (face.tables.GDEF) L.gdef = readGdef(b, face.tables.GDEF.off);
  face._layout = L;
  return L;
}

/* ── Applying lookups ───────────────────────────────────────────────────── */

/* A glyph the current lookup must step over. GDEF supplies the class; the
   lookup flag supplies the policy. Getting this wrong is quiet: a mark that
   should have been skipped turns a two-glyph ligature match into no match,
   and the conjunct simply does not form. */
function skipped(lk, g, gdef) {
  const cls = gdef ? (gdef.classes.get(g.gid) || 0) : 0;
  if ((lk.flag & 0x0002) && cls === GLYPH_BASE) return true;
  if ((lk.flag & 0x0004) && cls === GLYPH_LIGATURE) return true;
  if ((lk.flag & 0x0008) && cls === GLYPH_MARK) return true;
  if (cls === GLYPH_MARK) {
    const attachType = lk.flag >> 8;
    if (attachType && gdef && (gdef.markAttach.get(g.gid) || 0) !== attachType) return true;
    if (lk.markFilteringSet >= 0 && gdef) {
      const set = gdef.markSets[lk.markFilteringSet];
      if (set && !set.has(g.gid)) return true;
    }
  }
  return false;
}

/* The next / previous buffer position this lookup is allowed to look at. */
function nextPos(buf, i, lk, gdef) {
  for (let k = i + 1; k < buf.length; k++) if (!skipped(lk, buf[k], gdef)) return k;
  return -1;
}
function prevPos(buf, i, lk, gdef) {
  for (let k = i - 1; k >= 0; k--) if (!skipped(lk, buf[k], gdef)) return k;
  return -1;
}

/* Match `seq` forward from just after `i`, skipping what the flag ignores.
   Returns the absolute buffer indices of the matched glyphs, or null. */
function matchForward(buf, i, seq, test, lk, gdef) {
  const idx = [];
  let k = i;
  for (const item of seq) {
    k = nextPos(buf, k, lk, gdef);
    if (k < 0 || !test(item, buf[k].gid)) return null;
    idx.push(k);
  }
  return idx;
}

function matchBackward(buf, i, seq, test, lk, gdef) {
  let k = i;
  for (const item of seq) {
    k = prevPos(buf, k, lk, gdef);
    if (k < 0 || !test(item, buf[k].gid)) return null;
  }
  return true;
}

const byGlyph = (want, gid) => want === gid;
const byCoverage = (cov, gid) => cov.has(gid);
const byClassOf = (cd) => (want, gid) => (cd.get(gid) || 0) === want;

/* One contextual subtable, resolved to (matched input indices, records) or
   null. Both GSUB 5/6 and GPOS 7/8 land here. */
function matchContext(st, buf, i, lk, gdef) {
  const gid = buf[i].gid;
  if (st.by === 'coverage') {
    if (!st.input.length || !st.input[0].has(gid)) return null;
    if (!matchBackward(buf, i, st.backtrack, byCoverage, lk, gdef)) return null;
    const inputIdx = matchForward(buf, i, st.input.slice(1), byCoverage, lk, gdef);
    if (!inputIdx) return null;
    const last = inputIdx.length ? inputIdx[inputIdx.length - 1] : i;
    if (!matchForward(buf, last, st.lookahead, byCoverage, lk, gdef)) return null;
    return { idx: [i, ...inputIdx], records: st.records };
  }
  if (!st.cov.has(gid)) return null;
  const rules = st.by === 'glyph'
    ? st.sets[st.cov.get(gid)]
    : st.sets[(st.inClass.get(gid) || 0)];
  if (!rules) return null;
  const inTest = st.by === 'glyph' ? byGlyph : byClassOf(st.inClass);
  const btTest = st.by === 'glyph' ? byGlyph : byClassOf(st.btClass || new Map());
  const laTest = st.by === 'glyph' ? byGlyph : byClassOf(st.laClass || new Map());
  for (const rule of rules) {
    if (rule.backtrack.length && !matchBackward(buf, i, rule.backtrack, btTest, lk, gdef)) continue;
    const inputIdx = matchForward(buf, i, rule.input, inTest, lk, gdef);
    if (!inputIdx) continue;
    const last = inputIdx.length ? inputIdx[inputIdx.length - 1] : i;
    if (rule.lookahead.length && !matchForward(buf, last, rule.lookahead, laTest, lk, gdef)) continue;
    return { idx: [i, ...inputIdx], records: rule.records };
  }
  return null;
}

/* Nested lookups, applied at the sequence positions the rule names.
 *
 * The subtlety the spec leaves implicit and HarfBuzz spells out in
 * hb-ot-layout-gsubgpos.hh `apply_lookup`: a nested lookup may lengthen or
 * shorten the buffer, so every input position after the one it fired on has
 * moved. Tracking that shift is the difference between a chained context that
 * builds ন্ত্র and one that builds ন্ত followed by a stray র.
 */
function applyRecords(ctx, buf, matched, records) {
  const idx = matched.slice();
  for (const rec of records) {
    if (rec.seqIdx >= idx.length) continue;
    const at = idx[rec.seqIdx];
    if (at < 0 || at >= buf.length) continue;
    const before = buf.length;
    const fired = applyAt(ctx, buf, at, ctx.table.lookups[rec.lookupIdx]);
    if (!fired) continue;
    const delta = buf.length - before;
    if (delta) for (let k = rec.seqIdx + 1; k < idx.length; k++) idx[k] += delta;
  }
  return idx;
}

/** Apply one lookup at one position. Returns the number of buffer positions
 *  to step forward (>=1) if something fired, or 0 if nothing matched. */
function applyAt(ctx, buf, i, lk) {
  if (!lk) return 0;
  const gdef = ctx.gdef;
  for (const st of lk.subtables) {
    if (st.kind === 'ctx') {
      const m = matchContext(st, buf, i, lk, gdef);
      if (!m) continue;
      const idx = applyRecords(ctx, buf, m.idx, m.records);
      const end = idx.length ? idx[idx.length - 1] : i;
      return Math.max(1, end - i + 1);
    }
    const g = buf[i];
    if (ctx.table.kind === 'GSUB') {
      const n = applySubst(ctx, buf, i, lk, st, g);
      if (n) return n;
    } else {
      const n = applyPos(ctx, buf, i, lk, st, g);
      if (n) return n;
    }
  }
  return 0;
}

function applySubst(ctx, buf, i, lk, st, g) {
  switch (st.type) {
    case 1: {
      if (!st.cov.has(g.gid)) return 0;
      const to = st.fmt === 1 ? (g.gid + st.delta) & 0xffff : st.subs[st.cov.get(g.gid)];
      if (to === g.gid) return 0;
      g.gid = to;
      return 1;
    }
    case 2: {
      if (!st.cov.has(g.gid)) return 0;
      const seq = st.sets[st.cov.get(g.gid)];
      if (!seq || !seq.length) return 0;
      buf.splice(i, 1, ...seq.map(gid => ({ ...g, gid })));
      return seq.length;
    }
    case 3: {
      if (!st.cov.has(g.gid)) return 0;
      const alts = st.sets[st.cov.get(g.gid)];
      if (!alts || !alts.length) return 0;
      /* No caller asks for a specific alternate, so the font's first is the
         one taken — the same choice a `aalt`-unaware renderer makes. */
      if (alts[0] === g.gid) return 0;
      g.gid = alts[0];
      return 1;
    }
    case 4: {
      if (!st.cov.has(g.gid)) return 0;
      const ligs = st.sets[st.cov.get(g.gid)];
      if (!ligs) return 0;
      for (const lig of ligs) {
        const idx = matchForward(buf, i, lig.components, byGlyph, lk, ctx.gdef);
        if (!idx) continue;
        /* The ligature takes the first component's slot and cluster. The
           components are removed back to front so the earlier indices stay
           valid, and any glyph the flag told us to skip over stays put —
           a matra caught between two halves of a conjunct must survive the
           substitution, not be eaten by it. */
        g.gid = lig.glyph;
        g.cl = Math.min(g.cl, ...idx.map(k => buf[k].cl));
        /* Recorded because the Indic model asks it later: a leading Ra has
           become a reph only if the font actually ligated it with its
           halant, and a reph that never formed must not be moved. */
        g.ligated = true;
        for (let k = idx.length - 1; k >= 0; k--) buf.splice(idx[k], 1);
        return 1;
      }
      return 0;
    }
    default: return 0;
  }
}

function applyPos(ctx, buf, i, lk, st, g) {
  switch (st.type) {
    case 1: {
      if (!st.cov.has(g.gid)) return 0;
      const v = st.fmt === 1 ? st.value : st.values[st.cov.get(g.gid)];
      if (!v) return 0;
      g.xOff += v.xPlacement; g.yOff += v.yPlacement; g.xAdv += v.xAdvance;
      return 1;
    }
    case 2: {
      if (!st.cov.has(g.gid)) return 0;
      const j = nextPos(buf, i, lk, ctx.gdef);
      if (j < 0) return 0;
      const second = buf[j];
      let pair = null;
      if (st.fmt === 1) {
        const set = st.sets[st.cov.get(g.gid)];
        pair = set && set.get(second.gid);
      } else {
        const c1 = st.cd1.get(g.gid) || 0, c2 = st.cd2.get(second.gid) || 0;
        pair = st.grid[c1] && st.grid[c1][c2];
      }
      if (!pair) return 0;
      g.xOff += pair[0].xPlacement; g.yOff += pair[0].yPlacement; g.xAdv += pair[0].xAdvance;
      second.xOff += pair[1].xPlacement; second.yOff += pair[1].yPlacement; second.xAdv += pair[1].xAdvance;
      /* When the subtable carries no second value record the pass restarts on
         the second glyph, so a run of three kerns twice rather than once. */
      return st.hasV2 ? (j - i + 1) : Math.max(1, j - i);
    }
    case 4: case 6: {
      /* Mark to base, and mark to mark. The mark is the glyph at `i`; the
         thing it hangs on is the previous glyph the flag does not skip —
         for type 4 that is a base or ligature, for type 6 another mark. */
      if (!st.markCov.has(g.gid)) return 0;
      let j = -1;
      if (st.type === 4) {
        for (let k = i - 1; k >= 0; k--) {
          const cls = ctx.gdef ? (ctx.gdef.classes.get(buf[k].gid) || 0) : 0;
          if (cls === GLYPH_MARK) continue;
          j = k; break;
        }
      } else {
        j = prevPos(buf, i, lk, ctx.gdef);
      }
      if (j < 0) return 0;
      if (!st.baseCov.has(buf[j].gid)) return 0;
      const mark = st.marks[st.markCov.get(g.gid)];
      const row = st.bases[st.baseCov.get(buf[j].gid)];
      if (!mark || !mark.anchor || !row) return 0;
      const anchor = row[mark.cls];
      if (!anchor) return 0;
      g.xOff = anchor.x - mark.anchor.x;
      g.yOff = anchor.y - mark.anchor.y;
      g.attach = j - i;
      return 1;
    }
    case 5: {
      if (!st.markCov.has(g.gid)) return 0;
      let j = -1;
      for (let k = i - 1; k >= 0; k--) {
        const cls = ctx.gdef ? (ctx.gdef.classes.get(buf[k].gid) || 0) : 0;
        if (cls === GLYPH_MARK) continue;
        j = k; break;
      }
      if (j < 0 || !st.ligCov.has(buf[j].gid)) return 0;
      const mark = st.marks[st.markCov.get(g.gid)];
      const attach = st.ligs[st.ligCov.get(buf[j].gid)];
      if (!mark || !mark.anchor || !attach || !attach.length) return 0;
      /* Which component of the ligature the mark belongs to is carried on the
         glyph by the substitution that made the ligature; absent that, the
         last component is the conventional answer. */
      const comp = Math.min(attach.length - 1, Math.max(0, (g.ligComp || 0)));
      const anchor = attach[comp] && attach[comp][mark.cls];
      if (!anchor) return 0;
      g.xOff = anchor.x - mark.anchor.x;
      g.yOff = anchor.y - mark.anchor.y;
      g.attach = j - i;
      return 1;
    }
    default: return 0;
  }
}

/** Run one lookup over a whole buffer, left to right, honouring per-glyph
 *  feature masks. A glyph whose mask does not carry this lookup's bit is not
 *  a candidate — that is how `half` reaches the pre-base consonants and
 *  `pstf` reaches only what follows the base. */
export function runLookup(ctx, buf, lookupIndex, mask) {
  const lk = ctx.table.lookups[lookupIndex];
  if (!lk) return;
  let i = 0;
  while (i < buf.length) {
    const g = buf[i];
    if (!(g.mask & mask) || skipped(lk, g, ctx.gdef)) { i++; continue; }
    const n = applyAt(ctx, buf, i, lk);
    i += n > 0 ? n : 1;
  }
}

/** Would applying any of these lookups to exactly this glyph sequence
 *  substitute something at position 0?
 *
 *  This is HarfBuzz's `would_substitute` (hb-ot-layout.cc), and it is how the
 *  shaper asks the font — rather than a table in this repository — whether a
 *  given consonant has a below-base or a post-base form. The four Bangla
 *  families disagree about that, so asking is the only answer that is right
 *  for all of them.
 */
export function wouldSubstitute(table, lookupIndices, glyphs) {
  for (const li of lookupIndices) {
    const lk = table.lookups[li];
    if (!lk) continue;
    for (const st of lk.subtables) if (wouldApply(st, glyphs)) return true;
  }
  return false;
}

function wouldApply(st, glyphs) {
  if (!glyphs.length) return false;
  if (st.kind === 'ctx') {
    if (st.by === 'coverage') {
      if (st.backtrack.length || st.lookahead.length) return false;
      if (st.input.length !== glyphs.length) return false;
      return st.input.every((cov, k) => cov.has(glyphs[k]));
    }
    if (!st.cov.has(glyphs[0])) return false;
    const rules = st.by === 'glyph' ? st.sets[st.cov.get(glyphs[0])] : st.sets[st.inClass.get(glyphs[0]) || 0];
    if (!rules) return false;
    const test = st.by === 'glyph' ? byGlyph : byClassOf(st.inClass);
    return rules.some(r => !r.backtrack.length && !r.lookahead.length &&
                           r.input.length === glyphs.length - 1 &&
                           r.input.every((want, k) => test(want, glyphs[k + 1])));
  }
  switch (st.type) {
    case 1: case 2: case 3:
      return glyphs.length === 1 && st.cov.has(glyphs[0]);
    case 4: {
      if (!st.cov.has(glyphs[0])) return false;
      const ligs = st.sets[st.cov.get(glyphs[0])] || [];
      return ligs.some(l => l.components.length === glyphs.length - 1 &&
                            l.components.every((c, k) => c === glyphs[k + 1]));
    }
    default: return false;
  }
}
