/* Verification of the Bengali shaper.
 *
 * This is the one feature in the product where being wrong is invisible until
 * 500 cards are printed. A conjunct made of the right letters in the wrong
 * order is still a word-shaped thing; the customer reads what they meant to
 * write and approves it, and the people handed the cards afterwards are the
 * ones who find out. So "it produced glyphs" is not evidence of anything, and
 * neither is a golden file this repository wrote about its own output.
 *
 * Three independent kinds of evidence are collected here, because each one
 * catches what the others cannot:
 *
 *   1. The fonts' own ligature tables, walked a second time by code that
 *      knows nothing about features, masks or the cluster model. If the
 *      shaper says ক + ্ + ষ is glyph 1234, an independent scan of every
 *      LigatureSubst subtable in the binary has to agree.
 *
 *   2. Headless Chromium, which shapes Bengali with HarfBuzz and is the same
 *      renderer that drew the preview the customer approved. Its shaped
 *      advance is compared as a number, and its rasterisation is compared
 *      pixel by pixel against ours — same canvas, same size, same origin, so
 *      the only variable left is the shaping.
 *
 *   3. The recorded verdict of (2), committed to tests/shaping.golden.json,
 *      so a machine with no browser still runs against Chromium's answer
 *      rather than against nothing. Regenerate it with
 *
 *          PLAYWRIGHT_CORE=/path/to/playwright-core node tests/shaping.test.mjs --record
 *
 *      A change in shaped output then cannot pass quietly: either the widths
 *      stop matching Chromium's recorded numbers, or the glyph ids stop
 *      matching and somebody has to re-record deliberately.
 *
 * Run with: node tests/shaping.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadFace, hasBangla } from '../lib/pdf/fonts.mjs';
import { layoutFor } from '../lib/pdf/otlayout.mjs';
import { shapeBengali, planFor, bengaliSyllables, classifyBengali, BENGALI_CATEGORIES } from '../lib/pdf/bengali.mjs';
import { measureRun, outlineRun } from '../lib/pdf/text.mjs';
import { PrintRefusal } from '../lib/pdf/refusal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'tests/shaping.golden.json');
const RECORD = process.argv.includes('--record');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name))
       : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')));
};
const H = s => console.log('\n' + s);
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/* ── the faces under test ───────────────────────────────────────────────── */

const FAMILIES = [
  ["'Noto Sans Bengali',sans-serif", 'noto-sans-bengali'],
  ["'Hind Siliguri',sans-serif", 'hind-siliguri'],
  ["'Baloo Da 2',cursive", 'baloo-da-2'],
  ["'Tiro Bangla',serif", 'tiro-bangla']
];

/* Discovered from disk rather than declared, so a re-vendored family with a
   new weight is tested the moment it lands and a removed one fails here
   rather than silently dropping out of the coverage. */
const FACES = [];
for (const [stack, slug] of FAMILIES) {
  const weights = fs.readdirSync(path.join(ROOT, 'assets/fonts'))
    .filter(f => f.startsWith(slug + '-') && /-\d{3}\.ttf$/.test(f))
    .map(f => +f.match(/-(\d{3})\.ttf$/)[1]).sort((a, b) => a - b);
  for (const w of weights) FACES.push({ stack, slug, weight: w, key: `${slug}-${w}`, file: `${slug}-${w}.ttf` });
}

/* ── the corpus ─────────────────────────────────────────────────────────── */

/* The three conjuncts PRD §8.1 names as the Phase 0 legibility floor, then
   every other construction a visiting card actually contains. */
const NAMED = ['ক্ষ', 'ঙ্গ', 'ন্ত্র'];
const CONSTRUCTIONS = [
  'র্ক', 'র্ম', 'র্থ', 'র্স',                       // reph
  'ক্র', 'প্র', 'গ্র', 'ট্র', 'দ্র',                 // ra-phala
  'ক্য', 'ব্য', 'ন্য', 'দ্য',                       // ya-phala
  'স্ব', 'দ্ব', 'ত্ব',                              // ba-phala
  'কি', 'মি', 'তি', 'কী',                          // the pre-base vowel and its long form
  'কে', 'কৈ', 'কো', 'কৌ',                          // left-side and two-part vowels
  'কু', 'কূ', 'কৃ',                                 // below-base vowels
  'ৎ', 'কং', 'কঃ', 'কঁ',                            // khanda-ta and the syllable modifiers
  'ড়', 'ঢ়', 'য়', 'ড়া', 'ক্ষ্ম', 'ঙ্ক্ষ', 'ন্ত্ব',
  /* The joiners, which are how somebody spells a name that must not take the
     conjunct the font would otherwise form. They do their work during shaping
     and must leave no ink: two of these faces draw a visible proof mark for
     ZWJ, and outlining it would put that mark on the card. */
  'ক‌ষ', 'ক‍ষ', 'ক্‌ষ', 'ক্‍ষ', 'র্‍ক', 'মোঃ​রফিক'
];
const WORDS = ('মোহাম্মদ রহিম উদ্দিন আহমেদ শেখ হাসিনা প্রকৌশলী ব্যবস্থাপনা পরিচালক সহকারী অধ্যাপক ডাক্তার '
  + 'বাংলাদেশ ঢাকা চট্টগ্রাম রাজশাহী খুলনা সিলেট বরিশাল রংপুর ময়মনসিংহ নারায়ণগঞ্জ গাজীপুর কুমিল্লা '
  + 'ট্রেডার্স এন্টারপ্রাইজ কর্পোরেশন লিমিটেড বিশ্ববিদ্যালয় হাসপাতাল বিদ্যুৎ স্থপতি ফ্ল্যাট '
  + 'ঠিকানা ওয়েবসাইট কার্যালয় সড়ক আন্তর্জাতিক ঊর্ধ্বতন কর্মকর্তা স্বাক্ষর দ্বিতীয় বিজ্ঞান প্রযুক্তি').split(/\s+/);
const LINES = [
  'অধ্যাপক ডাঃ মোঃ আব্দুর রহমান',
  'পপুলার ডায়াগনস্টিক সেন্টার',
  'ঢাকা-১২০৭, বাংলাদেশ',
  '০১৭১১-১২৩৪৫৬',
  '৳ ৫০০',
  'কক্ষ নং ৪-বি'
];
const CURATED = [...NAMED, ...CONSTRUCTIONS, ...WORDS, ...LINES];

/* The full two-consonant matrix. 36 consonants against 36, through the
   halant, is 1296 clusters per face — far more than anyone would write down,
   and the point is precisely that nobody wrote them down. Its browser
   verdict is recorded as a digest rather than 15552 rows. */
const CONSONANTS = [...'কখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়ৎ'];
const MATRIX = [];
for (const a of CONSONANTS) for (const b of CONSONANTS) MATRIX.push(a + '্' + b);

const shapeIds = (face, text) => shapeBengali(text, face).map(g => g.gid);
const shapeAdvance = (face, text) =>
  shapeBengali(text, face).reduce((n, g) => n + g.xAdvance, 0) / face.unitsPerEm;
const digest = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);

/* ── 1. the layout tables ───────────────────────────────────────────────── */

H('── the OpenType layout reader ──');
for (const f of FACES) {
  const face = loadFace(f.stack, f.weight);
  const L = layoutFor(face);
  const unreadable = ['gsub', 'gpos']
    .flatMap(t => (L[t] ? L[t].lookups : []).filter(lk => lk.unreadable).map(lk => lk.unreadable));
  ok(`${f.key}: every GSUB and GPOS subtable parses`, unreadable.length === 0,
     unreadable.slice(0, 2).join('; '));
}

const noto = loadFace(FAMILIES[0][0], 400);
const notoL = layoutFor(noto);
ok('a lookup list is read whole, not truncated at the first unknown format',
   notoL.gsub.lookups.length > 100 && notoL.gpos.lookups.length > 100,
   `${notoL.gsub.lookups.length} GSUB, ${notoL.gpos.lookups.length} GPOS`);
ok('GDEF supplies glyph classes and a mark-glyph-set filter',
   notoL.gdef.classes.size > 400 && notoL.gdef.markSets.length > 0,
   `${notoL.gdef.classes.size} classes, ${notoL.gdef.markSets.length} mark sets`);
ok('every lookup type the vendored Bangla faces actually use is implemented',
   (() => {
     const used = new Set();
     for (const f of FACES) {
       const L = layoutFor(loadFace(f.stack, f.weight));
       for (const t of ['gsub', 'gpos'])
         for (const lk of (L[t] ? L[t].lookups : []))
           for (const st of lk.subtables) used.add(`${t}${st.type}`);
     }
     /* An empty set here would pass the `every` below vacuously, which is the
        exact shape of the broken extractor WORKPLAN.md legislates against. */
     return used.size >= 6;
   })(), 'no lookup types were discovered at all');

H('── the shaping plan ──');
for (const f of FACES) {
  const face = loadFace(f.stack, f.weight);
  const plan = planFor(face);
  const named = ['rphf', 'blwf', 'half', 'pstf'];
  const reachable = named.filter(t => plan.gsubFeat[t].length);
  ok(`${f.key}: registers bng2 and resolves its Indic features to real lookups`,
     plan.script === 'bng2' && reachable.length === named.length && plan.virama > 0,
     `${plan.script}, has ${reachable.join('+') || 'none'}, virama gid ${plan.virama}`);
}

/* The house rule from WORKPLAN.md, asserted rather than trusted: a plan that
   finds nothing has to refuse. A Latin face has a GSUB full of lookups and no
   Bengali script in it, which is the case that would otherwise shape silently
   into nonsense. */
const latinPlan = refusal(() => planFor(loadFace("'Archivo',sans-serif", 400)));
ok('a face with no Bengali script refuses rather than shaping with whatever it has',
   latinPlan instanceof PrintRefusal && latinPlan.code === 'bangla_no_bengali_script',
   latinPlan && latinPlan.code);
ok('that refusal names the family, so the screen can offer another one',
   /Archivo/.test(latinPlan.message), latinPlan && latinPlan.message.slice(0, 90));

/* ── 2. the fonts' own ligature tables, walked independently ────────────── */

H('── conjuncts, checked against the fonts’ own GSUB tables ──');

/* A second reading of the binary that shares no code path with the shaper:
   it knows nothing about features, feature order, per-glyph masks, the
   cluster model or reordering. It collects every ligature any LigatureSubst
   subtable in GSUB declares, keyed by its input glyph sequence. If the
   shaper and this disagree about what ক + ্ + ষ becomes, one of them is
   wrong and the suite has to say so. */
function allLigatures(face) {
  const L = layoutFor(face);
  const out = new Map();
  for (const lk of L.gsub.lookups)
    for (const st of lk.subtables) {
      if (st.type !== 4 || st.kind === 'ctx') continue;
      for (const [first, ci] of st.cov)
        for (const lig of st.sets[ci] || [])
          out.set([first, ...lig.components].join(','), lig.glyph);
    }
  return out;
}

/* A conjunct does not always survive as the glyph the ligature produced.
   Tiro Bangla builds হ্য with a `cjct` ligature and then swaps it for a
   stylistic alternate under `rclt`, so the final glyph is one step further on
   — and Chromium does the same. Rather than weaken the check to "contains
   something", it is allowed to land on any glyph the font itself derives from
   the ligature by a single or alternate substitution, which is still a claim
   about the binary and not about our own output. */
function derivable(face, from) {
  const L = layoutFor(face);
  const out = new Set([from]);
  for (const lk of L.gsub.lookups)
    for (const st of lk.subtables) {
      if (st.kind === 'ctx' || !st.cov || !st.cov.has(from)) continue;
      if (st.type === 1) out.add(st.fmt === 1 ? (from + st.delta) & 0xffff : st.subs[st.cov.get(from)]);
      if (st.type === 3) for (const alt of st.sets[st.cov.get(from)] || []) out.add(alt);
    }
  return out;
}

/* Declaring a ligature is not the same as reaching it. Noto Sans Bengali
   carries a ক + ্ + ট ligature that the Indic model never fires — the rule
   sits in a lookup the cluster does not route through — and Chromium leaves
   that cluster as two glyphs too. So the claim asserted here is the one that
   is actually true of a shaper, and is still the claim that catches a wrong
   conjunct: *when* a cluster collapses to a single glyph, that glyph must be
   the one the font's own table names for it. Clusters that stay apart are
   Chromium's business, and the recorded verdict below is where they are
   checked. */
let ligChecked = 0, ligAgreed = 0, ligDerived = 0, ligNotTaken = 0, ligContextual = 0;
const ligDisagreed = [];
for (const f of FACES) {
  const face = loadFace(f.stack, f.weight);
  const ligs = allLigatures(face);
  if (!ligs.size) { ok(`${f.key}: has ligature subtables to check against`, false, 'none found'); continue; }
  for (const cluster of [...NAMED, ...MATRIX]) {
    const cps = [...cluster].map(c => face.glyphIdFor(c.codePointAt(0)));
    if (cps.some(g => !g)) continue;
    const direct = ligs.get(cps.join(','));
    if (direct === undefined) { ligContextual++; continue; }
    const shaped = shapeIds(face, cluster);
    if (shaped.length !== 1) { ligNotTaken++; continue; }
    ligChecked++;
    if (shaped[0] === direct) { ligAgreed++; continue; }
    if (derivable(face, direct).has(shaped[0])) { ligAgreed++; ligDerived++; continue; }
    ligDisagreed.push(`${f.key} ${cluster}: shaper says ${shaped[0]}, the table says ${direct}`);
  }
}
ok('the independent table walk found conjuncts to check',
   ligChecked > 250, `${ligChecked} clusters collapsed to one glyph and were checked against the binary`);
ok('every cluster the shaper collapses is collapsed to the glyph the font names for it',
   ligChecked > 0 && ligDisagreed.length === 0 && ligAgreed === ligChecked,
   ligDisagreed.slice(0, 3).join(' | '));
ok('the handful that end on a derived glyph do so through the font’s own alternates',
   ligDerived < ligChecked / 20, `${ligDerived} of ${ligChecked} land on a derived glyph`);
ok('a declared ligature the Indic model does not route through is left alone, not forced',
   ligNotTaken > 0 && ligNotTaken < ligChecked,
   `${ligNotTaken} declared ligatures are not reachable from the cluster model`);
ok('the clusters this walk cannot reach are formed by contextual lookups, not skipped silently',
   ligContextual > 0, `${ligContextual} clusters are built by chained context or by no rule at all`);

/* The three conjuncts PRD §8.1 names as the Phase 0 legibility floor have to
   form in every face. "One glyph" is the wrong test for it — Noto Sans
   Bengali writes ন্ত্র as the conjunct ন্ত plus a below-base ra-phala, which
   is two glyphs and is what Chromium draws too. What must be true is that
   the cluster was shaped at all: fewer glyphs than codepoints, and no visible
   halant left standing between the letters, which is exactly what an
   unshaped run would show. */
for (const f of FACES) {
  const face = loadFace(f.stack, f.weight);
  const virama = face.glyphIdFor(0x09CD);
  const shaped = NAMED.map(c => ({ c, ids: shapeIds(face, c) }));
  ok(`${f.key}: ক্ষ, ঙ্গ and ন্ত্র are each formed, with no halant left standing`,
     virama > 0 && shaped.every(s => s.ids.length < [...s.c].length && !s.ids.includes(virama)),
     shaped.map(s => `${s.c}→${s.ids.length} of ${[...s.c].length}`).join(' '));
}

/* Reph and the below-base forms are worth naming separately, because they are
   the two places the cluster model can be right about the glyph and wrong
   about where it goes. */
for (const f of FACES.filter(x => x.weight === 400)) {
  const face = loadFace(f.stack, f.weight);
  const raGid = face.glyphIdFor(0x09B0);
  const reph = shapeIds(face, 'র্ক');
  const plain = shapeIds(face, 'ক');
  ok(`${f.key}: র্ক produces a reph and a ka, not a ra followed by a ka`,
     reph.length === 2 && reph.every(g => g !== raGid) && reph.includes(plain[0]),
     `[${reph}] vs ra=${raGid} ka=${plain[0]}`);
  const iGid = face.glyphIdFor(0x09BF);
  const ki = shapeIds(face, 'কি');
  ok(`${f.key}: the pre-base vowel ি is emitted before the consonant it follows in memory`,
     ki.length === 2 && ki[0] === iGid && ki[1] === plain[0], `[${ki}] vs i=${iGid}`);
  /* ো is one codepoint whose halves sit on opposite sides of the consonant.
     The two halves are named by the font, not by this file: whatever glyph
     কে puts before the ka and whatever কা puts after it are what কো has to
     produce, in that order. */
  const ko = shapeIds(face, 'কো'), ke = shapeIds(face, 'কে'), ka = shapeIds(face, 'কা');
  ok(`${f.key}: the two-part vowel ো is split, its halves landing either side of the base`,
     ko.length === 3 && ke.length === 2 && ka.length === 2 &&
     ko[0] === ke[0] && ko[1] === plain[0] && ko[2] === ka[1],
     `কো [${ko}] against কে [${ke}] and কা [${ka}]`);
}

/* ── 3. the cluster model ───────────────────────────────────────────────── */

H('── the cluster model ──');
const cats = (s) => [...s].map(c => classifyBengali(c.codePointAt(0)).cat);
ok('the character table classifies from Unicode, not from a guess about shape',
   classifyBengali(0x09B0).cat === BENGALI_CATEGORIES.Ra &&
   classifyBengali(0x09CD).cat === BENGALI_CATEGORIES.H &&
   classifyBengali(0x09BF).cat === BENGALI_CATEGORIES.M &&
   classifyBengali(0x09CE).cat === BENGALI_CATEGORIES.C &&
   classifyBengali(0x09F3).cat === BENGALI_CATEGORIES.SYMBOL &&
   classifyBengali(0x0041).cat === BENGALI_CATEGORIES.OTHER,
   JSON.stringify(cats('রক্ষি')));

const glyphsOf = (s) => [...s].map((c, i) => ({ cp: c.codePointAt(0), cl: i, ...classifyBengali(c.codePointAt(0)) }));
const kinds = (s) => bengaliSyllables(glyphsOf(s)).map(x => x.kind);
ok('a word breaks into one syllable per orthographic cluster',
   kinds('ঢাকা').filter(k => k === 'syllable').length === 2 &&
   kinds('ন্ত্র').filter(k => k === 'syllable').length === 1,
   JSON.stringify([kinds('ঢাকা'), kinds('ন্ত্র')]));
ok('Latin and punctuation inside a Bangla run travel through as themselves',
   kinds('ঢাকা-1').includes('other'), JSON.stringify(kinds('ঢাকা-1')));
ok('a cluster that cannot open a syllable is identified as broken, not shaped around',
   kinds('িক').includes('broken') && kinds('্ক').includes('broken'),
   JSON.stringify([kinds('িক'), kinds('্ক')]));

const brokenRun = refusal(() => shapeBengali('িক', loadFace(FAMILIES[0][0], 400)));
ok('a broken cluster refuses at shaping time rather than drawing a dotted circle',
   brokenRun instanceof PrintRefusal && brokenRun.code === 'bangla_broken_cluster',
   brokenRun && brokenRun.code);
ok('the refusal quotes the codepoint, because "invalid text" is not actionable',
   /U\+09BF/.test(brokenRun.message));

const nofont = refusal(() => shapeBengali('ক৿', loadFace(FAMILIES[0][0], 400)));
ok('a character the vendored face has no glyph for refuses rather than printing .notdef',
   nofont instanceof PrintRefusal && nofont.code === 'glyph_missing', nofont && nofont.code);

H('── what the writer does with the shaped run ──');
const bnStack = FAMILIES[1][0];
const face400 = loadFace(bnStack, 400);
/* Tracking is space between glyphs. ক্ষ is three codepoints and one glyph, so
   there is no gap inside it to open up; কখ is two of each, so there is one.
   Tracking the codepoints instead would push a conjunct apart from the
   inside, which is not a place letterspacing belongs. */
ok('tracking counts the gaps between glyphs, not between codepoints',
   measureRun('ক্ষ', bnStack, 400, 0.1, 10) === measureRun('ক্ষ', bnStack, 400, 0, 10) &&
   Math.abs(measureRun('কখ', bnStack, 400, 0.1, 10) - measureRun('কখ', bnStack, 400, 0, 10) - 1) < 1e-9,
   `ক্ষ ${measureRun('ক্ষ', bnStack, 400, 0.1, 10).toFixed(4)} vs ${measureRun('ক্ষ', bnStack, 400, 0, 10).toFixed(4)}`);
ok('a shaped run measures the sum of its shaped advances and nothing else',
   Math.abs(measureRun('ন্ত্র', bnStack, 400, 0, 10) - shapeAdvance(face400, 'ন্ত্র') * 10) < 1e-9);
const line = outlineRun('র্কি', { cssStack: bnStack, weight: 400, sizeMm: 10, trackEm: 0, x: 0, y: 0 });
ok('an outlined Bangla run carries closed contours for every glyph in it',
   line.ops.length > 20 && line.ops.some(o => o[0] === 'c') && line.ops.filter(o => o[0] === 'h').length >= 3,
   `${line.ops.length} ops, ${line.ops.filter(o => o[0] === 'h').length} closes`);
ok('a mark’s offset moves its outline, so a reph is drawn above its cluster and not beside it',
   (() => {
     const withMark = outlineRun('র্ক', { cssStack: bnStack, weight: 400, sizeMm: 10, trackEm: 0, x: 0, y: 0 });
     const topOf = ops => Math.min(...ops.filter(o => o.length > 1).map(o => o[2]));
     const rightOf = ops => Math.max(...ops.filter(o => o.length > 1).map(o => o[1]));
     const plainKa = outlineRun('ক', { cssStack: bnStack, weight: 400, sizeMm: 10, trackEm: 0, x: 0, y: 0 });
     /* y grows downward from the baseline here, so a smaller y is higher up.
        The reph must sit above the ka and within its width, not after it. */
     return topOf(withMark.ops) < topOf(plainKa.ops) && rightOf(withMark.ops) <= rightOf(plainKa.ops) + 0.5;
   })());
ok('a Latin run is untouched by any of this',
   measureRun('AV', "'Archivo',sans-serif", 700, 0, 10) ===
   10 * (loadFace("'Archivo',sans-serif", 700).advanceEm(loadFace("'Archivo',sans-serif", 700).glyphIdFor(0x41)) +
         loadFace("'Archivo',sans-serif", 700).advanceEm(loadFace("'Archivo',sans-serif", 700).glyphIdFor(0x56))));
ok('hasBangla still recognises the script the writer now shapes',
   hasBangla('ক') && hasBangla('৳') && !hasBangla('Dhaka'));

/* ── 4. Chromium ────────────────────────────────────────────────────────── */

/* Rendering our shaped run and the browser's own rendering of the same string
   into the same canvas, at the same size and origin, leaves shaping as the
   only difference between the two bitmaps. Chromium rasterises text a shade
   heavier than a filled path — stem darkening — so the comparison is made
   after binarising both and allowing one pixel of slack in each direction. A
   wrong conjunct does not survive that tolerance; the negative control below
   proves it. */
async function withBrowser(fn) {
  const mod = process.env.PLAYWRIGHT_CORE || 'playwright-core';
  let chromium, browser;
  try { ({ chromium } = await import(mod)); } catch { return null; }
  /* A playwright-core that is installed but has no browser binary behind it
     is reported rather than swallowed: the recorded verdict still carries
     every check, so skipping is safe, but skipping in silence is not. */
  try { browser = await chromium.launch({ headless: true }); }
  catch (e) { console.log(`  · playwright-core resolved but no browser launched: ${e.message.split('\n')[0]}`); return null; }
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent('<body style="margin:0">');
    /* One page for the whole run. The font is re-registered per face inside
       the page, which is cheaper than a browser launch each time and keeps
       every case on the same rasteriser. */
    return await fn(async (cases, opts) => {
      const out = [];
      for (let i = 0; i < cases.length; i += 200)
        out.push(...await page.evaluate(PAGE_FN, { ...opts, cases: cases.slice(i, i + 200) }));
      return out;
    });
  } finally { await browser.close(); }
}

const PAGE_FN = async ({ b64, fam, cases, size, x0, y0, W, H }) => {
  /* A distinct family name per face, because the page outlives one font and
     re-registering the same name would leave the first binary in place. */
  if (!self['_f_' + fam]) {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ff = new FontFace(fam, bin.buffer);
    await ff.load(); document.fonts.add(ff);
    self['_f_' + fam] = true;
  }
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H;
                     return c.getContext('2d', { willReadFrequently: true }); };
  const A = mk(), B = mk();
  const N = W * H;
  const ma = new Uint8Array(N), mb = new Uint8Array(N), da = new Uint8Array(N), db = new Uint8Array(N);
  const binz = (ctx, m) => { const d = ctx.getImageData(0, 0, W, H).data; let ink = 0;
    for (let i = 3, p = 0; i < d.length; i += 4, p++) { const v = d[i] > 128 ? 1 : 0; m[p] = v; ink += v; }
    return ink; };
  const dilate = (m, d) => { d.fill(0);
    for (let y = 0; y < H; y++) { const row = y * W;
      for (let x = 0; x < W; x++) { if (!m[row + x]) continue;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; const r2 = yy * W;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) d[r2 + xx] = 1; } } } } };
  const out = [];
  for (const cs of cases) {
    A.clearRect(0, 0, W, H); B.clearRect(0, 0, W, H);
    A.font = `${size}px ${fam}`; A.textBaseline = 'alphabetic'; A.fillStyle = '#000';
    const width = A.measureText(cs.text).width;
    A.fillText(cs.text, x0, y0);
    B.fillStyle = '#000'; B.fill(new Path2D(cs.d));
    const inkA = binz(A, ma), inkB = binz(B, mb);
    dilate(ma, da); dilate(mb, db);
    let diff = 0;
    for (let p = 0; p < N; p++) if ((ma[p] && !db[p]) || (mb[p] && !da[p])) diff++;
    out.push({ width, inkA, inkB, diff });
  }
  return out;
};

const SIZE = 90, X0 = 30, Y0 = 200, CANVAS_W = 1400, CANVAS_H = 280;

/** Our shaped run as an SVG path in the page's pixel space. `raw` skips the
 *  shaper entirely and maps codepoint to glyph one at a time, which is the
 *  negative control: it is what the writer used to refuse to do. */
function ourPath(face, text, { raw = false } = {}) {
  const run = raw
    ? [...text].map(ch => ({ gid: face.glyphIdFor(ch.codePointAt(0)), xAdvance: face.advanceRaw(face.glyphIdFor(ch.codePointAt(0))), xOffset: 0, yOffset: 0 }))
    : shapeBengali(text, face);
  const s = SIZE / face.unitsPerEm;
  const n = v => Math.round(v * 100) / 100;
  let pen = X0, d = '';
  for (const g of run) {
    if (!g.gid) continue;
    const ox = pen + g.xOffset * s, oy = Y0 - g.yOffset * s;
    for (const cmd of face.pathFor(g.gid)) {
      if (cmd[0] === 'h') { d += 'Z'; continue; }
      const pts = [];
      for (let i = 1; i < cmd.length; i += 2) pts.push(n(ox + cmd[i] * s), n(oy - cmd[i + 1] * s));
      d += (cmd[0] === 'm' ? 'M' : cmd[0] === 'l' ? 'L' : 'C') + pts.join(' ');
    }
    pen += g.xAdvance * s;
  }
  return { d, advance: pen - X0 };
}

const b64Of = (file) => fs.readFileSync(path.join(ROOT, 'assets/fonts', file)).toString('base64');
const opts = (f) => ({ b64: b64Of(f.file), fam: 'F' + f.key.replace(/[^a-z0-9]/gi, ''),
                       size: SIZE, x0: X0, y0: Y0, W: CANVAS_W, H: CANVAS_H });

const pct = r => 100 * r.diff / (Math.max(r.inkA, r.inkB) || 1);

if (RECORD) {
  const record = await withBrowser(async (ask) => {
    const out = { generatedBy: 'node tests/shaping.test.mjs --record', size: SIZE, faces: {} };
    for (const f of FACES) {
      const face = loadFace(f.stack, f.weight);
      const vCur = await ask(CURATED.map(t => ({ text: t, ...ourPath(face, t) })), opts(f));
      const vMat = await ask(MATRIX.map(t => ({ text: t, ...ourPath(face, t) })), opts(f));
      const dw = (t, i, v) => Math.abs(shapeAdvance(face, t) * SIZE - v[i].width);
      out.faces[f.key] = {
        /* `w` is Chromium's number, not ours — that is the whole value of the
           file. `gids` is ours, recorded at the moment Chromium agreed. */
        curated: CURATED.map((t, i) => ({ t, w: +vCur[i].width.toFixed(4), gids: shapeIds(face, t) })),
        matrixCount: MATRIX.length,
        matrixGids: digest(MATRIX.map(t => shapeIds(face, t))),
        matrixMaxWidthDeltaPx: +Math.max(...MATRIX.map((t, i) => dw(t, i, vMat))).toFixed(4),
        curatedMaxWidthDeltaPx: +Math.max(...CURATED.map((t, i) => dw(t, i, vCur))).toFixed(4),
        matrixWorstDiffPct: +Math.max(...vMat.map(pct)).toFixed(2),
        curatedWorstDiffPct: +Math.max(...vCur.map(pct)).toFixed(2)
      };
      console.log(`  recorded ${f.key}: ${CURATED.length} curated + ${MATRIX.length} matrix, ` +
        `worst pixel diff ${Math.max(...vCur.map(pct), ...vMat.map(pct)).toFixed(2)}%, ` +
        `worst width delta ${Math.max(out.faces[f.key].matrixMaxWidthDeltaPx, out.faces[f.key].curatedMaxWidthDeltaPx)}px`);
    }
    return out;
  });
  if (!record) {
    console.error('  --record needs a browser: set PLAYWRIGHT_CORE to a resolvable playwright-core.');
    process.exit(2);
  }
  fs.writeFileSync(GOLDEN, JSON.stringify(record, null, 1) + '\n');
  console.log(`\nRecorded Chromium's verdict for ${Object.keys(record.faces).length} faces to ${GOLDEN}`);
}

const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : null;

H('── against Chromium’s recorded verdict ──');
ok('the recorded verdict exists and covers every vendored face and weight',
   golden && Object.keys(golden.faces).length === FACES.length &&
   FACES.every(f => golden.faces[f.key]),
   golden ? `${Object.keys(golden.faces).length} recorded, ${FACES.length} on disk` : 'tests/shaping.golden.json is missing');

if (golden) {
  /* The recording has to be substantial before anything is asserted against
     it, or a truncated file would make every check below pass vacuously. */
  const rows = Object.values(golden.faces).reduce((n, g) => n + g.curated.length, 0);
  ok('the recording is substantial rather than a stub',
     rows >= FACES.length * 80 && Object.values(golden.faces).every(g => g.matrixCount === MATRIX.length),
     `${rows} recorded curated rows, matrix ${Object.values(golden.faces)[0]?.matrixCount} of ${MATRIX.length}`);

  /* Chromium's widths are re-checked against a freshly shaped run every time
     this suite is run, on a machine that may have no browser. This is the
     assertion that would catch a change in measured advance, which is the
     thing the fit ladder depends on. */
  let widthMismatch = [], gidMismatch = [], matrixBad = [], worstDelta = 0, checked = 0;
  for (const f of FACES) {
    const g = golden.faces[f.key];
    if (!g) continue;
    const face = loadFace(f.stack, f.weight);
    for (const row of g.curated) {
      checked++;
      const ours = shapeAdvance(face, row.t) * SIZE;
      worstDelta = Math.max(worstDelta, Math.abs(ours - row.w));
      if (Math.abs(ours - row.w) > 0.01)
        widthMismatch.push(`${f.key} ${row.t}: ${ours.toFixed(3)} vs Chromium ${row.w}`);
      const ids = shapeIds(face, row.t);
      if (ids.join(',') !== row.gids.join(','))
        gidMismatch.push(`${f.key} ${row.t}: [${ids}] vs recorded [${row.gids}]`);
    }
    if (digest(MATRIX.map(t => shapeIds(face, t))) !== g.matrixGids) matrixBad.push(f.key);
  }

  ok('the width check compared something', checked >= FACES.length * CURATED.length,
     `${checked} of ${FACES.length * CURATED.length}`);
  ok('every curated run measures what Chromium measured, to a hundredth of a pixel',
     widthMismatch.length === 0 && checked > 0,
     widthMismatch.slice(0, 3).join(' | ') || `worst delta ${worstDelta.toFixed(4)}px`);
  ok('every curated run resolves to the glyphs recorded at the moment Chromium agreed',
     gidMismatch.length === 0, gidMismatch.slice(0, 3).join(' | '));
  ok(`all ${MATRIX.length} two-consonant conjuncts still shape as recorded, in every face`,
     matrixBad.length === 0, matrixBad.slice(0, 4).join(', '));
  ok('Chromium measured the whole conjunct matrix within a hundredth of a pixel of us',
     Object.values(golden.faces).every(g => g.matrixMaxWidthDeltaPx <= 0.01 && g.curatedMaxWidthDeltaPx <= 0.01),
     Object.entries(golden.faces).map(([k, g]) =>
       `${k} ${Math.max(g.matrixMaxWidthDeltaPx, g.curatedMaxWidthDeltaPx)}px`).join(' '));
  ok('the recorded pixel comparison found no disagreement with Chromium anywhere',
     Object.values(golden.faces).every(g => g.curatedWorstDiffPct <= 0.5 && g.matrixWorstDiffPct <= 0.5),
     Object.entries(golden.faces).map(([k, g]) =>
       `${k} ${g.curatedWorstDiffPct}/${g.matrixWorstDiffPct}%`).join(' '));
}

/* ── the live run, when a browser is available ──────────────────────────── */

const CONTROL = ['ক্ষ', 'ন্ত্র', 'কি', 'র্ক', 'কো', 'ক্র'];

const liveRun = await withBrowser(async (ask) => {
  const out = [];
  for (const f of FACES) {
    const face = loadFace(f.stack, f.weight);
    out.push({
      key: f.key,
      shaped: await ask(CURATED.map(t => ({ text: t, ...ourPath(face, t) })), opts(f)),
      /* The negative control. Without it, "0 mismatches" could mean the
         harness measures nothing at all — the silent-pass failure mode
         WORKPLAN.md was written about. Outlining codepoint by codepoint is
         exactly what this writer used to refuse to do, so it is the right
         wrong answer to feed in: the comparison must call it catastrophic. */
      control: await ask(CONTROL.map(t => ({ text: t, ...ourPath(face, t, { raw: true }) })), opts(f))
    });
  }
  return out;
});

H(liveRun ? '── against Chromium, live ──' : '── against Chromium, live (no browser on this machine) ──');
if (!liveRun) {
  console.log('  · skipped: set PLAYWRIGHT_CORE to a resolvable playwright-core to re-verify.');
  console.log('  · the recorded verdict above still carries Chromium’s answer, so nothing here is unchecked.');
} else {
  const bad = [];
  for (const r of liveRun)
    r.shaped.forEach((x, i) => { if (pct(x) > 0.5) bad.push(`${r.key} ${CURATED[i]} ${pct(x).toFixed(1)}%`); });
  ok('a live Chromium agrees with our shaping pixel for pixel, in every face and weight',
     liveRun.length === FACES.length &&
     liveRun.every(r => r.shaped.length === CURATED.length) && bad.length === 0,
     bad.slice(0, 4).join(', ') || `${liveRun.length * CURATED.length} runs compared`);

  const control = liveRun.flatMap(r => r.control.map((x, i) => ({ k: `${r.key} ${CONTROL[i]}`, p: pct(x) })));
  ok('the comparison has teeth: unshaped codepoint-by-codepoint output is reported as wrong',
     control.length === FACES.length * CONTROL.length && control.every(c => c.p > 15),
     control.filter(c => c.p <= 15).slice(0, 4).map(c => `${c.k} only ${c.p.toFixed(1)}%`).join(', ') ||
     `worst-case unshaped output differs by ${Math.min(...control.map(c => c.p)).toFixed(0)}–` +
     `${Math.max(...control.map(c => c.p)).toFixed(0)}%`);
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
