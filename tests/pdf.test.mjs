/* Verification of the PDF/X-4 print writer.
   Builds real files and takes them apart again — header, cross-reference
   table, page boxes, colour operators, output intent — because "it returned
   a Buffer" is not evidence that a press can use it.

   Run with: node tests/pdf.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { engine, specFrom } from '../lib/engine-node.mjs';
import { renderPrintPDF, PrintRefusal, specialsFor } from '../lib/pdf/index.mjs';
import { loadFace, familyOf } from '../lib/pdf/fonts.mjs';
import { toCmyk, tacOf, flatten, TAC_LIMIT } from '../lib/pdf/cmyk.mjs';
import { measureRun } from '../lib/pdf/text.mjs';
import { num, str } from '../lib/pdf/writer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = engine();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name))
       : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')));
};
const H = s => console.log('\n' + s);

const PT_PER_MM = 72 / 25.4;
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

/* ── a small PDF reader, so the assertions look at the file and not at the
      writer's own idea of what it produced ────────────────────────────────── */
function parsePdf(buf) {
  const s = buf.toString('latin1');
  const startxref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  if (!startxref) throw new Error('no startxref/%%EOF');
  const xrefAt = +startxref[1];

  const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt));
  if (!head) throw new Error('xref table is not where startxref says');
  const size = +head[1];
  // Entry 0 is the free-list head and is 20 bytes like every other row.
  const rows = s.slice(xrefAt + head[0].length + 20, xrefAt + head[0].length + size * 20);

  const objects = new Map();
  const offsets = [];
  for (let i = 0; i < size - 1; i++) {
    const row = rows.slice(i * 20, i * 20 + 20);
    const off = +row.slice(0, 10);
    offsets.push(off);
    if (!s.startsWith(`${i + 1} 0 obj\n`, off)) throw new Error(`xref entry ${i + 1} does not point at its object`);
    const end = s.indexOf('\nendobj\n', off);
    objects.set(i + 1, s.slice(off + `${i + 1} 0 obj\n`.length, end));
  }

  const trailer = /trailer\n<< ([\s\S]*?) >>\nstartxref/.exec(s)[1];
  const ref = (dict, key) => {
    const m = new RegExp('/' + key + ' (\\d+) 0 R').exec(dict);
    return m ? objects.get(+m[1]) : null;
  };
  const refNum = (dict, key) => {
    const m = new RegExp('/' + key + ' (\\d+) 0 R').exec(dict);
    return m ? +m[1] : null;
  };
  const streamOf = (n) => {
    const body = objects.get(n);
    const at = body.indexOf('\nstream\n');
    const raw = Buffer.from(body.slice(at + 8, body.lastIndexOf('\nendstream')), 'latin1');
    return /\/Filter \/FlateDecode/.test(body.slice(0, at)) ? zlib.inflateSync(raw) : raw;
  };

  const root = ref(trailer, 'Root');
  const pages = ref(root, 'Pages');
  const pageNum = +/\/Kids \[(\d+) 0 R\]/.exec(pages)[1];
  const page = objects.get(pageNum);

  /* Stream payloads are binary and may contain any byte sequence at all, so
     structural greps have to run over the file WITHOUT them — otherwise a
     compressed ICC profile can spell /FontFile by accident and fail a test
     about something it has nothing to do with. */
  let text = s, at = 0, out = '';
  while ((at = text.indexOf('\nstream\n')) !== -1) {
    const end = text.indexOf('\nendstream', at);
    out += text.slice(0, at + 8);
    text = text.slice(end);
  }
  const structure = out + text;

  return { s, structure, size, objects, offsets, trailer, root, page, pageNum, ref, refNum, streamOf,
           content: streamOf(refNum(page, 'Contents')).toString('latin1') };
}

/* /Title and /Subject carry × and · so they go out as UTF-16BE hex, which is
   the correct encoding and an unreadable one to grep. */
const infoText = (dict, key) => {
  const hex = new RegExp('/' + key + ' <([0-9a-f]+)>').exec(dict);
  if (hex) return Buffer.from(hex[1], 'hex').swap16().toString('utf16le').replace(/^\uFEFF/, '');
  const lit = new RegExp('/' + key + ' \\(((?:[^()\\\\]|\\\\.)*)\\)').exec(dict);
  return lit ? lit[1] : '';
};

const boxOf = (page, key) => {
  const m = new RegExp('/' + key + ' \\[([-\\d. ]+)\\]').exec(page);
  return m ? m[1].trim().split(/\s+/).map(Number) : null;
};

/* ── the design used almost everywhere below ────────────────────────────── */
const CONTENT = E.PRESETS[0].c;
const base = (over = {}) => specFrom({
  format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
  density: 'balanced', layout: 'lay.rule', corner: 0, ...over
}, CONTENT);

const built = renderPrintPDF(base());
const doc = parsePdf(built.composite);

H('── the file is a PDF ──');
ok('starts with a 1.6 header and a binary comment line',
   built.composite.subarray(0, 9).toString('latin1') === '%PDF-1.6\n' &&
   built.composite[9] === 0x25 && built.composite[10] > 0x7f);
ok('ends with %%EOF', /%%EOF\n$/.test(built.composite.toString('latin1')));
ok('every cross-reference offset lands on its object', doc.offsets.length === doc.size - 1);
ok('the trailer /Size matches the object count',
   new RegExp(`/Size ${doc.size}\\b`).test(doc.trailer), doc.trailer.slice(0, 80));
ok('/Root resolves to a catalog', /\/Type \/Catalog/.test(doc.root));
ok('/Info resolves to a document information dictionary',
   /\/Title/.test(doc.ref(doc.trailer, 'Info') || ''));
ok('there is exactly one page', /\/Count 1/.test(doc.ref(doc.root, 'Pages')));
const subject = infoText(doc.ref(doc.trailer, 'Info'), 'Subject');
ok('the press instruction is readable in Document Properties, not only in an email',
   /^Trim 89 × 51 mm, bleed 3 mm/.test(subject) && /outlined/.test(subject) &&
   /maximum ink \d+% of 300%/.test(subject), subject);
/* On a layout that survives the die. A die-cut takes the safe area to 6 mm
   (PRD §7), and `lay.rule` sets this card's contact line at the 6 pt floor
   across the full 4 mm width — the two extra millimetres eliminate it, which
   is the fit ladder working rather than a defect. The refusal that follows
   from that is asserted where the safe area is, further down. */
const rounded = parsePdf(renderPrintPDF(base({ corner: 3, layout: 'lay.centered' })).composite);
ok('a die-cut radius travels with the file rather than beside it',
   /die-cut: rounded corners, 3 mm radius/.test(infoText(rounded.ref(rounded.trailer, 'Info'), 'Subject')),
   infoText(rounded.ref(rounded.trailer, 'Info'), 'Subject'));
ok('a square trim says so, so nobody assumes a die was forgotten',
   /square trim, no die/.test(subject));
ok('the document is not encrypted', !/\/Encrypt/.test(doc.trailer));

H('── PDF/X-4 conformance ──');
ok('the Info dictionary declares GTS_PDFXVersion PDF/X-4',
   /\/GTS_PDFXVersion \(PDF\/X-4\)/.test(doc.ref(doc.trailer, 'Info')));
ok('/Trapped is stated, not left unknown', /\/Trapped \/False/.test(doc.ref(doc.trailer, 'Info')));
ok('the XMP packet declares pdfxid:GTS_PDFXVersion',
   /pdfxid:GTS_PDFXVersion>PDF\/X-4</.test(doc.streamOf(doc.refNum(doc.root, 'Metadata')).toString('utf8')));

const intent = doc.objects.get(+/\/OutputIntents \[(\d+) 0 R\]/.exec(doc.root)[1]);
ok('there is a GTS_PDFX output intent', /\/S \/GTS_PDFX/.test(intent));
ok('the output condition is FOGRA39 against the ICC registry',
   /\/OutputConditionIdentifier \(FOGRA39\)/.test(intent) &&
   /\/RegistryName \(http:\/\/www\.color\.org\)/.test(intent), intent.slice(0, 160));
ok('the intent names its condition in words a press reads',
   /\/OutputCondition \(Coated FOGRA39/.test(intent));

const iccNum = doc.refNum(intent, 'DestOutputProfile');
const icc = doc.streamOf(iccNum);
ok('the output profile is embedded, not merely referenced', iccNum !== null);
ok('the embedded profile is a real CMYK printer ICC profile',
   icc.subarray(36, 40).toString('latin1') === 'acsp' &&
   icc.subarray(16, 20).toString('latin1') === 'CMYK' &&
   icc.subarray(12, 16).toString('latin1') === 'prtr' &&
   icc.readUInt32BE(0) === icc.length,
   `${icc.subarray(12, 20).toString('latin1')} ${icc.readUInt32BE(0)}/${icc.length}`);
ok('the profile stream declares four components',
   /\/N 4/.test(doc.objects.get(iccNum).slice(0, doc.objects.get(iccNum).indexOf('\nstream'))));
ok('the profile is FOGRA39L characterization data, checked inside the file',
   icc.toString('latin1').includes('FOGRA39'));

H('── page geometry ──');
const fmt = E.FORMATS.find(f => f.id === 'bd-std');
const trim = boxOf(doc.page, 'TrimBox'), bleed = boxOf(doc.page, 'BleedBox'), media = boxOf(doc.page, 'MediaBox');
ok('a TrimBox is present', !!trim);
ok('a BleedBox is present', !!bleed);
ok(`the TrimBox is ${fmt.w}×${fmt.h} mm expressed in points`,
   near(trim[2] - trim[0], fmt.w * PT_PER_MM) && near(trim[3] - trim[1], fmt.h * PT_PER_MM),
   `${(trim[2] - trim[0]).toFixed(3)} × ${(trim[3] - trim[1]).toFixed(3)} pt`);
ok('the BleedBox is exactly 3 mm outside the TrimBox on all four edges',
   [0, 1].every(i => near(trim[i] - bleed[i], 3 * PT_PER_MM)) &&
   [2, 3].every(i => near(bleed[i] - trim[i], 3 * PT_PER_MM)),
   bleed.map(v => v.toFixed(2)).join(' '));
ok('the MediaBox contains the BleedBox with room for trim marks',
   media[0] === 0 && media[1] === 0 && media[2] > bleed[2] && media[3] > bleed[3]);
ok('the trim box sits centred in the media box',
   near((media[2] - trim[2]) - trim[0], 0, 0.02), `${trim[0].toFixed(2)} vs ${(media[2] - trim[2]).toFixed(2)}`);

H('── colour is DeviceCMYK throughout ──');
const operators = new Set(doc.content.split('\n').filter(Boolean)
  .map(l => l.trim().split(/\s+/).pop()));
const ALLOWED = new Set(['m', 'l', 'c', 'h', 're', 'f', 'f*', 'S', 'W', 'n', 'q', 'Q',
                         'cm', 'k', 'K', 'w', 'gs', 'cs', 'CS', 'scn', 'SCN']);
ok('the content stream uses no operator outside the print-safe set',
   [...operators].every(o => ALLOWED.has(o)), [...operators].filter(o => !ALLOWED.has(o)).join(' '));
ok('no RGB colour operator appears', !/\brg\b|\bRG\b/.test(doc.content));
ok('no DeviceGray colour operator appears',
   !doc.content.split('\n').some(l => /\s(g|G)$/.test(l.trim())));
ok('no RGB or Gray colour space is named anywhere in the structure',
   !/\/DeviceRGB|\/DeviceGray|\/CalRGB|\/Indexed/.test(doc.structure));
ok('fills are written with the k operator', /\bk$/m.test(doc.content));
ok('trim marks are drawn in the /All separation so they land on every plate',
   /\[\/Separation \/All \/DeviceCMYK/.test(doc.structure) && /\/CSAll CS/.test(doc.content));
ok('overprint is switched off explicitly rather than left to the RIP',
   /\/Type \/ExtGState[^>]*\/OP false[^>]*\/op false/.test(doc.structure) && /\/GSOff gs/.test(doc.content));

H('── no fonts, no transparency, no clock ──');
ok('the file contains no font dictionary', !/\/Type\s*\/Font/.test(doc.structure));
ok('the file contains no /BaseFont entry', !/\/BaseFont/.test(doc.structure));
ok('the file embeds no font programme', !/\/FontFile/.test(doc.structure));
ok('the page resources declare no /Font', !/\/Font/.test(doc.ref(doc.page, 'Resources')));
ok('text was drawn as filled paths, not as text-showing operators',
   !/\bTj\b|\bTJ\b|\bBT\b/.test(doc.content));
ok('there is no transparency group on the page', !/\/Group/.test(doc.page));
ok('no constant-alpha state is set anywhere', !/\/CA |\/ca /.test(doc.structure));
ok('no soft mask is used', !/\/SMask/.test(doc.structure));
ok('no creation or modification date is written',
   !/\/CreationDate|\/ModDate/.test(doc.structure) && !/D:\d{14}/.test(doc.structure));
ok('the XMP packet carries no timestamp either',
   !/CreateDate|ModifyDate|MetadataDate/.test(doc.streamOf(doc.refNum(doc.root, 'Metadata')).toString('utf8')));

H('── determinism ──');
const twice = renderPrintPDF(base());
ok('the same spec produces byte-identical output',
   Buffer.compare(built.composite, twice.composite) === 0,
   `${built.composite.length} vs ${twice.composite.length} bytes`);
const idOf = b => /\/ID \[<([0-9a-f]{32})> <\1>\]/.exec(b.toString('latin1'));
ok('/ID is content-derived and both halves match', !!idOf(built.composite));
ok('a different palette produces a different /ID',
   idOf(renderPrintPDF(base({ palette: 'pal.navy' })).composite)[1] !== idOf(built.composite)[1]);
ok('a different spec produces different bytes',
   Buffer.compare(built.composite, renderPrintPDF(base({ palette: 'pal.navy' })).composite) !== 0);

H('── the ground bleeds ──');
const navy = parsePdf(renderPrintPDF(base({ palette: 'pal.navy' })).composite);
ok('the background is laid down over the whole bleed box, not the trim',
   navy.content.includes(`-3 -3 ${num(fmt.w + 6)} ${num(fmt.h + 6)} re`),
   navy.content.split('\n').slice(0, 6).join(' | '));
const split = parsePdf(renderPrintPDF(base({ layout: 'lay.split', palette: 'pal.gold' })).composite);
ok('a panel that reaches a trim edge is extended into the bleed',
   /(^|\n)-3 -3 [\d.]+ 57 re/.test(split.content), 'no bled panel rect found');

H('── separations ──');
const withFinishes = renderPrintPDF(
  base({ layout: 'lay.centered', palette: 'pal.navy', type: 'typ.noto' }),
  { finishes: ['foil', 'spotuv', 'matte', 'gloss'] });
ok('lamination produces no plate, because it is applied to the whole sheet',
   specialsFor(['matte', 'gloss', 'softtouch', 'rounded']).length === 0);
ok('one plate per special that has one, and no more',
   withFinishes.separations.map(s => s.kind).join(',') === 'foil_gold,spot_uv',
   withFinishes.separations.map(s => s.kind).join(','));
ok('a repeated finish does not produce a second plate',
   renderPrintPDF(base({ layout: 'lay.centered', palette: 'pal.navy', type: 'typ.noto' }),
     { finishes: ['foil', 'foil_gold'] }).separations.length === 1);

const plate = parsePdf(withFinishes.separations[0].bytes);
ok('the plate is spot-named after its colorant',
   /\[\/Separation \/FoilGold \/DeviceCMYK/.test(plate.structure));
ok('the spot resolves to 100% K on white',
   /\/C0 \[0 0 0 0\] \/C1 \[0 0 0 1\]/.test(plate.structure));
ok('the plate carries the same trim and bleed boxes as the artwork',
   boxOf(plate.page, 'TrimBox').join() === trim.join() &&
   boxOf(plate.page, 'BleedBox').join() === bleed.join());
ok('the plate turns overprint off', /\/OP false/.test(plate.structure) && /\/GSOff gs/.test(plate.content));
ok('the plate is choked by stroking its own outline at zero tint',
   /\/CSSpot CS\n0 SCN\n0\.6 w/.test(plate.content), plate.content.slice(-120).replace(/\n/g, '|'));
ok('the choke is the 0.3 mm Technical Design §4.2 specifies',
   withFinishes.separations.every(s => s.chokeMm === 0.3));
ok('the plate reports how much of itself survived the choke',
   withFinishes.separations.every(s => s.retainedPct > 45 && s.retainedPct <= 100),
   withFinishes.separations.map(s => `${s.kind} ${s.retainedPct}%`).join(', '));
ok('the plate carries no artwork other than the finish',
   !plate.content.includes(' k\n'), 'a CMYK fill leaked onto a separation');

H('── refusals ──');
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const elim = refusal(() => renderPrintPDF(base({ layout: 'lay.grid', format: 'bd-port' })));
ok('a layout with no composition for the orientation is refused, not stretched',
   elim instanceof PrintRefusal && elim.code === 'layout_eliminated', elim && elim.code);

/* Bangla was refused outright here until a shaper existed. These assertions
   are inverted rather than deleted, because "this stopped refusing" is a
   claim that needs checking as much as the refusal did — and because a
   regression that quietly brings the refusal back would otherwise be
   indistinguishable from a passing suite. The shaping itself is checked
   glyph for glyph against Chromium in tests/shaping.test.mjs; what is
   checked here is that the writer takes it as far as a press file. */
const banglaCard = renderPrintPDF(base({ layout: 'back.bangla' }));
ok('a Bangla card produces a press file rather than a refusal',
   banglaCard.composite.subarray(0, 9).toString('latin1') === '%PDF-1.6\n');
ok('the Bangla card lays real outlines down rather than an empty page',
   banglaCard.drift.runs.length >= 3 && banglaCard.drift.runs.every(r => r.measuredMm > 1),
   JSON.stringify(banglaCard.drift.runs.map(r => `${r.ref} ${r.measuredMm}mm`)));

const BN = E.TYPE_SYSTEMS.find(t => t.id === 'typ.siliguri').bangla;
const w = (s) => measureRun(s, BN, 400, 0, 10);
ok('a conjunct is one glyph and not two letters standing side by side',
   w('ক্ষ') < 0.8 * (w('ক') + w('ষ')), `ক্ষ ${w('ক্ষ').toFixed(2)} vs ক+ষ ${(w('ক') + w('ষ')).toFixed(2)}`);
ok('a reph rides the cluster rather than occupying a place of its own',
   w('র্ক') < 0.9 * (w('র') + w('ক')), `র্ক ${w('র্ক').toFixed(2)} vs র+ক ${(w('র') + w('ক')).toFixed(2)}`);
ok('a below-base ra-phala costs less width than a ra written out',
   w('ক্র') < 0.9 * (w('ক') + w('র')), `ক্র ${w('ক্র').toFixed(2)}`);
ok('the pre-base vowel ি is drawn, and the halant that formed nothing is not',
   w('কি') > w('ক') && w('ক্') <= w('ক') * 1.02, `কি ${w('কি').toFixed(2)}, ক্ ${w('ক্').toFixed(2)}`);

/* Bangla text that is not a syllable is still refused. A shaper for a screen
   answers this with a dotted circle; a press file has nobody to tell. */
const brokenBangla = refusal(() => renderPrintPDF(
  specFrom({ format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
             density: 'balanced', layout: 'back.bangla', corner: 0 },
           { ...CONTENT, bname: 'িক ্ব' })));
ok('a Bangla cluster that is not a syllable is refused by name, not drawn around',
   brokenBangla instanceof PrintRefusal && brokenBangla.code === 'bangla_broken_cluster',
   brokenBangla && brokenBangla.code);
ok('that refusal quotes the characters it choked on, so the text can be corrected',
   /U\+09BF/.test(brokenBangla.message), brokenBangla && brokenBangla.message.slice(0, 120));

const thin = refusal(() => renderPrintPDF(
  base({ layout: 'lay.split', palette: 'pal.gold' }), { finishes: ['foil'] }));
ok('a plate the choke would consume is refused with its retained percentage',
   thin instanceof PrintRefusal && thin.code === 'choke_consumes_plate' && /\d+% of the plate/.test(thin.message),
   thin && thin.code);

const noCarrier = renderPrintPDF(base({ layout: 'lay.editorial' }), { finishes: ['emboss'] });
ok('a composition with nothing to plate produces no plate rather than an empty one',
   noCarrier.separations.length === 0, JSON.stringify(noCarrier.separations.map(s => s.kind)));
const plated = renderPrintPDF(base({ layout: 'lay.corner' }), { finishes: ['emboss'] });
ok('a finish rides on the mark, which is the smallest plate that still reads',
   plated.separations.length === 1 && plated.separations[0].carriers.join() === 'mark',
   JSON.stringify(plated.separations.map(s => s.carriers)));
const bleeding = refusal(() => renderPrintPDF(base({ layout: 'lay.bleed' }), { finishes: ['foil'] }));
ok('a finish carrier that crosses the 2 mm trim clearance is refused',
   bleeding instanceof PrintRefusal && bleeding.code === 'finish_crosses_trim_clearance',
   bleeding && bleeding.code);

/* No shipped combination produces a blocking finding — the fit ladder
   eliminates a layout before preflight can fail it, which is asserted below.
   The refusal path is therefore driven through the seam it actually reads. */
const realPreflight = E.preflight;
E.preflight = (c) => [...realPreflight(c), { s: 'fail', label: 'Injected blocking finding', note: 'test' }];
const blocked = refusal(() => renderPrintPDF(base()));
// The same call again, this time asking nicely.
const forced = refusal(() => renderPrintPDF(base(),
  { force: true, override: true, skipPreflight: true, acceptFindings: ['*'] }));
E.preflight = realPreflight;
ok('a blocking preflight finding refuses the export outright',
   blocked instanceof PrintRefusal && blocked.code === 'preflight_blocking', blocked && blocked.code);
ok('the refusal carries the finding, so the screen can show it',
   blocked.findings.some(f => f.label === 'Injected blocking finding'));
ok('no option a caller can pass turns a blocking finding into an export',
   forced instanceof PrintRefusal && forced.code === 'preflight_blocking', forced && forced.code);

H('── the writer against the whole library ──');
/* Drift is split by script, and that split is the finding rather than a
   convenience. The composer charges a flat 0.62 em for every Bangla
   codepoint (lib/engine-node.mjs `advance`, and the matching table in the
   browser). Shaping collapses three codepoints into one conjunct, so the
   real run is far narrower than the estimate — every Bangla element on a
   shipped card measures 20–40% under what the fit ladder was told. It is
   reported here rather than smoothed into one number, because a single
   widened bound would hide a real disagreement between the two halves of
   the system that has to be closed on both sides at once. */
const BANGLA = /[ঀ-৿]/;
let wrote = 0, refused = {}, worstLatin = 0, worstBangla = 0;
for (const P of E.PRESETS) {
  for (const L of E.LAYOUTS.filter(l => l.face === 'front')) {
    const spec = specFrom({ format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
                            density: 'balanced', layout: L.id, corner: 0 }, P.c);
    let r;
    try {
      r = renderPrintPDF(spec);
      wrote++;
    } catch (e) {
      if (!(e instanceof PrintRefusal)) throw e;
      refused[e.code] = (refused[e.code] || 0) + 1;
      continue;
    }
    const c = E.compose(spec);
    for (const run of r.drift.runs) {
      const el = c.elements.find(x => (x.ref || x.kind) === run.ref);
      const bn = el && el.fit && (el.fit.lines || []).some(l => BANGLA.test(String(l)));
      if (bn) worstBangla = Math.max(worstBangla, Math.abs(run.deltaPct));
      else worstLatin = Math.max(worstLatin, Math.abs(run.deltaPct));
    }
  }
}
ok('most preset × layout combinations produce a press file', wrote > 40, `${wrote} written`);
ok('nothing was refused for a reason the writer invented',
   Object.keys(refused).every(c => ['outside_safe_area', 'layout_eliminated'].includes(c)),
   JSON.stringify(refused));
ok('no shipped composition trips a blocking preflight finding',
   !refused.preflight_blocking);
ok('real font metrics are reported against the composer’s estimate',
   worstLatin > 0 && worstLatin < 25, `worst Latin width drift ${worstLatin}%`);
/* This assertion used to record a defect: the composer charged a flat 0.62 em
   per Bangla codepoint while shaping makes one conjunct out of three, so the
   estimate ran 15–45% wide and Bangla type was driven toward the 7.5 pt floor
   a third earlier than the text needed. The metric model now measures Bangla
   by cluster — a halant subtracts, a matra costs a quarter — and the drift is
   in the same band as Latin. Kept as a guard on the other side: if it widens
   again, some copy of the model has drifted back. */
ok('the composer’s Bangla estimate now tracks what actually prints',
   worstBangla > 0 && worstBangla < 12,
   `worst Bangla width drift ${worstBangla}% — was 15–45% when the model charged ` +
   `a flat 0.62 em per codepoint`);

H('── the library policy is enforced, not documented ──');
for (const T of E.TYPE_SYSTEMS) {
  const fams = [[T.latin, 'latin'], [T.bangla, 'bangla']];
  ok(`${T.id} resolves both its faces to vendored binaries`,
     fams.every(([stack]) => [400, 600, 700, 800].every(w => {
       try { return !!loadFace(stack, w); } catch { return false; } })),
     fams.map(([s]) => familyOf(s)).join(' + '));
}
ok('every vendored family ships its OFL text',
   fs.readdirSync(path.join(ROOT, 'assets/fonts')).filter(f => f.endsWith('.ttf'))
     .every(f => fs.existsSync(path.join(ROOT, 'assets/fonts', f.replace(/-\d{3}\.ttf$/, '.OFL.txt')))));
ok('a weight a family does not publish falls back to its nearest published one',
   loadFace("'IBM Plex Mono',monospace", 800).weight === 700);
ok('the writer branches on no layout id, exactly as the renderer does not',
   !fs.readdirSync(path.join(ROOT, 'lib/pdf')).filter(f => f.endsWith('.mjs'))
     .some(f => /['"`]lay\.[a-z]/.test(fs.readFileSync(path.join(ROOT, 'lib/pdf', f), 'utf8'))));

H('── the TrueType reader ──');
const face = loadFace("'Archivo',sans-serif", 700);
ok('the em square is read from head', face.unitsPerEm >= 1000 && face.unitsPerEm <= 4096, String(face.unitsPerEm));
ok('cmap maps a codepoint to a glyph', face.glyphIdFor(0x41) > 0);
ok('an unmapped codepoint returns glyph 0 rather than guessing', face.glyphIdFor(0x0995) === 0);
const A = face.pathFor(face.glyphIdFor(0x41));
ok('a glyph comes back as a closed contour path',
   A.length > 3 && A[0][0] === 'm' && A[A.length - 1][0] === 'h');
ok('quadratic contours are elevated to cubics, never dropped to lines',
   face.pathFor(face.glyphIdFor(0x53)).some(c => c[0] === 'c'));
ok('a composite glyph pulls in its components',
   face.pathFor(face.glyphIdFor(0xc1)).length > A.length, 'Á should carry A plus its accent');
ok('advance widths are plausible for a Latin capital',
   face.advanceEm(face.glyphIdFor(0x41)) > 0.4 && face.advanceEm(face.glyphIdFor(0x41)) < 0.95);
ok('measured runs add per-glyph advances and the tracking gaps',
   near(measureRun('AA', "'Archivo',sans-serif", 700, 0.1, 10),
        2 * face.advanceEm(face.glyphIdFor(0x41)) * 10 + 1, 0.001));
ok('a font file that is not vendored fails by name, never by substitution',
   refusal(() => loadFace("'Comic Sans MS',cursive", 400)).message.includes('Comic Sans MS'));

H('── colour arithmetic ──');
ok('white costs no ink', tacOf('#ffffff') === 0);
ok('black is separated to K alone, not to four plates at 400%', tacOf('#000000') === 100);
ok('the CMYK separation matches the engine’s own preflight arithmetic',
   E.PALETTES.every(p => tacOf(p.bg) <= 300 && tacOf(p.accent) <= 300));
ok('the coated and uncoated ceilings are the ones §6.1 states',
   TAC_LIMIT.coated === 300 && TAC_LIMIT.uncoated === 280);
ok('a colour over the ceiling would be caught',
   tacOf('#0a0a0a') + 0 > 0 && toCmyk('#0a0a0a').k > 0.9);
ok('an overlay is flattened against its ground rather than made transparent',
   flatten('#000000', 0.5, '#ffffff') === '#808080');
ok('every shipped palette is printable on coated stock without refusal',
   E.PALETTES.every(p => ['bg', 'fg', 'accent', 'muted', 'hair', 'panel']
     .every(k => tacOf(p[k]) <= TAC_LIMIT.coated)));

H('── number and string formatting ──');
ok('numbers are written without trailing zeros', num(10) === '10' && num(0.5) === '0.5');
ok('negative zero is normalised', num(-0.00001) === '0');
ok('a non-finite number is refused rather than written',
   refusal(() => num(NaN)) instanceof Error);
ok('ASCII strings are literal and escaped', str('a(b)') === '(a\\(b\\))');
ok('non-ASCII strings go out as UTF-16BE hex', str('মা').startsWith('<feff'));

H('── the endpoint ──');
const { default: renderPrint } = await import('../netlify/functions/render-print.mjs');
const call = (init) => renderPrint(new Request('https://cardworks.bd/api/render-print', init), {});
const post = (b) => call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

const probe = await call({});
ok('a GET answers, so the client can tell a missing writer from a present one', probe.status === 200);
const capability = await probe.json();
ok('the GET states what the writer cannot do rather than leaving it to be discovered',
   /300\s?dpi|vector/i.test(capability.cannotYet.logos) && /kern/i.test(capability.cannotYet.latinKerning));
ok('the GET no longer advertises a Bangla limitation the writer does not have',
   !('bangla' in capability.cannotYet) && /conjunct|যুক্তাক্ষর/.test(capability.canNow.bangla),
   JSON.stringify(Object.keys(capability.cannotYet)));
ok('the GET lists the faces this build actually holds',
   Object.keys(capability.fonts).length === 8, Object.keys(capability.fonts).join(','));

const good = await post({ spec: base({ layout: 'lay.corner', palette: 'pal.navy' }), finishes: ['foil', 'matte'] });
ok('a printable spec comes back as PDF bytes', good.status === 200 && good.headers.get('content-type') === 'application/pdf');
ok('the response is a download with a named file',
   /^attachment; filename="cardworks_.*_print\.pdf"$/.test(good.headers.get('content-disposition')),
   good.headers.get('content-disposition'));
ok('the response says which plates exist, so the client need not guess',
   good.headers.get('x-cardworks-separations') === 'foil_gold', good.headers.get('x-cardworks-separations'));
ok('the response reports the ink it laid down against the limit',
   /^\d+\/300$/.test(good.headers.get('x-cardworks-tac')), good.headers.get('x-cardworks-tac'));
ok('the bytes are the same file lib/pdf produced',
   Buffer.from(await good.arrayBuffer()).subarray(0, 9).toString('latin1') === '%PDF-1.6\n');

const plateRes = await post({ spec: base({ layout: 'lay.corner' }), finishes: ['foil'], part: 'foil_gold' });
ok('a named plate can be fetched on its own', plateRes.status === 200 &&
   /_foil_gold\.pdf"$/.test(plateRes.headers.get('content-disposition')));
const absent = await post({ spec: base({ layout: 'lay.corner' }), part: 'spot_uv' });
ok('asking for a plate that was not ordered 404s and says what there is', absent.status === 404);

const rejected = await post({ spec: { ...base(), layout: 'not-a-layout' } });
ok('a spec naming a record the library does not hold is a 400 that names the field',
   rejected.status === 400 && (await rejected.json()).error.field === 'spec.layout');
const unprintable = await post({ spec: specFrom(
  { format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
    density: 'balanced', layout: 'back.bangla', corner: 0 },
  { ...CONTENT, bname: 'িক ্ব' }) });
const envelope = await unprintable.json();
ok('an unprintable design is 422, not 400 — the request was fine, the card is not',
   unprintable.status === 422 && envelope.error.code === 'bangla_broken_cluster',
   `${unprintable.status} ${envelope.error && envelope.error.code}`);
const printableBangla = await post({ spec: base({ layout: 'back.bangla' }) });
ok('a well-formed Bangla card comes back as PDF bytes from the endpoint too',
   printableBangla.status === 200 && printableBangla.headers.get('content-type') === 'application/pdf',
   String(printableBangla.status));
ok('the error envelope carries a remediation the screen can render',
   typeof envelope.error.remediation === 'string' && envelope.error.remediation.length > 10,
   envelope.error.remediation);
ok('neither a shortCode nor a spec is a 400, not a crash', (await post({})).status === 400);
ok('an unsupported method is 405 in the standard envelope',
   (await call({ method: 'DELETE' })).status === 405);

H('── the safe area the file goes out with ──');
/* Master PRD §7 puts the safe area at 4 mm plain, 5 mm for a finish that is
   registered onto the printed sheet in a second pass, and 6 mm for a die-cut.
   The finish list is an argument to this function rather than a field of the
   spec, so the writer is the one place that knows the difference between a
   design that could be foiled and a job that will be — which makes it the one
   place that can get this wrong without anybody noticing until the gold lands
   on the name. */
const safeOf = (over, opts) => renderPrintPDF({ ...base(over), layout: 'lay.centered', ...over },
                                              opts).document.safeMm;
ok('a plain job goes out at the trim record\'s 4 mm', safeOf({}, {}) === 4, String(safeOf({}, {})));
ok('lamination and spot UV do not move it', safeOf({}, { finishes: ['matte', 'gloss', 'spotuv'] }) === 4);
for (const fin of ['foil', 'emboss', 'letterpress', 'edgepaint'])
  ok(`a ${fin} job goes out at 5 mm`, safeOf({}, { finishes: [fin] }) === 5,
     String(safeOf({}, { finishes: [fin] })));
ok('a die-cut job goes out at 6 mm', safeOf({ corner: 3 }, {}) === 6, String(safeOf({ corner: 3 }, {})));
ok('a foiled and die-cut job takes the larger of the two',
   safeOf({ corner: 3 }, { finishes: ['foil'] }) === 6);

/* Stated in the file, not only in the response. The press reads Document
   Properties; nobody there has the JSON this function also returned. */
const foiled = renderPrintPDF(base({ layout: 'lay.centered' }), { finishes: ['foil'] });
ok('the file itself says which safe area it was composed against',
   /safe area 5 mm/.test(infoText(parsePdf(foiled.composite).ref(parsePdf(foiled.composite).trailer, 'Info'), 'Subject')),
   infoText(parsePdf(foiled.composite).ref(parsePdf(foiled.composite).trailer, 'Info'), 'Subject'));

/* The order's list wins over anything the design record carries, in both
   directions. A design saved with foil that is being quoted plain must not
   pay for a foil block's tolerance, and a design saved plain that is being
   produced foiled must. */
const specSaysFoil = { ...base({ layout: 'lay.centered' }), finishes: ['foil'] };
ok('a design that remembers foil, ordered plain, composes at 4 mm',
   renderPrintPDF(specSaysFoil, { finishes: [] }).document.safeMm === 4);
ok('a design that remembers nothing, ordered foiled, composes at 5 mm',
   renderPrintPDF(base({ layout: 'lay.centered' }), { finishes: ['foil'] }).document.safeMm === 5);

/* The seam this file sits on: the writer refuses against the safe area, and
   the engine places content against it. If those were two numbers rather than
   one, the writer would hand a press a file whose own geometry check had been
   run at a different tolerance from the one that positioned the text. */
for (const [finishes, corner] of [[[], 0], [['foil'], 0], [[], 3], [['emboss'], 2]]) {
  const spec = base({ layout: 'lay.centered', corner });
  const wrote = renderPrintPDF(spec, { finishes }).document.safeMm;
  const composed = E.compose({ ...spec, finishes }).fmt.safe;
  ok(`the writer and the composer agree at ${wrote} mm (finishes ${finishes.join('+') || 'none'}, corner ${corner})`,
     wrote === composed, `writer ${wrote}, composer ${composed}`);
  const inside = E.compose({ ...spec, finishes }).elements.filter(e => e.fit)
    .every(e => e.geom.x >= wrote - 1e-9 && e.geom.y >= wrote - 1e-9 &&
                e.geom.x + e.geom.w <= E.FORMATS.find(f => f.id === spec.format).w - wrote + 1e-9);
  ok(`and every run in that file was placed inside ${wrote} mm`, inside);
}

/* The cost, asserted rather than left as a surprise. `lay.rule` sets this
   card's contact line at the 6 pt floor across the full width, so the two
   millimetres a die takes eliminate it — and the writer refuses instead of
   printing a card whose contact line the die would clip. Eight of the nine
   front layouts still compose, so the die narrows the choice rather than
   removing it. */
const diedRule = refusal(() => renderPrintPDF(base({ corner: 2 })));
ok('a layout the die-cut safe area eliminates is refused rather than trimmed into',
   diedRule instanceof PrintRefusal && diedRule.code === 'layout_eliminated' &&
   /contact cannot fit/.test(diedRule.message), diedRule && diedRule.code);
const dieable = E.LAYOUTS.filter(l => l.face === 'front')
  .filter(l => !E.compose({ ...base({ layout: l.id, corner: 2 }), finishes: ['foil'] }).eliminated);
ok('a die-cut card still has most of the library to compose on',
   dieable.length >= 8, `${dieable.length} of ${E.LAYOUTS.filter(l => l.face === 'front').length} layouts`);

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
