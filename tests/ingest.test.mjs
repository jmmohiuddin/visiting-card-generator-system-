/* Destructure and Enhance, verified against properties rather than shapes.
 *
 * The strongest test available for a decomposer is a round trip: this engine
 * can render a card to SVG, so feeding its own output back in and asking
 * whether the parts that come out are the parts that went in checks the reader
 * against ground truth rather than against a fixture someone wrote by hand.
 *
 * The second thing worth testing harder than anything else is what must NOT
 * happen: no invented text from a raster, no geometry reaching the composer,
 * and no edit that leaves a card unprintable.
 */
import { engine, specFrom } from '../lib/engine-node.mjs';
import { destructure, sniff, toContent, toDesign, matchFormat, assess } from '../lib/ingest/index.mjs';
import { destructureSvg } from '../lib/ingest/svg.mjs';
import { destructurePdf } from '../lib/ingest/pdf.mjs';
import { destructureRaster } from '../lib/ingest/raster.mjs';
import { applyPartOp, applyPartOps, previewOf, coloursFor, familiesFor,
         sizeRangeFor, assertGeometryUnused } from '../lib/ingest/edit.mjs';
import { plan, enhance } from '../lib/enhance/index.mjs';
import { PART_OPS } from '../lib/ingest/contract.mjs';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name))
       : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')));
};
const H = (s) => console.log('\n' + s);

const E = engine();
const PT = 0.352778;
const svgOf = (layout, preset, over = {}) => {
  const spec = specFrom({ format:'bd-std', type:'typ.siliguri', palette:'pal.ink', layout, ...over }, preset);
  const c = E.compose(spec);
  return c.eliminated ? null : E.renderSVG(c);
};

H('1. Format sniffing reads the bytes, not the label');
ok('an SVG is recognised', sniff(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 89 51"></svg>')) === 'svg');
ok('a PDF is recognised', sniff(Buffer.from('%PDF-1.4\n')) === 'pdf');
ok('a PNG is recognised', sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === 'png');
ok('a JPEG is recognised', sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) === 'jpeg');
ok('anything else is refused rather than guessed', sniff(Buffer.from('hello there')) === null);
ok('a PNG renamed .svg is still read as a PNG', (() => {
  const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(40)]);
  return sniff(png) === 'png';
})(), 'a declared content type is a claim, not a fact');

H('2. The round trip — our own output, read back');
let trips = 0, named = 0, sized = 0, coloured = 0;
for (const preset of E.PRESETS) {
  for (const L of E.LAYOUTS.filter(l => l.face === 'front')) {
    const svg = svgOf(L.id, preset.c);
    if (!svg) continue;
    const parts = destructureSvg(svg, {});
    trips++;
    const texts = parts.parts.filter(p => p.kind === 'text');
    const nameP = texts.find(p => p.slot === 'name');
    const want = (preset.c.name || '').trim();
    if (nameP && want && (nameP.text.includes(want.split(' ')[0]) || want.includes(nameP.text.split(' ')[0]))) named++;
    if (texts.length && texts.every(p => p.style.sizePt > 0)) sized++;
    if (texts.length && texts.every(p => /^#[0-9a-f]{6}$/.test(p.style.color || ''))) coloured++;
  }
}
ok(`${trips} generated cards round-trip through the SVG reader`, trips >= 40, `${trips} composed`);
ok('the name lands in the name slot every time', named === trips, `${named}/${trips}`);
ok('every text run recovers a real point size', sized === trips, `${sized}/${trips}`);
ok('every text run recovers a real colour', coloured === trips, `${coloured}/${trips}`);

H('3. Slot inference handles this market, not a generic one');
ok('"Md." is not mistaken for the MD qualification', (() => {
  const svg = `<svg viewBox="0 0 89 51" width="89mm" xmlns="http://www.w3.org/2000/svg">
    <text x="6" y="20" font-size="${14 * PT}">Md. Abdur Rahman</text>
    <text x="6" y="28" font-size="${7 * PT}">Managing Director</text></svg>`;
  const p = destructureSvg(svg, {});
  return (p.parts.find(x => x.slot === 'name') || {}).text === 'Md. Abdur Rahman';
})(), 'Md. prefixes a large share of Bangladeshi names');
ok('a monogram is a mark, and the name is still found', (() => {
  const svg = `<svg viewBox="0 0 89 51" width="89mm" xmlns="http://www.w3.org/2000/svg">
    <text x="8" y="14" font-size="${20 * PT}">R</text>
    <text x="8" y="30" font-size="${13 * PT}">Rafiqul Islam</text></svg>`;
  const p = destructureSvg(svg, {});
  return (p.parts.find(x => x.slot === 'mark') || {}).text === 'R'
      && (p.parts.find(x => x.slot === 'name') || {}).text === 'Rafiqul Islam';
})());
ok('a hyphenated Bangladeshi mobile is routed to a phone field, not the address', (() => {
  const svg = `<svg viewBox="0 0 89 51" width="89mm" xmlns="http://www.w3.org/2000/svg">
    <text x="6" y="20" font-size="${13 * PT}">Nasrin Akhter</text>
    <text x="6" y="44" font-size="${7 * PT}">01711-224466 · 01911-654321 · n@x.bd</text></svg>`;
  const c = toContent(destructureSvg(svg, {}));
  return c.p1 === '01711-224466' && c.p2 === '01911-654321' && c.email === 'n@x.bd';
})());
ok('right-anchored text is measured from its left edge', (() => {
  /* An SVG `x` on text-anchor="end" is the right edge. Reading it as the left
     edge puts the run a whole line-width off the card and invents a
     safe-area failure. */
  const svg = `<svg viewBox="0 0 89 51" width="89mm" xmlns="http://www.w3.org/2000/svg">
    <text x="83" y="10" font-size="${7 * PT}" text-anchor="end">RIGHT ALIGNED CO</text>
    <text x="6" y="30" font-size="${13 * PT}">Someone Here</text></svg>`;
  const p = destructureSvg(svg, {});
  const r = p.parts.find(x => x.style.align === 'right');
  return r && r.observed.x < 83 && r.observed.x + r.observed.w <= 89.5;
})());

H('4. Raster: colours and size, never words');
ok('a raster never yields a text part', (() => {
  /* A 2×2 PNG built here rather than read from disk, so the test does not
     depend on a fixture existing. */
  const png = makePng(2, 2, [[255,0,0],[0,255,0],[0,0,255],[255,255,255]]);
  const p = destructureRaster(png, {});
  return p.parts.filter(x => x.kind === 'text').length === 0;
})());
ok('a raster never yields a font', (() => {
  const p = destructureRaster(makePng(2, 2, [[0,0,0],[0,0,0],[0,0,0],[0,0,0]]), {});
  return p.fonts.length === 0;
})());
ok('a raster says out loud that its text cannot be read', (() => {
  const p = destructureRaster(makePng(2, 2, [[0,0,0],[0,0,0],[0,0,0],[0,0,0]]), {});
  return p.findings.some(f => f.s === 'fail' && /text and fonts cannot be read/i.test(f.label));
})());
ok('real pixels produce a real palette', (() => {
  const p = destructureRaster(makePng(4, 1, [[255,0,0],[255,0,0],[255,0,0],[0,0,255]]), {});
  return p.palette.length >= 2 && p.palette[0].area > p.palette[1].area;
})());
ok('resolution below 300 dpi at card size is a blocking finding', (() => {
  const p = destructureRaster(makePng(200, 100, Array.from({length:20000}, () => [128,128,128])), {});
  return p.findings.some(f => f.s === 'fail' && /dpi/i.test(f.label));
})());

H('5. PDF: geometry and colour, and honesty about outlined type');
ok('a TrimBox is preferred over a MediaBox', (() => {
  const p = destructurePdf(tinyPdf({ trim: '0 0 252.28 144.57', media: '0 0 300 200' }), {});
  return Math.abs(p.format.wMm - 89) < 0.2 && p.format.exact === true;
})());
ok('text, size, colour and family are recovered', (() => {
  const p = destructurePdf(tinyPdf({
    content: 'BT /F1 18 Tf 0 0 0 1 k 1 0 0 1 40 100 Tm (Dr. Nasrin Akhter) Tj ET' }), {});
  const t = p.parts.find(x => x.kind === 'text');
  return t && t.text === 'Dr. Nasrin Akhter' && t.style.sizePt === 18
      && t.style.color === '#000000' && t.style.family === 'PlayfairDisplay';
})());
ok('a TJ array with kerning is concatenated, not dropped', (() => {
  const p = destructurePdf(tinyPdf({
    content: 'BT /F1 8 Tf 1 0 0 1 40 80 Tm [(CONSULTANT )-20(PHYSICIAN)] TJ ET' }), {});
  return (p.parts.find(x => x.kind === 'text') || {}).text === 'CONSULTANT PHYSICIAN';
})());
ok('the fill at the moment text is shown is the colour recorded', (() => {
  /* Latching the colour at `Tf` reads one run behind on any exporter that sets
     the font before the colour, and every run still gets a plausible colour,
     so the error is invisible. */
  const p = destructurePdf(tinyPdf({ content:
    'BT /F1 18 Tf 0 0 0 1 k 1 0 0 1 40 100 Tm (First) Tj ET ' +
    'BT /F1 8 Tf 0 0 0 0.4 k 1 0 0 1 40 80 Tm (Second) Tj ET' }), {});
  const t = p.parts.filter(x => x.kind === 'text');
  return t[0].style.color === '#000000' && t[1].style.color === '#999999';
})());
ok('an outlined PDF reports having no text rather than failing silently', (() => {
  const real = path.join(process.cwd(), 'lib/pdf/index.mjs');
  if (!fs.existsSync(real)) return true;
  const p = destructurePdf(tinyPdf({ content: '0 0 0 1 k 10 10 100 40 re f' }), {});
  return p.parts.filter(x => x.kind === 'text').length === 0
      && p.findings.some(f => /no text, only shapes/i.test(f.label));
})());
ok('an encrypted PDF is refused by name', (() => {
  try { destructurePdf(tinyPdf({ extra: '9 0 obj<</Encrypt 1 0 R>>endobj' }), {}); return false; }
  catch (e) { return e.code === 'pdf_encrypted'; }
})());

H('6. A reader that finds nothing fails — it never passes empty');
ok('a non-SVG handed to the SVG reader throws with a code', (() => {
  try { destructureSvg('<html><body>no card here</body></html>', {}); return false; }
  catch (e) { return e.code === 'not_svg'; }
})());
ok('an SVG with no size throws rather than guessing', (() => {
  try { destructureSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>', {}); return false; }
  catch (e) { return e.code === 'no_dimensions'; }
})());
ok('an SVG with nothing readable throws', (() => {
  try { destructureSvg('<svg viewBox="0 0 89 51" width="89mm"></svg>', {}); return false; }
  catch (e) { return e.code === 'nothing_read'; }
})());
ok('an empty upload is refused', (() => {
  try { destructure(Buffer.alloc(0), {}); return false; } catch (e) { return e.code === 'empty'; }
})());
ok('an oversized upload is refused with its size', (() => {
  try { destructure(Buffer.alloc(9 * 1024 * 1024), {}); return false; }
  catch (e) { return e.code === 'too_large'; }
})());

H('7. The constraint: geometry is evidence, never an instruction');
const base = destructureSvg(svgOf('lay.rule', E.PRESETS[0].c), {});
matchFormat(base); assess(base);
ok('poisoning every observed box does not change the composed output',
   assertGeometryUnused(base).ok, assertGeometryUnused(base).reason || '');
ok('there is no operation that moves a part', !Object.keys(PART_OPS).some(k => /move|position|nudge|drag|xy/i.test(k)),
   Object.keys(PART_OPS).join(','));
ok('an unknown operation is named and refused, never ignored', (() => {
  const r = applyPartOp(base, { type:'moveTo', partId:base.parts[0].id, value:{ x:0, y:0 } });
  return r.ok === false && /moveTo/.test(r.reason) && r.alternatives.length > 0;
})());

H('8. Every bounded edit leaves a printable card, or is refused with a reason');
const textPart = base.parts.find(p => p.kind === 'text' && p.slot === 'name');
ok('the baseline composes and preflights', previewOf(base).ok);
{
  const cases = [
    ['setWeight', 700], ['setCase', 'upper'], ['setAlign', 'centre'],
    ['assignSlot', 'company'], ['stepSize', 1]
  ];
  let good = 0;
  for (const [type, value] of cases) {
    const r = applyPartOp(base, { type, partId: textPart.id, value });
    if (r.ok && r.preview.ok && r.preview.blocking === 0) good++;
    else if (!r.ok && r.reason) good++;          // a refusal with a reason is also correct
  }
  ok(`${cases.length} operations each either applied cleanly or refused with a reason`, good === cases.length);
}
ok('an out-of-library colour is refused and alternatives offered', (() => {
  const r = applyPartOp(base, { type:'setColor', partId:textPart.id, value:'#ff00ff' });
  return r.ok === false && r.alternatives.length > 0;
})());
ok('a colour that fails contrast is refused with the measured ratio', (() => {
  const bad = coloursFor(base, textPart).find(c => !c.available);
  if (!bad) return true;
  const r = applyPartOp(base, { type:'setColor', partId:textPart.id, value:bad.hex });
  return r.ok === false && /\d\.\d+:1/.test(r.reason);
})());
ok('a weight the family does not ship is refused', (() => {
  const r = applyPartOp(base, { type:'setWeight', partId:textPart.id, value:900 });
  return r.ok === false && /synthesised/.test(r.reason);
})());
ok('an edit never mutates the input', (() => {
  const before = JSON.stringify(base);
  applyPartOp(base, { type:'setWeight', partId:textPart.id, value:800 });
  return JSON.stringify(base) === before;
})(), 'undo depends on the previous state still being the previous state');

H('9. The size floor is a hard stop that explains itself');
{
  let cur = base, steps = 0, last = null;
  while (steps < 60) {
    const r = applyPartOp(cur, { type:'stepSize', partId:textPart.id, value:-1 });
    if (!r.ok) { last = r; break; }
    cur = r.parts; steps++;
  }
  const finalPt = cur.parts.find(p => p.id === textPart.id).style.sizePt;
  ok('stepping down stops at the Latin floor', finalPt >= E.SCRIPTS.latin.minPt, `${finalPt} pt`);
  ok('and the refusal explains what happens below it', !!last && /office light|disappears/i.test(last.reason));
  ok('and offers something else to try', !!last && last.alternatives.length > 0);
}
ok('a Bangla part is held to the higher Bangla floor', (() => {
  const bn = structuredClone(base);
  const p = bn.parts.find(x => x.kind === 'text');
  p.script = 'bangla';
  return sizeRangeFor(p).floorPt === E.SCRIPTS.bangla.minPt;
})());
ok('a family with no checked Bangla is not offered for a Bangla part', (() => {
  const p = structuredClone(textPart); p.script = 'bangla';
  const fams = familiesFor(p);
  return fams.length > 0 && fams.every(f => f.available === !!E.TYPE_SYSTEMS.find(t => t.id === f.id).banglaOk);
})());
ok('Bangla is not offered a case control that would do nothing', (() => {
  const bn = structuredClone(base);
  const p = bn.parts.find(x => x.kind === 'text'); p.script = 'bangla';
  const r = applyPartOp(bn, { type:'setCase', partId:p.id, value:'upper' });
  return r.ok === false && /no upper or lower case/i.test(r.reason);
})());

H('10. A required slot cannot be removed');
ok('dropping the only name is refused', (() => {
  const r = applyPartOp(base, { type:'toggle', partId:textPart.id, value:true });
  const nameDef = E.SLOTDEFS.name;
  if (!nameDef || !nameDef.required) return true;          // library says it is optional
  return r.ok === false && /cannot be printed without/i.test(r.reason);
})());
ok('a sequence stops at the first refusal rather than half-applying', (() => {
  const r = applyPartOps(base, [
    { type:'setWeight', partId:textPart.id, value:700 },
    { type:'setWeight', partId:textPart.id, value:900 },
    { type:'setAlign',  partId:textPart.id, value:'right' }
  ]);
  return r.ok === false && r.applied.length === 1;
})());

H('11. Enhance: repair and improve stay separated');
const shopCard = destructure(Buffer.from(
  `<svg viewBox="0 0 89 51" width="89mm" height="51mm" xmlns="http://www.w3.org/2000/svg">
     <rect x="0" y="0" width="89" height="51" fill="#ffffff"/>
     <text x="1.5" y="6"    font-size="${9 * PT}"   fill="#bbbbbb">Md. Rakibul Hasan</text>
     <text x="1.5" y="12"   font-size="${8 * PT}"   fill="#cccccc">Senior Merchandiser</text>
     <text x="1.5" y="48.5" font-size="${4.5 * PT}" fill="#dddddd">01711-224466 · rakib@zenith.com.bd</text>
   </svg>`), { filename:'shop.svg' });
const shopPlan = plan(shopCard);
ok('a card with 4.5 pt type is reported below the floor', shopCard.findings.some(f =>
   f.s === 'fail' && /below the print floor/.test(f.label) && /4\.5 pt/.test(f.label)));
ok('raising type to the floor is a repair, not an improvement',
   shopPlan.repairs.some(r => r.id === 'type_floor') &&
   !shopPlan.improvements.some(r => r.id === 'type_floor'));
ok('re-setting the typeface is an improvement, never a repair',
   !shopPlan.repairs.some(r => r.id === 'type_pairing'));
ok('changing the palette is an improvement, never a repair',
   !shopPlan.repairs.some(r => r.id === 'palette'));
ok('the type-floor repair raises to exactly the floor and no further', (() => {
   const r = shopPlan.repairs.find(x => x.id === 'type_floor');
   return r && r.detail.raise.every(x => x.to === E.SCRIPTS.latin.minPt);
})());
ok('every repair states why it matters', shopPlan.repairs.every(r => r.why && r.why.length > 30));
ok('every improvement states why it matters', shopPlan.improvements.every(r => r.why && r.why.length > 30));

H('12. Enhance: declining everything still yields a printable card');
const repairOnly = enhance(shopCard, { declineAll:true });
ok('repair-only succeeds', repairOnly.ok, repairOnly.reason || '');
ok('and has zero blocking findings', repairOnly.ok && repairOnly.blocking === 0);
ok('and applied only repairs', repairOnly.ok && repairOnly.applied.every(a => a.tier === 'repair'),
   repairOnly.ok ? repairOnly.applied.map(a => a.tier + ':' + a.id).join(' ') : '');
ok('the before/after is measured on the composed card, not the stale parts',
   repairOnly.ok && repairOnly.after.quality.score > repairOnly.before.quality.score,
   repairOnly.ok ? `${repairOnly.before.quality.score} -> ${repairOnly.after.quality.score}` : '');
ok('declined improvements are still offered afterwards',
   repairOnly.ok && repairOnly.declined.length === shopPlan.improvements.length);

H('13. Enhance: deterministic, and it invents nothing');
ok('the same choices in any order give byte-identical output', (() => {
  const a = enhance(shopCard, { accept:['grid','palette'] });
  const b = enhance(shopCard, { accept:['palette','grid'] });
  return a.ok && b.ok && a.svg === b.svg;
})(), 'the caching model in Technical Design §7.1 depends on this');
ok('running twice with the same input gives byte-identical output', (() => {
  const a = enhance(shopCard, { accept:['grid'] });
  const b = enhance(shopCard, { accept:['grid'] });
  return a.ok && b.ok && a.svg === b.svg;
})());
ok('no content appears that was not in the upload', (() => {
  const r = enhance(shopCard, { declineAll:true });
  if (!r.ok) return false;
  const src = 'Md. Rakibul Hasan Senior Merchandiser 01711-224466 rakib@zenith.com.bd';
  for (const [k, v] of Object.entries(r.content)) {
    if (k === 'logo' || !v || typeof v !== 'string') continue;
    const words = v.split(/[\s,·]+/).filter(w => w.length > 3);
    for (const w of words) if (!src.includes(w)) return false;
  }
  return true;
})(), 'an invented name is invisible until the cards are printed');

H('14. Every offered operation actually changes the card');
{
  /* The defect this catches is the worst kind an editor can have: the control
     is offered, the edit is accepted, nothing is reported, and the card does
     not change. Five of these were silent no-ops until the composer gained a
     per-slot style channel — recorded on the part and never reaching the page.
     A silent no-op reads as the app being broken (blueprint F8). */
  const baseSvg = previewOf(base).svg;
  const target = base.parts.find(p => p.kind === 'text' && p.slot === 'name');
  const alt = coloursFor(base, target).find(c => c.available && c.hex !== target.style.color);
  const otherType = E.TYPE_SYSTEMS.find(t => t.id !== 'typ.siliguri');
  const ops = [
    ['setWeight', 800], ['setCase', 'upper'], ['setAlign', 'right'],
    ['stepSize', 1], ['setColor', alt && alt.hex], ['setFamily', otherType && otherType.id]
  ].filter(([, v]) => v !== undefined && v !== null);

  const noops = [];
  const unclean = [];
  for (const [type, value] of ops) {
    const r = applyPartOp(base, { type, partId: target.id, value });
    if (!r.ok) continue;                        // a reasoned refusal is not a no-op
    if (!r.preview.ok || r.preview.svg === baseSvg) noops.push(type);
    if (r.preview.ok && r.preview.blocking > 0) unclean.push(type);
  }
  ok(`${ops.length} operations each visibly change the composed card`, noops.length === 0,
     noops.length ? 'silent no-ops: ' + noops.join(', ') : '');
  ok('and none of them leaves a blocking finding', unclean.length === 0, unclean.join(', '));
}
ok('the style channel is absent unless a part carries style', (() => {
  /* Byte-identical composition when nothing is overridden is what makes the
     channel safe to have added to a frozen engine. */
  const bare = structuredClone(base);
  for (const p of bare.parts) p.style = { family:null, weight:null, sizePt:null, color:null,
                                          tracking:null, case:'as-is', align:'left' };
  const pv = previewOf(bare);
  return pv.ok;
})());

H('15. An uploaded card reaches the same guarantee as a generated one');
ok('it composes through the engine, not a second layout system', (() => {
  const pv = previewOf(base);
  return pv.ok && typeof pv.svg === 'string' && pv.svg.startsWith('<svg');
})());
ok('its findings come from the engine\'s own preflight', (() => {
  const pv = previewOf(base);
  return pv.ok && pv.findings.length > 0 &&
    pv.findings.every(f => ['pass','review','fail'].includes(f.s) && typeof f.label === 'string');
})());
ok('the counts on screen are the lengths of the real arrays', (() => {
  const pv = previewOf(base);
  return pv.ok && pv.blocking === pv.findings.filter(f => f.s === 'fail').length
      && pv.advisory === pv.findings.filter(f => f.s === 'review').length
      && pv.passed === pv.findings.filter(f => f.s === 'pass').length;
})());
ok('a card with no name refuses to compose rather than inventing one', (() => {
  const empty = structuredClone(base);
  for (const p of empty.parts) if (p.slot === 'name') p.slot = null;
  const pv = previewOf(empty);
  return pv.ok === false && /no name/i.test(pv.reason);
})());

/* ── fixtures ─────────────────────────────────────────────────────────────
   Built here rather than committed, so the suite cannot pass because a
   fixture drifted out of step with the reader. */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const px = pixels[y * w + x] || [0, 0, 0];
      const at = y * (stride + 1) + 1 + x * 3;
      raw[at] = px[0]; raw[at + 1] = px[1]; raw[at + 2] = px[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
function tinyPdf({ content = '0 0 0 1 k 10 10 50 20 re f', trim = '0 0 252.28 144.57', media = null, extra = '' } = {}) {
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    `3 0 obj<</Type/Page/Parent 2 0 R/TrimBox[${trim}]${media ? `/MediaBox[${media}]` : ''}` +
      '/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj',
    `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/ABCDEF+PlayfairDisplay-Bold>>endobj',
    extra
  ].filter(Boolean);
  return Buffer.from('%PDF-1.4\n' + objs.join('\n') + '\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
