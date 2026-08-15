/* The Bengali shaper — the Indic cluster model, run against the font's own
 * GSUB and GPOS tables.
 *
 * Bengali is written in orthographic syllables, not in letters. ক + ্ + ষ is
 * one glyph (ক্ষ) and not three; ি is typed after the consonant it is drawn
 * before; র before a halant leaves its own place and rides the top of the
 * cluster as a reph. So the sequence of glyphs that gets outlined is not the
 * sequence of codepoints that was typed, and deriving one from the other is
 * this file's whole job.
 *
 * What it implements
 * ------------------
 * The `<bng2>` shaping model in six stages, as documented in Microsoft's
 * "Developing OpenType Fonts for Bengali Script"
 * (learn.microsoft.com/en-us/typography/script-development/bengali) and, in
 * the more precise restatement this file was written against, Nathan
 * Willis's opentype-shaping-documents/opentype-shaping-bengali.md. Where
 * those two describe an outcome without pinning down the mechanism — chiefly
 * which glyphs a feature is allowed to touch, and how the base consonant
 * search treats a consonant that has a below-base form — the reference was
 * HarfBuzz's hb-ot-shaper-indic.cc, which is what Chromium runs and therefore
 * what the customer saw on the preview.
 *
 * Stage 1  identify the syllable
 * Stage 2  initial reordering — find the base, tag every glyph with a sort
 *          position, move the pre-base matra and the reph, sort
 * Stage 3  the basic substitutions, one feature at a time, in order:
 *          locl ccmp nukt akhn rphf blwf half pstf vatu cjct
 * Stage 4  final reordering — put the pre-base matra and the reph where the
 *          substitutions have left room for them
 * Stage 5  the presentation substitutions: init pres abvs blws psts haln
 * Stage 6  positioning: dist abvm blwm kern mark mkmk
 *
 * What it deliberately does not implement, and refuses instead
 * -----------------------------------------------------------
 * A cluster the grammar does not recognise. HarfBuzz's answer there is to
 * insert a dotted circle and shape around it, which is right for a text
 * editor and wrong for a press: it prints a placeholder onto 500 cards. The
 * answer here is to refuse and name the offending characters, on the same
 * reasoning `text.mjs` refuses a missing glyph rather than drawing .notdef.
 *
 * Pre-base-reordering Ra (the `pref` feature) is not implemented because
 * Bengali does not use it — none of the four vendored families ships the
 * feature. Vedic extensions, Assamese-specific `locl` selection by language
 * tag, and the `cfar`/`abvf` features are likewise absent from Bengali and
 * from these fonts.
 */
import { layoutFor, wouldSubstitute, runLookup } from './otlayout.mjs';
import { refuse } from './refusal.mjs';

/* ── The character table ────────────────────────────────────────────────
   Categories are Unicode's, not this repository's: they are transcribed from
   IndicSyllabicCategory.txt and IndicPositionalCategory.txt in the UCD, which
   is where HarfBuzz gets them too. That is a table of what the characters
   *are*, which is fixed and public; the table of what a cluster *becomes* is
   the font's, and this file never writes one down. */

const CAT = {
  OTHER: 0, C: 1, V: 2, N: 3, H: 4, ZWNJ: 5, ZWJ: 6, M: 7, SM: 8, A: 9,
  PLACEHOLDER: 10, DOTTEDCIRCLE: 11, Ra: 12, SYMBOL: 13
};

/* The sort positions, in the order Stage 2 sorts them into. Named as the
   shaping document names them so the two can be read side by side. */
const POS = {
  RA_TO_BECOME_REPH: 1, PREBASE_MATRA: 2, PREBASE_CONSONANT: 3, SYLLABLE_BASE: 4,
  AFTER_MAIN: 5, ABOVEBASE_CONSONANT: 6, BEFORE_SUBJOINED: 7, BELOWBASE_CONSONANT: 8,
  AFTER_SUBJOINED: 9, BEFORE_POST: 10, POSTBASE_CONSONANT: 11, AFTER_POST: 12,
  FINAL_CONSONANT: 13, SMVD: 14
};

const RANGE = (lo, hi, cat, pos) => ({ lo, hi, cat, pos });

/* Bengali block, U+0980..U+09FE. Every row is a line of the UCD; the `pos`
   column is the Indic positional category, which only matras use. */
const TABLE = [
  RANGE(0x0980, 0x0980, CAT.PLACEHOLDER, 0),           // ANJI
  RANGE(0x0981, 0x0981, CAT.SM, 0),                    // CANDRABINDU (Top)
  RANGE(0x0982, 0x0983, CAT.SM, 0),                    // ANUSVARA, VISARGA (Right)
  RANGE(0x0985, 0x098C, CAT.V, 0),
  RANGE(0x098F, 0x0990, CAT.V, 0),
  RANGE(0x0993, 0x0994, CAT.V, 0),
  RANGE(0x0995, 0x09A8, CAT.C, 0),                     // KA..NA
  RANGE(0x09AA, 0x09AF, CAT.C, 0),                     // PA..YA
  RANGE(0x09B0, 0x09B0, CAT.Ra, 0),                    // RA
  RANGE(0x09B2, 0x09B2, CAT.C, 0),                     // LA
  RANGE(0x09B6, 0x09B9, CAT.C, 0),                     // SHA..HA
  RANGE(0x09BC, 0x09BC, CAT.N, 0),                     // NUKTA
  RANGE(0x09BD, 0x09BD, CAT.A, 0),                     // AVAGRAHA
  RANGE(0x09BE, 0x09BE, CAT.M, POS.AFTER_POST),        // AA   (Right)
  RANGE(0x09BF, 0x09BF, CAT.M, POS.PREBASE_MATRA),     // I    (Left)
  RANGE(0x09C0, 0x09C0, CAT.M, POS.AFTER_POST),        // II   (Right)
  RANGE(0x09C1, 0x09C4, CAT.M, POS.AFTER_SUBJOINED),   // U..VOCALIC RR (Bottom)
  RANGE(0x09C7, 0x09C8, CAT.M, POS.PREBASE_MATRA),     // E, AI (Left)
  RANGE(0x09CD, 0x09CD, CAT.H, 0),                     // VIRAMA
  RANGE(0x09CE, 0x09CE, CAT.C, 0),                     // KHANDA TA (a dead consonant)
  RANGE(0x09D7, 0x09D7, CAT.M, POS.AFTER_POST),        // AU LENGTH MARK (Right)
  RANGE(0x09DC, 0x09DD, CAT.C, 0),                     // RRA, RHA
  RANGE(0x09DF, 0x09DF, CAT.C, 0),                     // YYA
  RANGE(0x09E0, 0x09E1, CAT.V, 0),
  RANGE(0x09E2, 0x09E3, CAT.M, POS.AFTER_SUBJOINED),   // VOCALIC L, LL (Bottom)
  RANGE(0x09E6, 0x09EF, CAT.PLACEHOLDER, 0),           // digits
  RANGE(0x09F0, 0x09F0, CAT.Ra, 0),                    // RA WITH MIDDLE DIAGONAL (Assamese ra)
  RANGE(0x09F1, 0x09F1, CAT.C, 0),                     // RA WITH LOWER DIAGONAL
  RANGE(0x09F2, 0x09FB, CAT.SYMBOL, 0),                // currency and fraction signs, incl. ৳
  RANGE(0x09FC, 0x09FC, CAT.SM, 0),                    // VEDIC ANUSVARA
  RANGE(0x09FD, 0x09FD, CAT.SYMBOL, 0),                // ABBREVIATION SIGN
  RANGE(0x09FE, 0x09FE, CAT.SM, 0)                     // SANDHI MARK
];

/* The two-part matras. Both are canonical decompositions in Unicode — ো is
   U+09C7 U+09BE and ৌ is U+09C7 U+09D7 — and the shaper splits them because
   the halves sit on opposite sides of the cluster and are reordered apart.
   The precomposed ligatures RRA, RHA and YYA are canonical decompositions
   too and are deliberately NOT split: fonts draw them as single glyphs. */
const TWO_PART = new Map([[0x09CB, [0x09C7, 0x09BE]], [0x09CC, [0x09C7, 0x09D7]]]);

/* Default-ignorable codepoints, per Unicode's Default_Ignorable_Code_Point
 * property. They take part in shaping — a ZWNJ is the whole reason a conjunct
 * does not form — and then they must not be drawn.
 *
 * This matters because a font may well have a *visible* glyph for one. Hind
 * Siliguri draws ZWNJ as a vertical bar and ZWJ as a small cross, which are
 * plainly meant for a type designer's proof sheet; outlining them puts those
 * marks on the card. HarfBuzz hides them at the end of shaping
 * (`hb_ot_hide_default_ignorables`) and so the browser preview never showed
 * one, which is how this was found: the letters agreed with Chromium exactly
 * and there was an extra stroke standing between them.
 */
export function isDefaultIgnorable(cp) {
  if (cp < 0x00ad) return false;
  return cp === 0x00ad || cp === 0x034f || cp === 0x061c ||
    (cp >= 0x115f && cp <= 0x1160) || (cp >= 0x17b4 && cp <= 0x17b5) ||
    (cp >= 0x180b && cp <= 0x180e) || (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff ||
    cp === 0xffa0 || (cp >= 0xfff0 && cp <= 0xfff8) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff);
}

function classify(cp) {
  if (cp === 0x200c) return { cat: CAT.ZWNJ, pos: 0 };
  if (cp === 0x200d) return { cat: CAT.ZWJ, pos: 0 };
  if (cp === 0x25cc) return { cat: CAT.DOTTEDCIRCLE, pos: 0 };
  for (const r of TABLE) if (cp >= r.lo && cp <= r.hi) return { cat: r.cat, pos: r.pos };
  return { cat: CAT.OTHER, pos: 0 };
}

const isConsonant = g => g.cat === CAT.C || g.cat === CAT.Ra ||
                         g.cat === CAT.PLACEHOLDER || g.cat === CAT.DOTTEDCIRCLE || g.cat === CAT.V;
const isJoiner = g => g.cat === CAT.ZWJ || g.cat === CAT.ZWNJ;
const isHalant = g => g.cat === CAT.H;

/* ── Stage 1: syllables ─────────────────────────────────────────────────
   The grammar is the one in the shaping document, reduced to the productions
   Bengali actually reaches. It is written as a scanner rather than a regex
   over category codes because the failure this whole file exists to prevent
   is a silent one, and a scanner can say which character it choked on.

     consonant syllable  (Ra H)? (CN halant-group)* CN halant-or-matra tail
     vowel syllable      (Ra H)? V N? (halant-group CN)* halant-or-matra tail
     standalone          placeholder | dotted circle, then as above
     symbol cluster      symbol tail
*/
function syllables(glyphs) {
  const out = [];
  let i = 0;
  while (i < glyphs.length) {
    const start = i;
    const g = glyphs[i];
    if (g.cat === CAT.OTHER) {
      /* Latin, punctuation, spaces — not this shaper's business, but they
         travel through so the run keeps its order. */
      while (i < glyphs.length && glyphs[i].cat === CAT.OTHER) i++;
      out.push({ start, end: i, kind: 'other' });
      continue;
    }
    if (g.cat === CAT.SYMBOL) {
      i++;
      i = eatTail(glyphs, i);
      out.push({ start, end: i, kind: 'symbol' });
      continue;
    }
    if (isJoiner(g)) {
      /* A joiner that did not attach to a cluster is passed through rather
         than refused. ZWJ and ZWNJ are zero-width instructions about how the
         letters around them should combine, and Bengali writers use them on
         purpose — a ZWNJ between two consonants is how somebody spells a name
         that must not take a conjunct. Refusing one would refuse text that is
         correct; drawing one costs nothing, because there is nothing to draw. */
      while (i < glyphs.length && isJoiner(glyphs[i])) i++;
      out.push({ start, end: i, kind: 'other' });
      continue;
    }
    if (g.cat === CAT.SM || g.cat === CAT.A || g.cat === CAT.M ||
        g.cat === CAT.H || g.cat === CAT.N) {
      /* A syllable cannot open on a vowel sign, a halant or a nukta. This is
         the "broken cluster" of the shaping document, and it is where a
         shaper for a screen inserts a dotted circle. Refusing is the
         print-safe answer. */
      out.push({ start, end: i + 1, kind: 'broken' });
      i++;
      continue;
    }

    /* Independent vowels, digits and the dotted circle all count as
       consonants for the grammar's purposes — they can carry a matra and can
       be the base — so one loop covers the consonant, vowel and standalone
       productions rather than three near-copies. */
    let ok = false;
    if (isConsonant(glyphs[i])) {
      /* (CN halant-group)* CN */
      for (;;) {
        i++;                                                   // the consonant
        if (i < glyphs.length && glyphs[i].cat === CAT.N) i++;  // its nukta
        const save = i;
        if (i < glyphs.length && isJoiner(glyphs[i])) i++;
        if (i < glyphs.length && isHalant(glyphs[i])) {
          i++;
          if (i < glyphs.length && isJoiner(glyphs[i])) i++;
          if (i < glyphs.length && glyphs[i].cat === CAT.N) i++;
          if (i < glyphs.length && isConsonant(glyphs[i])) continue;
          /* A trailing halant with nothing after it is a legitimate ending —
             it is what makes a khanda-ta or an explicit virama. */
          ok = true;
          break;
        }
        i = save;
        ok = true;
        break;
      }
    }
    if (!ok) { out.push({ start, end: Math.max(i + 1, start + 1), kind: 'broken' }); i = Math.max(i + 1, start + 1); continue; }

    /* halant-or-matra group: matras, each optionally followed by nukta and
       halant, then the syllable tail. */
    for (;;) {
      const save = i;
      while (i < glyphs.length && isJoiner(glyphs[i])) i++;
      if (i < glyphs.length && glyphs[i].cat === CAT.M) {
        i++;
        if (i < glyphs.length && glyphs[i].cat === CAT.N) i++;
        if (i < glyphs.length && isHalant(glyphs[i])) i++;
        continue;
      }
      i = save;
      break;
    }
    i = eatTail(glyphs, i);
    out.push({ start, end: i, kind: 'syllable' });
  }
  return out;
}

function eatTail(glyphs, i) {
  if (i < glyphs.length && isJoiner(glyphs[i]) &&
      i + 1 < glyphs.length && glyphs[i + 1].cat === CAT.SM) i++;
  while (i < glyphs.length && (glyphs[i].cat === CAT.SM || glyphs[i].cat === CAT.A)) i++;
  return i;
}

/* ── The plan: which lookups each feature owns, for this face ───────────── */

const BASIC = ['locl', 'ccmp', 'nukt', 'akhn', 'rphf', 'blwf', 'half', 'pstf', 'vatu', 'cjct'];
/* The shaping document lists six presentation features; the last four here
   are the script-independent ones every shaper enables alongside them, and
   they are not optional decoration. Tiro Bangla draws a shorter আ-কার after
   certain letters through `rclt`, and leaving it out was visible as a sliver
   of the wrong outline on every word ending in া. `liga` is deliberately
   absent: HarfBuzz disables it for Indic, because a Latin-style ligature
   fired inside a conjunct is a different word. */
const PRESENTATION = ['init', 'pres', 'abvs', 'blws', 'psts', 'haln',
                      'rlig', 'clig', 'calt', 'rclt'];
const POSITIONING = ['dist', 'abvm', 'blwm', 'kern', 'mark', 'mkmk'];

/* Only these are restricted to the glyphs stage 2 flagged for them; the rest
   run over the whole syllable, which is what HarfBuzz does and what the fonts
   are built expecting. Bit 0 is the "everything else" bit every glyph carries
   from the start, and it is deliberately disjoint from the five below — a
   global bit that overlapped `half` would hand every consonant in the
   syllable a half form, and ব্য would come out as ব্ য rather than ব with a
   ya-phala. That is a wrong word, not a wrong ornament. */
const GLOBAL = 1;
const MASKED = { rphf: 2, blwf: 4, half: 8, pstf: 16, init: 32 };

const _plans = new WeakMap();

/** The shaping plan for a face: which lookup indices each feature resolves
 *  to, and the glyph ids of the virama and of Ra, which the base-consonant
 *  search needs to interrogate the font with. Cached per face. */
export function planFor(face) {
  const cached = _plans.get(face);
  if (cached) return cached;

  const L = layoutFor(face);
  if (!L.gsub)
    return fail(face, 'no_gsub', `${face.family} carries no GSUB table, so it holds no Bengali shaping rules at all.`);

  /* `bng2` is the OpenType 1.5 Indic script tag and `beng` the older one; a
     font that offers both means the bng2 rules and expects those to be used.
     Preferring bng2 is what HarfBuzz does and what the browser preview did. */
  const ls = L.gsub.langSys(['bng2', 'beng'], null);
  if (!ls)
    return fail(face, 'no_bengali_script',
      `${face.family} has a GSUB table but registers no 'bng2' or 'beng' script in it.`);

  const gsubFeat = {}, gposFeat = {};
  for (const f of [...BASIC, ...PRESENTATION]) gsubFeat[f] = L.gsub.lookupsFor(ls, f);
  const posLs = L.gpos ? L.gpos.langSys(['bng2', 'beng', 'DFLT'], null) : null;
  for (const f of POSITIONING) gposFeat[f] = L.gpos && posLs ? L.gpos.lookupsFor(posLs, f) : [];

  /* House rule: an extractor that finds nothing must fail. A Bengali font
     with no substitution lookups reachable from its own script is not a font
     this writer can shape with — it would produce a run of disconnected
     letters and call it success, which is the exact failure the refusal in
     text.mjs was put there to prevent. */
  const reachable = Object.values(gsubFeat).reduce((n, a) => n + a.length, 0);
  if (reachable === 0)
    return fail(face, 'no_shaping_lookups',
      `${face.family} registers the '${ls.script}' script but none of the Bengali shaping features ` +
      `(${[...BASIC, ...PRESENTATION].join(', ')}) resolve to a lookup in it.`);

  /* A lookup this reader could not parse is a rule that will not fire, and a
     rule that does not fire is a conjunct that does not form. Named here
     rather than discovered as a wrong glyph on a printed card. */
  const broken = [];
  for (const t of ['gsub', 'gpos'])
    if (L[t]) for (const lk of L[t].lookups) if (lk.unreadable) broken.push(lk.unreadable);
  if (broken.length)
    return fail(face, 'unreadable_lookup',
      `${face.family} contains layout subtables this writer cannot read: ${broken.slice(0, 3).join('; ')}` +
      `${broken.length > 3 ? ` (and ${broken.length - 3} more)` : ''}.`);

  const plan = {
    face, gsub: L.gsub, gpos: L.gpos, gdef: L.gdef, script: ls.script,
    gsubFeat, gposFeat,
    virama: face.glyphIdFor(0x09CD),
    ra: face.glyphIdFor(0x09B0)
  };
  _plans.set(face, plan);
  return plan;
}

function fail(face, code, message) {
  refuse(`bangla_${code}`,
    `${message} Bangla cannot be outlined from this face without inventing the rules, so it is refused ` +
    `rather than printed. Choose another Bangla type system for this card.`);
}

/* ── Stage 2, step 1: does this consonant have a below- or post-base form? ─
   Asked of the font, never of a table in this repository. HarfBuzz's
   `consonant_position_from_face` matches both orderings — Virama,Consonant
   (the bng2 order) and Consonant,Virama (the beng order) — because fonts
   exist that copied their lookups from one spec to the other without
   reordering them, and Uniscribe honours those. The four families here
   include one of each convention, so both are asked. */
function consonantPosition(plan, gid) {
  if (!plan.virama) return POS.SYLLABLE_BASE;
  const pair = [plan.virama, gid], flipped = [gid, plan.virama];
  if (wouldSubstitute(plan.gsub, plan.gsubFeat.blwf, pair) ||
      wouldSubstitute(plan.gsub, plan.gsubFeat.blwf, flipped)) return POS.BELOWBASE_CONSONANT;
  if (wouldSubstitute(plan.gsub, plan.gsubFeat.pstf, pair) ||
      wouldSubstitute(plan.gsub, plan.gsubFeat.pstf, flipped)) return POS.POSTBASE_CONSONANT;
  return POS.SYLLABLE_BASE;
}

/* ── Stage 2: initial reordering ────────────────────────────────────────── */

function initialReorder(plan, buf) {
  const n = buf.length;

  /* Adjacent Halant,Nukta is repositioned so the nukta comes first — the
     canonical order the fonts' lookups are written against. */
  for (let i = 0; i + 1 < n; i++)
    if (buf[i].cat === CAT.H && buf[i + 1].cat === CAT.N) {
      const t = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = t;
    }

  for (const g of buf) {
    if (isConsonant(g)) g.pos = consonantPosition(plan, g.gid);
    else if (g.cat === CAT.M) g.pos = g.matraPos;
    else if (g.cat === CAT.SM || g.cat === CAT.A || g.cat === CAT.SYMBOL) g.pos = POS.SMVD;
    else g.pos = POS.SYLLABLE_BASE;
  }

  /* Step 1 — the base consonant, searched from the end backwards.
     Bengali is BASE_POS_LAST: the base is the last consonant that has neither
     a below-base nor a post-base form, post-base forms only counting once a
     below-base one has been seen. */
  let limit = 0, base = n, hasReph = false;
  if (plan.gsubFeat.rphf.length && n >= 3 &&
      buf[0].cat === CAT.Ra && buf[1].cat === CAT.H && !isJoiner(buf[2]) &&
      wouldSubstitute(plan.gsub, plan.gsubFeat.rphf, [buf[0].gid, buf[1].gid])) {
    limit = 2;
    while (limit < n && isJoiner(buf[limit])) limit++;
    base = 0;
    hasReph = true;
  }

  {
    let i = n, seenBelow = false;
    do {
      i--;
      if (isConsonant(buf[i])) {
        if (buf[i].pos !== POS.BELOWBASE_CONSONANT &&
            (buf[i].pos !== POS.POSTBASE_CONSONANT || seenBelow)) { base = i; break; }
        if (buf[i].pos === POS.BELOWBASE_CONSONANT) seenBelow = true;
        base = i;
      } else if (i > 0 && buf[i].cat === CAT.ZWJ && buf[i - 1].cat === CAT.H) {
        /* A ZWJ after a halant stops the search and asks for an explicit
           half form of what precedes it. */
        break;
      }
    } while (i > limit);
  }
  if (base > n) base = n;

  /* A leading Ra,Halant with no other consonant behind it is not a reph;
     the Ra is simply the base. */
  if (hasReph && base === 0 && limit - base <= 2) hasReph = false;

  /* Step 3 onwards — tag positions relative to the base. */
  for (let i = 0; i < base; i++) buf[i].pos = Math.min(POS.PREBASE_CONSONANT, buf[i].pos);
  if (base < n) buf[base].pos = POS.SYLLABLE_BASE;

  /* A consonant that follows a matra is a final consonant, not a subjoined
     one. Bengali reaches this through ্য after a vowel sign. */
  for (let i = base + 1; i < n; i++) {
    if (buf[i].cat !== CAT.M) continue;
    for (let j = i + 1; j < n; j++)
      if (isConsonant(buf[j])) { buf[j].pos = POS.FINAL_CONSONANT; break; }
    break;
  }

  if (hasReph) buf[0].pos = POS.RA_TO_BECOME_REPH;

  /* Halants, nuktas and joiners travel with the character they modify, so
     they take its sort position and stay glued to it through the sort. */
  {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const g = buf[i];
      if (g.cat === CAT.H || g.cat === CAT.N || isJoiner(g)) {
        g.pos = last;
        if (g.cat === CAT.H && g.pos === POS.PREBASE_MATRA) {
          /* A halant is not carried leftwards by a pre-base matra: the matra
             moves and the halant stays with its consonant. */
          for (let j = i; j > 0; j--)
            if (buf[j - 1].pos !== POS.PREBASE_MATRA) { g.pos = buf[j - 1].pos; break; }
        }
      } else if (g.pos !== POS.SMVD) {
        last = g.pos;
      }
    }
  }

  /* A post-base consonant owns everything between it and the previous
     consonant or matra, so a halant does not get sorted away from the
     subjoined form it produces. */
  {
    let last = base;
    for (let i = base + 1; i < n; i++) {
      if (isConsonant(buf[i])) {
        for (let j = last + 1; j < i; j++) if (buf[j].pos < POS.SMVD) buf[j].pos = buf[i].pos;
        last = i;
      } else if (buf[i].cat === CAT.M) last = i;
    }
  }

  /* Step 9 — the sort. Stable, so equal positions keep the order they were
     typed in, which is what keeps a two-consonant conjunct in the right
     order after both have been tagged POS_BELOWBASE_CONSONANT. */
  stableSortByPos(buf);

  base = buf.findIndex(g => g.pos === POS.SYLLABLE_BASE);
  if (base < 0) base = buf.length;

  /* Step 10 — the feature masks. `rphf` reaches only the Ra that is becoming
     a reph; `half` and `blwf` reach the pre-base consonants (Bengali is
     BLWF_MODE_PRE_AND_POST, so below-forms are sought on both sides); `blwf`
     and `pstf` reach what follows the base. */
  for (let i = 0; i < buf.length && buf[i].pos === POS.RA_TO_BECOME_REPH; i++)
    buf[i].mask |= MASKED.rphf;
  for (let i = 0; i < base; i++) buf[i].mask |= MASKED.half | MASKED.blwf;
  for (let i = base + 1; i < buf.length; i++) buf[i].mask |= MASKED.blwf | MASKED.pstf;

  /* A ZWNJ asks for the half form to be suppressed on everything back to the
     previous consonant — that is the whole reason someone types one. */
  for (let i = 1; i < buf.length; i++) {
    if (buf[i].cat !== CAT.ZWNJ) continue;
    let j = i;
    do { j--; buf[j].mask &= ~MASKED.half; } while (j > 0 && !isConsonant(buf[j]));
  }

  return { base, hasReph };
}

function stableSortByPos(buf) {
  const idx = buf.map((g, i) => [g, i]);
  idx.sort((a, b) => (a[0].pos - b[0].pos) || (a[1] - b[1]));
  for (let i = 0; i < buf.length; i++) buf[i] = idx[i][0];
}

/* ── Stage 4: final reordering ──────────────────────────────────────────── */

function finalReorder(plan, buf, atWordStart) {
  const n = buf.length;
  if (!n) return;

  /* Find the base again. The substitutions have run, so a glyph that was a
     halant may now be part of a conjunct; the position tags survived. */
  let base = 0;
  for (; base < n; base++)
    if (buf[base].pos >= POS.SYLLABLE_BASE) {
      if (base > 0 && buf[base].pos > POS.SYLLABLE_BASE) base--;
      break;
    }
  if (base === n && n > 0 && buf[n - 1].cat !== CAT.ZWJ) base--;
  while (base > 0 && (buf[base].cat === CAT.H || isJoiner(buf[base]))) base--;

  /* Step 2 — the pre-base matra moves right, to just after the last
     standalone halant that stands between where it was put and the base. A
     matra typed before a half form is drawn after that half form. */
  if (n > 1 && base > 0) {
    let newPos = base === n ? base - 2 : base - 1;
    while (newPos > 0 && !(buf[newPos].cat === CAT.M || buf[newPos].cat === CAT.H)) newPos--;
    if (buf[newPos] && isHalant(buf[newPos]) && buf[newPos].pos !== POS.PREBASE_MATRA) {
      if (newPos + 1 < n && isJoiner(buf[newPos + 1])) newPos++;
    } else {
      newPos = 0;
    }
    if (newPos > 0 && buf[newPos - 1].pos !== POS.PREBASE_MATRA) {
      for (let i = newPos; i > 0; i--) {
        if (buf[i - 1].pos !== POS.PREBASE_MATRA) continue;
        const old = i - 1;
        const g = buf[old];
        buf.splice(old, 1);
        buf.splice(newPos, 0, g);
        if (old < base && base <= newPos) base--;
        newPos--;
      }
    }
  }

  /* Step 3 — the reph. Bengali's reph sits after the below-base forms
     (REPH_POS_AFTER_SUBJOINED), reached by the numbered search below. If the
     reph glyph is still followed by its own halant then the font did not
     ligate it into a reph at all, and moving it would be wrong. */
  if (n > 1 && buf[0].pos === POS.RA_TO_BECOME_REPH && buf[0].ligated) {
    let target = -1;

    /* 1. the first explicit halant between the reph and the base */
    for (let i = 1; i < base; i++)
      if (isHalant(buf[i])) { target = i; break; }
    /* 2. and past a joiner that follows it */
    if (target >= 0 && target + 1 < n && isJoiner(buf[target + 1])) target++;

    /* 3. otherwise before the first post-base consonant that did not ligate
          into the base */
    if (target < 0) {
      for (let i = base + 1; i < n; i++)
        if (isConsonant(buf[i])) { target = i - 1; break; }
    }
    /* 4. otherwise before the first post-base matra or syllable modifier */
    if (target < 0) {
      for (let i = base + 1; i < n; i++)
        if (buf[i].pos >= POS.BEFORE_POST) { target = i - 1; break; }
    }
    /* 5. otherwise the end of the syllable */
    if (target < 0) target = n - 1;

    /* 6. and never to the right of a matra's own halant */
    if (target > 0 && isHalant(buf[target]) && buf[target - 1].cat === CAT.M) target--;

    if (target > 0) {
      const reph = buf.shift();
      buf.splice(target, 0, reph);
    }
  }

  /* Step 5 — a left-side matra that opens a word gets the `init` variant,
     which is why ই-কার at the start of a word is drawn differently from the
     same sign mid-word in the faces that bother to draw it differently. */
  if (atWordStart && buf.length && buf[0].pos === POS.PREBASE_MATRA) buf[0].mask |= MASKED.init;
}

/* ── Running the features ───────────────────────────────────────────────── */

function runFeature(plan, buf, table, lookups, mask) {
  if (!lookups.length) return;
  const ctx = { table, gdef: plan.gdef };
  /* Lookups within one feature run in the order the font lists them, which
     is the order the font's author intended them to compose in. */
  for (const li of lookups) runLookup(ctx, buf, li, mask);
}

function runStage(plan, buf, table, features, featureLookups) {
  /* Several features may share a lookup, and within a stage OpenType applies
     lookups in lookup-list order rather than feature order. Collecting the
     masks first and sorting by lookup index is what HarfBuzz does and what
     the fonts are built against. */
  const byLookup = new Map();
  for (const f of features) {
    const mask = MASKED[f] || GLOBAL;
    for (const li of featureLookups[f] || []) byLookup.set(li, (byLookup.get(li) || 0) | mask);
  }
  const ctx = { table, gdef: plan.gdef };
  for (const li of [...byLookup.keys()].sort((a, b) => a - b)) runLookup(ctx, buf, li, byLookup.get(li));
}

/* ── The public entry point ─────────────────────────────────────────────── */

/** Shape one run of text with one face.
 *
 *  Returns `[{ gid, xAdvance, xOffset, yOffset, cluster }]` in font units,
 *  in visual order left to right. Non-Bengali characters travel through
 *  unshaped, which keeps a bilingual line — "Rahim Traders / রহিম ট্রেডার্স"
 *  — in one run rather than two.
 */
export function shapeBengali(text, face) {
  const plan = planFor(face);
  const cps = [...String(text)];

  /* Normalisation: split the two-part matras before anything is categorised,
     because their halves belong on opposite sides of the cluster. */
  const glyphs = [];
  cps.forEach((ch, ci) => {
    const cp = ch.codePointAt(0);
    const parts = TWO_PART.get(cp) || [cp];
    for (const part of parts) {
      const { cat, pos } = classify(part);
      glyphs.push({
        gid: face.glyphIdFor(part), cp: part, cl: ci, cat, matraPos: pos, pos: 0,
        mask: GLOBAL, xAdv: 0, xOff: 0, yOff: 0, attach: 0, ligated: false
      });
    }
  });

  /* A default-ignorable with no glyph in the face is not a missing glyph —
     it is a character that will not be drawn either way. It stays in the
     buffer so the cluster model can see it, and leaves before anything is
     outlined. */
  const missing = glyphs.filter(g => !g.gid && !isDefaultIgnorable(g.cp));
  if (missing.length) {
    const hex = missing.map(g => 'U+' + g.cp.toString(16).toUpperCase().padStart(4, '0'));
    refuse('glyph_missing',
      `${face.family} ${face.weight} has no glyph for ${[...new Set(hex)].join(', ')}. The vendored ` +
      `subset in assets/fonts does not cover this character, and a press file must never fall back ` +
      `to .notdef.`);
  }

  /* The shaping unit is the word, not the line.
   *
   * A GPOS pair that reached across a space would make a word's measured
   * width depend on what followed it — and `assets/engine.js` breaks lines
   * at spaces, so the same word would measure one width mid-line and another
   * at the end of one. The fit ladder would then disagree with the printed
   * file about whether a line fits, which is the whole failure this writer's
   * geometry check exists to catch. Blink shapes word by word for its own
   * caching reasons and so the browser preview already behaves this way;
   * matching it is a bonus, but the line-break argument is the reason.
   */
  const words = [];
  {
    let cur = [];
    for (const g of glyphs) {
      if (g.cat === CAT.OTHER && /\s/u.test(String.fromCodePoint(g.cp))) {
        if (cur.length) words.push({ shape: true, glyphs: cur });
        words.push({ shape: false, glyphs: [g] });
        cur = [];
      } else cur.push(g);
    }
    if (cur.length) words.push({ shape: true, glyphs: cur });
  }

  const out = [];
  for (const word of words) {
    if (!word.shape) { out.push(...word.glyphs); continue; }
    out.push(...shapeWord(plan, word.glyphs, face));
  }

  /* Advances come from hmtx for everything the positioning stage did not
     already adjust. A word's glyphs were positioned inside `shapeWord`; the
     spaces between them were not, and take their design width. */
  for (const g of out) if (!g.positioned) g.xAdv = face.advanceRaw(g.gid);

  return out
    .filter(g => !isDefaultIgnorable(g.cp))
    .map(g => ({ gid: g.gid, xAdvance: g.xAdv, xOffset: g.xOff, yOffset: g.yOff, cluster: g.cl }));
}

function shapeWord(plan, glyphs, face) {
  const out = [];
  for (const syl of syllables(glyphs)) {
    const part = glyphs.slice(syl.start, syl.end);
    if (syl.kind === 'broken') {
      const chars = part.map(g => String.fromCodePoint(g.cp) +
        ' (U+' + g.cp.toString(16).toUpperCase().padStart(4, '0') + ')').join(', ');
      refuse('bangla_broken_cluster',
        `This Bangla text contains a cluster the shaper cannot read: ${chars}. A Bengali syllable ` +
        `cannot begin with a vowel sign, a halant or a nukta, so the text is either mistyped or in a ` +
        `form this writer does not handle. A shaper for a screen would draw a dotted circle here; a ` +
        `press file must not, so this is refused instead.`);
    }
    if (syl.kind === 'other' || syl.kind === 'symbol') { out.push(...part); continue; }

    const buf = part;
    initialReorder(plan, buf);

    /* Stage 3 — one feature at a time, in the order the model specifies. The
       order is the product here: `rphf` must have run before `half` can see
       what is left, and `vatu` before `cjct` or a ra-phala conjunct forms as
       two pieces. */
    for (const f of BASIC)
      runFeature(plan, buf, plan.gsub, plan.gsubFeat[f], MASKED[f] || GLOBAL);

    /* A syllable opens a word when nothing precedes it, or what precedes it
       is neither a letter nor a mark — a space, a slash, the end of the Latin
       half of a bilingual line. */
    const before = glyphs[syl.start - 1];
    const atWordStart = !before ||
      (before.cat === CAT.OTHER && !/\p{L}|\p{M}/u.test(String.fromCodePoint(before.cp)));
    finalReorder(plan, buf, atWordStart);
    out.push(...buf);
  }

  /* Stage 5 — the presentation substitutions, over the whole word rather than
     per syllable. Everything above this line is syllable-local because the
     cluster model is; these are not, and running them syllable by syllable
     was measurably wrong: Tiro Bangla's `rclt` picks its আ-কার from what
     stands before it, so ঢাকা came out 0.3 mm narrow at card size with the
     wrong outline on the second syllable. */
  runStage(plan, out, plan.gsub, PRESENTATION, plan.gsubFeat);

  /* Stage 6 — positioning, likewise over the whole word, so a mark can still
     find its base across a syllable boundary and kerning sees the pair it is
     written for. */
  for (const g of out) { g.xAdv = face.advanceRaw(g.gid); g.positioned = true; }
  if (plan.gpos) runStage(plan, out, plan.gpos, POSITIONING, plan.gposFeat);

  /* Note what is deliberately NOT done here: mark advances are not zeroed.
     Most shapers zero the advance of anything GDEF calls a mark, and for
     Latin that is right — a combining acute has no width. Bengali's spacing
     matras are marks that do: া is a mark with a real advance, ং is a mark
     with a real advance, and zeroing them makes বাংলাদেশ measure short by the
     width of two letters. HarfBuzz's Indic shaper declares
     ZERO_WIDTH_MARKS_NONE for exactly this reason, and the fonts' own hmtx
     already gives the non-spacing matras a zero advance, so there is nothing
     left to correct. This was found by measuring against the browser: the
     advance was 10% short and the glyphs were right, which is the signature
     of a metrics rule rather than a shaping one.

     An attached mark's offset is relative to the glyph it hangs on, so it has
     to absorb that glyph's own offset and step back over the advances of
     everything between them. */
  for (let i = 0; i < out.length; i++) {
    const chain = out[i].attach;
    if (!chain) continue;
    const j = i + chain;
    if (j < 0 || j >= out.length) continue;
    out[i].xOff += out[j].xOff;
    out[i].yOff += out[j].yOff;
    for (let k = j; k < i; k++) out[i].xOff -= out[k].xAdv;
  }

  return out;
}

export { CAT as BENGALI_CATEGORIES, POS as BENGALI_POSITIONS, classify as classifyBengali, syllables as bengaliSyllables };
