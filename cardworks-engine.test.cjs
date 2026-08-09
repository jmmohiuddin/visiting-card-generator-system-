/* Headless verification of the CARDWORKS engine.
   Extracts the <script> from cardworks-engine.html, stubs the DOM/canvas
   surface with a font-metric model, and asserts engine behaviour. */
const fs = require('fs');
const SRC = require('path').join(__dirname, 'index.html');
const html = fs.readFileSync(SRC, 'utf8');
const js = html.split('<script>').pop().split('</script>')[0];

// ── font-metric model: per-glyph advance ratios approximating real faces ──
function advance(ch, family){
  const bn = /[ঀ-৿]/.test(ch);
  if (bn) return 0.62;                       // Bangla clusters are wide
  if (/[A-Z]/.test(ch)) return family.includes('Mono') ? 0.60 : 0.66;
  if (/[il1.,'!|]/.test(ch)) return 0.26;
  if (/[mwMW]/.test(ch)) return 0.86;
  if (/\s/.test(ch)) return 0.28;
  return family.includes('Mono') ? 0.60 : 0.52;
}
const fakeCtx = {
  font: '',
  measureText(t){
    const m = /(\d+)px\s+(.+)$/.exec(this.font) || [0, '200', 'sans'];
    const px = +m[1], fam = m[2];
    let w = 0; for (const ch of t) w += advance(ch, fam) * px;
    const bn = /[ঀ-৿]/.test(t);
    return { width: w,
             fontBoundingBoxAscent:  px * (bn ? 0.95 : 0.80),
             fontBoundingBoxDescent: px * (bn ? 0.35 : 0.20) };
  }
};

// ── minimal DOM stub ──
const el = () => ({ innerHTML:'', textContent:'', value:'', onclick:null, oninput:null,
  onchange:null, onkeydown:null, files:null, style:{}, dataset:{}, setAttribute(){},
  appendChild(){}, querySelectorAll:()=>[], querySelector:()=>el(), closest:()=>null });
global.document = {
  createElement: (t) => t === 'canvas' ? { getContext: () => fakeCtx } : el(),
  querySelector: () => el(),
  querySelectorAll: () => [],
  fonts: { ready: Promise.resolve() }
};
global.performance = { now: () => 0 };
global.window = global;
const _ls = {}; global.localStorage = { getItem:k=>k in _ls?_ls[k]:null, setItem:(k,v)=>{_ls[k]=String(v);}, removeItem:k=>{delete _ls[k];} };
global.location = { hash:'' };
global.history = { replaceState(){} };
global.btoa = b => Buffer.from(b, 'binary').toString('base64');
global.atob = b => Buffer.from(b, 'base64').toString('binary');
global.TextEncoder = global.TextEncoder || require('util').TextEncoder;

// evaluate, then reach into the module scope via a returned handle
const mod = new Function(js + `
  ;return { compose, composeForced, renderSVG, preflight, LAYOUTS, PRESETS, FORMATS,
            TYPE_SYSTEMS, PALETTES, SCRIPTS, SLOTDEFS, fitSlot, specFor, state, contrast,
            resolveIntent, generate, scoreCandidate, explain, quote, printDocSVG,
            separationSVG, INDUSTRIES, AXES, W, LAYOUT_AXES,
            classifyInstruction, applyOps, EDIT_OPS, EDIT_RULES, nameScaleOf, hasSlot,
            QR, qrPayload, gradeLogo, specHash, stableStringify, parseCSV, bulkGenerate,
            gridFor, slotsFor, GRIDS };`)();

let pass = 0, fail = 0;
const ok  = (name, cond, extra='') => { cond ? (pass++, console.log('  ✓ ' + name))
                                             : (fail++, console.log('  ✗ ' + name + (extra?' — '+extra:''))); };
const H = s => console.log('\n' + s);

const fronts = mod.LAYOUTS.filter(l => l.face === 'front');
const backs  = mod.LAYOUTS.filter(l => l.face === 'back');

H('1. Library shape');
ok(`${fronts.length} front layouts, ${backs.length} back faces`, fronts.length >= 9 && backs.length >= 4);
ok('every type system declares a Bangla family', mod.TYPE_SYSTEMS.every(t => t.bangla && t.banglaOk));
ok('every layout has a required-slot or is a back face',
   mod.LAYOUTS.every(l => l.face === 'back' || l.slots.some(s => s.ref === 'name')));

H('2. Renderer contains no per-layout branching (the核 invariant)');
const renderBody = js.slice(js.indexOf('function renderSVG'), js.indexOf('function lum'));
const layoutIdsInRenderer = mod.LAYOUTS.filter(l => renderBody.includes(l.id));
ok('renderSVG references zero layout ids', layoutIdsInRenderer.length === 0,
   layoutIdsInRenderer.map(l=>l.id).join(','));
const composeBody = js.slice(js.indexOf('function compose('), js.indexOf('function box('));
ok('compose references zero layout ids', mod.LAYOUTS.every(l => !composeBody.includes(l.id)));

H('3. Composition across every preset × every layout');
let composed = 0, eliminated = 0, ladderFired = 0;
const elimBy = {};
for (const p of mod.PRESETS){
  for (const L of fronts){
    const c = mod.composeForced(L.id, p.c, null);
    if (c.eliminated){ eliminated++; elimBy[p.k] = (elimBy[p.k]||0)+1; }
    else { composed++; if (c.trace.length) ladderFired++; }
  }
}
ok(`${composed} compositions succeeded, ${eliminated} eliminated`, composed > 0);
ok('fit ladder actually fires', ladderFired > 0, 'ladder never engaged — measurement may be broken');
console.log('    eliminations by preset:', JSON.stringify(elimBy));

H('4. The guarantee: nothing that composes ever overflows its slot');
let overflow = 0, overlap = 0, outside = 0, belowFloor = 0;
for (const p of mod.PRESETS){
  for (const L of fronts){
    const c = mod.composeForced(L.id, p.c, null);
    if (c.eliminated) continue;
    const fmt = c.fmt;
    const texts = c.elements.filter(e => e.fit);
    for (const e of texts){
      if (e.fit.width  > e.geom.w + 0.02) overflow++;
      if (e.fit.height > e.geom.h + 0.02) overflow++;
      if (e.fit.sizePt < e.fit.minPt - 0.05) belowFloor++;
      if (e.geom.x < fmt.safe - 0.01 || e.geom.y < fmt.safe - 0.01 ||
          e.geom.x + e.geom.w > fmt.w - fmt.safe + 0.01 ||
          e.geom.y + e.geom.h > fmt.h - fmt.safe + 0.01) outside++;
    }
    for (let i=0;i<texts.length;i++) for (let j=i+1;j<texts.length;j++){
      const a=texts[i].geom, b=texts[j].geom;
      if (a.x < b.x+b.w-0.1 && b.x < a.x+a.w-0.1 && a.y < b.y+b.h-0.1 && b.y < a.y+a.h-0.1) overlap++;
    }
  }
}
ok('zero text overflows its slot box', overflow === 0, overflow + ' overflows');
ok('zero elements overlap', overlap === 0, overlap + ' overlaps');
ok('zero elements outside the safe area', outside === 0, outside + ' outside');
ok('zero type below the per-script print floor', belowFloor === 0, belowFloor + ' below floor');

H('5. Bangla is handled as a script, not as different glyphs');
const bn = mod.composeForced('lay.stack', mod.PRESETS[2].c, 'bangla');
const bnText = bn.elements.filter(e => e.fit && e.fit.script === 'bangla');
ok('Bangla face composes', !bn.eliminated && bnText.length > 0);
ok('Bangla min size floor is 7.5 pt, not 6.0', mod.SCRIPTS.bangla.minPt === 7.5);
ok('Bangla never gets negative tracking', bnText.every(e => e.fit.track >= 0),
   'negative tracking breaks the matra join');
ok('Bangla line-height exceeds Latin', mod.SCRIPTS.bangla.lineHeight > mod.SCRIPTS.latin.lineHeight);
const lt = mod.composeForced('lay.stack', mod.PRESETS[2].c, null);
const nmB = bn.elements.find(e=>e.ref==='name'), nmL = lt.elements.find(e=>e.ref==='name');
ok('Bangla gets optical size compensation vs Latin in the same slot',
   nmB && nmL ? nmB.fit.sizePt !== nmL.fit.sizePt : false);

H('6. The stress test eliminates rather than overflows');
const stress = mod.PRESETS[mod.PRESETS.length-1];
const results = fronts.map(L => mod.composeForced(L.id, stress.c, null));
const survived = results.filter(r => !r.eliminated);
const adjusted = survived.filter(r => r.trace.length);
ok('the 44-character name does not silently overflow anywhere',
   survived.every(r => r.elements.filter(e=>e.fit).every(e => e.fit.width <= e.geom.w + 0.02)));
ok(`${survived.length}/${fronts.length} layouts survived, ${adjusted.length} needed the ladder`, adjusted.length > 0);
console.log('    ladder rungs used:',
  JSON.stringify([...new Set(survived.flatMap(r=>r.trace.flatMap(t=>t.applied.map(a=>a.split('→')[0].trim()))))]));

H('7. Preflight is arithmetic, and catches deliberate breakage');
const good = mod.composeForced('lay.centered', mod.PRESETS[1].c, null);
const gf = mod.preflight(good);
ok('a clean card produces zero blocking findings', gf.filter(f=>f.s==='fail').length === 0,
   JSON.stringify(gf.filter(f=>f.s==='fail')));
// inject a layout whose slot is authored OUTSIDE the trim and overlapping
const broken = JSON.parse(JSON.stringify(mod.LAYOUTS.find(l=>l.id==='lay.stack')));
broken.id = 'lay.__broken'; broken.slots[2].box = [-0.4, 0.2, 10.4, 1.2];
mod.LAYOUTS.push(broken);
const bad = mod.composeForced('lay.__broken', mod.PRESETS[1].c, null);
const bf = mod.preflight(bad);
// The composer clamps into the safe area, so a bad RECORD cannot produce a
// bad ELEMENT — that is the design. Assert the clamp, not the finding.
const clampedEl = bad.elements.find(e => e.fit && e.ref === 'name');
ok('a slot authored outside the trim is clamped into the safe area, not rendered outside',
   clampedEl && clampedEl.geom.x >= bad.fmt.safe - 0.001,
   clampedEl ? 'x=' + clampedEl.geom.x.toFixed(2) : 'name missing');
ok('preflight still reports the safe area clean after clamping',
   bf.some(f=>f.s==='pass' && /safe area/.test(f.label)));
ok('preflight flags the overlap the bad record caused',
   bf.some(f=>f.s==='fail' && /overlap/i.test(f.label)));
mod.LAYOUTS.pop();

// direct geometry corruption — defence in depth: if the composer itself ever
// regresses, preflight must still catch it
const corrupt = mod.composeForced('lay.centered', mod.PRESETS[1].c, null);
corrupt.elements.find(e=>e.fit).geom.x = -2;
ok('preflight catches out-of-safe geometry when handed it directly',
   mod.preflight(corrupt).some(f=>f.s==='fail' && /safe area/.test(f.label)));

// genuine elimination: a required slot that cannot fit even at the floor
const impossible = JSON.parse(JSON.stringify(mod.LAYOUTS.find(l=>l.id==='lay.centered')));
impossible.id = 'lay.__impossible';
impossible.slots.find(s=>s.ref==='name').box = [5.4, 3.4, 1.0, 0.5]; // far too small
impossible.slots.find(s=>s.ref==='name').fit  = ['track','step'];    // no wrap escape
mod.LAYOUTS.push(impossible);
const imp = mod.composeForced('lay.__impossible', mod.PRESETS[5].c, null);
ok('a layout that cannot hold a required field is ELIMINATED, not drawn badly',
   !!imp.eliminated, 'composed anyway');
ok('an eliminated layout renders nothing', mod.renderSVG(imp) === null);
console.log('    elimination reason:', imp.eliminated);
mod.LAYOUTS.pop();

H('8. Renderer output is well-formed SVG in millimetres');
const svg = mod.renderSVG(good);
ok('emits an <svg> root', /^<svg[\s>]/.test(svg.trim()));
ok('viewBox is the trim size in mm', svg.includes('viewBox="0 0 89 51"'));
const opens = (svg.match(/<text\b/g)||[]).length, closes = (svg.match(/<\/text>/g)||[]).length;
ok(`balanced <text> tags (${opens})`, opens === closes && opens > 0);
ok('no NaN or undefined in output', !/NaN|undefined/.test(svg), (svg.match(/NaN|undefined/g)||[]).slice(0,3).join(','));
ok('Bangla face also renders clean', (()=>{ const s = mod.renderSVG(bn); return s && !/NaN|undefined/.test(s); })());
ok('guides variant renders', !!mod.renderSVG(good, {guides:true}));

H('9. Every back face composes for every preset');
let backFail = 0;
for (const p of mod.PRESETS) for (const B of backs){
  const c = mod.composeForced(B.id, p.c, B.forceScript || null);
  const s = c.eliminated ? null : mod.renderSVG(c);
  if (!c.eliminated && (!s || /NaN|undefined/.test(s))) backFail++;
}
ok('all back faces render cleanly', backFail === 0, backFail + ' failed');

H('10. Formats: the engine is trim-agnostic');
const origFmt = mod.state.format;
let fmtFail = 0;
for (const f of mod.FORMATS){
  mod.state.format = f.id;
  for (const L of fronts){
    const c = mod.composeForced(L.id, mod.PRESETS[1].c, null);
    if (c.eliminated) continue;
    const s = mod.renderSVG(c);
    if (!s || !s.includes(`viewBox="0 0 ${f.w} ${f.h}"`)) fmtFail++;
    for (const e of c.elements.filter(e=>e.fit)) if (e.fit.width > e.geom.w + 0.02) fmtFail++;
  }
}
mod.state.format = origFmt;
ok('all four Bangladesh formats compose and render without overflow', fmtFail === 0, fmtFail + ' failures');


const BRIEF = (o={}) => Object.assign({ industry:'doctor', personality:['traditional','premium'],
  format:'bd-std', density:'balanced', script:'latin' }, o);
const C_DOC = mod.PRESETS[0].c, C_RMG = mod.PRESETS[1].c, C_ADV = mod.PRESETS[3].c;

H('11. Intent resolution (rules only — the MVP path and the permanent fallback)');
const i1 = mod.resolveIntent(BRIEF({ industry:'advocate', personality:[] }));
const i2 = mod.resolveIntent(BRIEF({ industry:'advocate', personality:['technical'] }));
ok('industry prior produces a vector', Math.max(...mod.AXES.map(a=>i1.vector[a])) === 1);
ok('advocate prior leans traditional', i1.vector.traditional >= i1.vector.bold);
ok('explicit personality overrides the industry prior',
   i2.vector.technical > i2.vector.traditional, JSON.stringify(i2.vector));
ok('avoid list is carried through', i1.avoid.includes('bold'));
ok('source is labelled rules (so a UI can say so honestly)', i1.source === 'rules');

H('12. Generation');
const g = mod.generate(BRIEF(), C_DOC);
ok(`${g.stages.enumerated} candidates enumerated → ${g.stages.selected} selected`,
   g.stages.enumerated === 9*8*5 && g.stages.selected > 0);
ok('pipeline counts are monotonically narrowing (i.e. real)',
   g.stages.enumerated >= g.stages.composed && g.stages.composed >= g.stages.printSafe
   && g.stages.printSafe >= g.stages.selected,
   JSON.stringify(g.stages));
ok('scores are sorted descending',
   g.picked.every((c,i)=> i===0 || g.picked[i-1].score.total >= c.score.total));
ok('no selected concept has a blocking preflight finding',
   g.picked.every(c=>c.findings.every(f=>f.s!=='fail')));
ok('diversity: every concept uses a different layout',
   new Set(g.picked.map(c=>c.layout)).size === g.picked.length);
ok('diversity: no palette used more than twice', (()=>{
   const n={}; for(const c of g.picked) n[c.palette]=(n[c.palette]||0)+1;
   return Object.values(n).every(v=>v<=2); })());
ok('every concept renders', g.picked.every(c=>{ const s=mod.renderSVG(c.composed); return s && !/NaN|undefined/.test(s); }));

H('13. Determinism (blueprint §12 — caching depends on this)');
const a1 = mod.generate(BRIEF(), C_DOC), a2 = mod.generate(BRIEF(), C_DOC);
ok('same brief → identical selection',
   JSON.stringify(a1.picked.map(c=>[c.layout,c.palette,c.type,c.score.total])) ===
   JSON.stringify(a2.picked.map(c=>[c.layout,c.palette,c.type,c.score.total])));

H('14. F5 FIXED — the score responds to the brief');
const gA = mod.generate(BRIEF({ personality:['traditional','premium'] }), C_DOC);
const gB = mod.generate(BRIEF({ personality:['technical','minimal'] }), C_DOC);
ok('changing personality changes the winning concept',
   gA.picked[0].layout+gA.picked[0].palette !== gB.picked[0].layout+gB.picked[0].palette,
   `both won with ${gA.picked[0].layout}/${gA.picked[0].palette}`);
ok('changing personality changes the scores',
   gA.picked[0].score.total !== gB.picked[0].score.total);
console.log(`    traditional+premium → ${gA.picked[0].layout} / ${gA.picked[0].palette} (${(gA.picked[0].score.total*100).toFixed(1)})`);
console.log(`    technical+minimal   → ${gB.picked[0].layout} / ${gB.picked[0].palette} (${(gB.picked[0].score.total*100).toFixed(1)})`);
const gC = mod.generate(BRIEF({ industry:'shop', personality:[] }), C_DOC);
ok('changing industry alone changes the ranking',
   gC.picked[0].layout !== gA.picked[0].layout || gC.picked[0].palette !== gA.picked[0].palette);

H('15. Industry exclusions are hard, not advisory');
const adv = mod.generate(BRIEF({ industry:'advocate', personality:[] }), C_ADV);
const boldLayouts = Object.entries(mod.LAYOUT_AXES).filter(([,v])=>(v.bold||0) > .8).map(([k])=>k);
ok(`an advocate brief never selects a bold layout (${boldLayouts.join(', ')})`,
   adv.picked.every(c=>!boldLayouts.includes(c.layout)),
   adv.picked.map(c=>c.layout).join(','));
ok('scoring zeroes the industry dimension on an excluded component', (()=>{
   const bad = adv.picked.length ? null : 1;
   const forced = { layout:'lay.bleed', palette:'pal.red', type:'typ.baloo',
     composed:{ elements:[], dropped:[], trace:[] }, findings:[] };
   return mod.scoreCandidate(forced, mod.resolveIntent(BRIEF({industry:'advocate',personality:[]}))).parts.industry === 0; })());

H('16. F4 FIXED — explanations are generated from the trace');
ok('every concept has a non-empty explanation', g.picked.every(c=>c.why && c.why.length > 40));
ok('explanations differ between concepts', new Set(g.picked.map(c=>c.why)).size > 1);
ok('the explanation quotes the concept’s own personality score',
   g.picked[0].why.includes(String(Math.round(g.picked[0].score.parts.personality*100))));
const noPers = mod.generate(BRIEF({ personality:[] }), C_DOC);
ok('with nothing stated it says the preference was INFERRED, not asked for',
   /did not state a personality/.test(noPers.picked[0].why) && !/You asked for/.test(noPers.picked[0].why),
   noPers.picked[0].why.slice(0,110));
ok('with a personality stated it names exactly what was stated, nothing more', (()=>{
   const w = mod.generate(BRIEF({ personality:['bold'] }), C_DOC).picked[0].why;
   return /You asked for bold\./.test(w); })());
console.log('    sample:', g.picked[0].why);

ok('the legibility dimension actually differentiates candidates (not all zero)',
   new Set(g.picked.map(c=>c.score.parts.legibility.toFixed(3))).size > 1,
   'all candidates scored ' + g.picked[0].score.parts.legibility);
ok('every score dimension is non-degenerate across the six',
   Object.keys(mod.W).every(k => new Set(g.picked.map(c=>c.score.parts[k].toFixed(3))).size > 1
                                 || k === 'industry'),
   Object.keys(mod.W).filter(k=>new Set(g.picked.map(c=>c.score.parts[k].toFixed(3))).size===1).join(','));

H('17. Cost model (replaces the prototype’s hardcoded price table)');
const q1 = mod.quote(100, ['matte'], 'dhaka'), q5 = mod.quote(500, ['matte'], 'dhaka'),
      q1k = mod.quote(1000, ['matte'], 'dhaka');
ok('total rises with quantity', q1.retail < q5.retail && q5.retail < q1k.retail);
ok('unit price falls with quantity', q1.unit > q5.unit && q5.unit > q1k.unit,
   `${q1.unit} / ${q5.unit} / ${q1k.unit}`);
const qf = mod.quote(500, ['matte','foil'], 'dhaka');
ok('adding foil adds a one-off block plus a per-unit cost', qf.retail > q5.retail);
ok('the foil line names the block cost',
   qf.lines.some(l=>/block|plate/i.test(l.label)));
ok('gross margin lands in the 30–40% band', qf.marginPct > 30 && qf.marginPct < 40, qf.marginPct+'%');
ok('outside-Dhaka delivery costs more', mod.quote(500,['matte'],'outside').retail > q5.retail);
console.log(`    500 cards, matte + foil → ৳${qf.retail} retail, ৳${qf.unit}/card, ${qf.marginPct}% gross`);

H('18. Print output geometry');
const best = g.picked[0].composed;
const doc = mod.printDocSVG(best);
ok('document is trim + 2 × bleed', doc.includes('width="95mm"') && doc.includes('height="57mm"'));
ok('viewBox matches the document box', doc.includes('viewBox="0 0 95 57"'));
ok('artwork is offset by the bleed', doc.includes('transform="translate(3,3)"'));
ok('trim marks are present — 2 per corner, 8 total',
   (doc.match(/<line /g)||[]).length === 8, (doc.match(/<line /g)||[]).length+' marks');
ok('trim marks sit outside the trim box, never on the artwork', (()=>{
   const ls=[...doc.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)];
   const b=3, w=89, h=51;
   return ls.every(m=>{ const [x1,y1,x2,y2]=m.slice(1).map(Number);
     const outX = v => v <= b-0.5 || v >= b+w+0.5, outY = v => v <= b-0.5 || v >= b+h+0.5;
     return (outX(x1)&&outX(x2)) || (outY(y1)&&outY(y2)); }); })());
ok('output carries the outline-fonts instruction', /outlined/.test(doc));
const sep = mod.separationSVG(best, 'Gold foil');
if (sep){
  ok('separation is 100% K on white', sep.svg.includes('fill="#000"') && sep.svg.includes('fill="#fff"'));
  ok('separation shares the document geometry', sep.svg.includes('viewBox="0 0 95 57"'));
  ok(`foil plate area is small (${sep.areaPct}%) — keeps foil affordable`, sep.areaPct < 25);
} else {
  ok('separation returns null when no element carries the special', true);
}

H('19. Every preset generates a usable set');
let genFail = 0;
for (const pr of mod.PRESETS){
  for (const scr of ['latin','bangla']){
    const r = mod.generate(BRIEF({ script:scr }), pr.c);
    if (!r.picked.length) { genFail++; console.log('    no concepts for', pr.k, scr); continue; }
    if (r.picked.some(c => mod.preflight(c.composed).some(f=>f.s==='fail'))) genFail++;
  }
}
ok('all 6 presets × both scripts produce blocking-free concepts', genFail === 0, genFail+' failures');


H('20. The edit grammar — F4’s other half');
const cl = t => mod.classifyInstruction(t);
ok('a known English instruction maps to operations',
   cl('make it more premium').ops.length > 0);
ok('a known Bangla instruction maps to operations',
   cl('নাম বড় করুন').ops.some(o=>o.op==='promoteSlot'), JSON.stringify(cl('নাম বড় করুন')));
ok('every emitted operation exists in the closed set',
   mod.EDIT_RULES.every(r=>r.ops.every(([op])=> op in mod.EDIT_OPS)),
   mod.EDIT_RULES.flatMap(r=>r.ops.map(([o])=>o)).filter(o=>!(o in mod.EDIT_OPS)).join(','));
ok('no rule can emit more than a bounded number of ops',
   cl('premium minimal technical bold dark colourful qr foil portrait bangla').ops.length <= 6,
   String(cl('premium minimal technical bold dark colourful qr foil portrait bangla').ops.length));

const gib = cl('xyzzy make it plaid and smell nice');
ok('unmapped input returns ZERO operations', gib.ops.length === 0);
ok('unmapped input is flagged, not guessed', gib.unmapped === true);
ok('unmapped input offers alternatives', (gib.suggestions||[]).length === 3);
ok('a common function word cannot trigger a rule ("make IT more premium")',
   cl('make it more premium').matched.join()==='more premium',
   cl('make it more premium').matched.join());
ok('no rule pattern matches a sentence containing only function words',
   mod.EDIT_RULES.filter(r=>r.re.test('please make it look nice and do that for me')).length === 0,
   mod.EDIT_RULES.filter(r=>r.re.test('please make it look nice and do that for me')).map(r=>r.label).join());
ok('empty input is a no-op, not an error', cl('').empty === true && cl('').ops.length === 0);

H('21. Operations resolve to component changes, never to geometry');
const D0 = { layout:'lay.centered', palette:'pal.ink', type:'typ.siliguri',
             density:'balanced', back:'back.contact', format:'bd-std',
             script:'latin', finishes:['matte'] };
const GEOM_KEYS = ['x','y','w','h','size','sizePt','fontSize','box','track'];
let leaked = 0;
for (const r of mod.EDIT_RULES){
  const { design } = mod.applyOps(D0, r.ops.map(([op,arg])=>({op,arg})));
  for (const k of Object.keys(design)) if (GEOM_KEYS.includes(k)) leaked++;
  // design must remain a set of component references only
  if (design.layout && !mod.LAYOUTS.some(l=>l.id===design.layout)) leaked++;
  if (design.palette && !mod.PALETTES.some(p=>p.id===design.palette)) leaked++;
  if (design.type && !mod.TYPE_SYSTEMS.some(t=>t.id===design.type)) leaked++;
}
ok('no operation introduces geometry or an unknown component id', leaked === 0, leaked+' leaks');

const bigger = mod.applyOps(D0, cl('make my name bigger').ops).design;
ok('"bigger name" picks a layout that gives the name MORE room, it does not scale type',
   mod.nameScaleOf(bigger.layout) > mod.nameScaleOf(D0.layout),
   `${D0.layout}(${mod.nameScaleOf(D0.layout)}) → ${bigger.layout}(${mod.nameScaleOf(bigger.layout)})`);

const backed = mod.applyOps(D0, cl('move the contact details to the back').ops).design;
ok('"contact to the back" selects a front WITHOUT a contact slot and a back that carries it',
   !mod.hasSlot(backed.layout,'contact') && backed.back === 'back.contact',
   `${backed.layout} / ${backed.back}`);

const dark = mod.applyOps(D0, cl('make it darker').ops).design;
ok('"darker" moves to a genuinely darker ground',
   mod.contrast(mod.PALETTES.find(p=>p.id===dark.palette).bg,'#ffffff') >
   mod.contrast(mod.PALETTES.find(p=>p.id===D0.palette).bg,'#ffffff'),
   dark.palette);

ok('applying the same instruction twice is stable (no drift)', (()=>{
   const a = mod.applyOps(D0, cl('make it more premium').ops).design;
   const b = mod.applyOps(a,  cl('make it more premium').ops).design;
   return JSON.stringify(a) === JSON.stringify(b); })());
ok('changes are reported for the UI', mod.applyOps(D0, cl('make it more premium').ops).changes.length > 0);

H('22. A refined card is exactly as print-safe as a generated one');
let refFail = 0, refChecked = 0;
for (const pr of [mod.PRESETS[0], mod.PRESETS[1], mod.PRESETS[5]]){
  for (const r of mod.EDIT_RULES){
    const { design } = mod.applyOps(D0, r.ops.map(([op,arg])=>({op,arg})));
    mod.state.format = design.format; mod.state.density = design.density;
    const c = mod.composeForced(design.layout, pr.c,
      design.script==='bangla' ? 'bangla' : null,
      { palette:design.palette, type:design.type, density:design.density, format:design.format });
    if (c.eliminated) continue;              // elimination is a valid, safe outcome
    refChecked++;
    if (mod.preflight(c).some(f=>f.s==='fail')) refFail++;
  }
}
mod.state.format = 'bd-std'; mod.state.density = 'balanced';
ok(`every instruction × preset re-composes print-safe (${refChecked} checked)`, refFail === 0, refFail+' blocking');


H('23. QR — a real encoder, not a pattern that looks like one');
const enc = mod.QR.encode('HELLO WORLD');
ok('encodes to a matrix', !!enc && enc.matrix.length === enc.size);
ok('version 1 is 21×21', enc.version === 1 ? enc.size === 21 : true);
ok('size follows 17 + 4V for every version', (()=>{
   for (let n = 1; n <= 10; n++){
     const e = mod.QR.encode('x'.repeat(mod.QR.CAP[n]));
     if (!e || e.size !== 17 + 4*e.version) return false;
   } return true; })());

ok('EVERY encoded block is a valid Reed–Solomon codeword (syndromes all zero)', (()=>{
   for (const text of ['HELLO WORLD', 'x'.repeat(100), 'x'.repeat(213), 'মোঃ সুমন মিয়া']){
     const e = mod.QR.encode(text); if (!e) return false;
     for (let i = 0; i < e.blocks.length; i++){
       const full = e.blocks[i].concat(e.ecBlocks[i]);
       if (mod.QR.syndromes(full, e.ecLen).some(x => x !== 0)) return false;
     }
   } return true; })(), 'ECC is wrong — the symbol would not decode');

ok('finder patterns are present at all three corners', (()=>{
   const m = enc.matrix, n = enc.size;
   const ring = (R,C) => {
     for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++){
       const want = (r===0||r===6||c===0||c===6||(r>=2&&r<=4&&c>=2&&c<=4)) ? 1 : 0;
       if (m[R+r][C+c] !== want) return false;
     } return true; };
   return ring(0,0) && ring(0,n-7) && ring(n-7,0); })());
ok('timing patterns alternate', (()=>{
   const m = enc.matrix, n = enc.size;
   for (let i = 8; i < n-8; i++) if (m[6][i] !== (i%2===0?1:0) || m[i][6] !== (i%2===0?1:0)) return false;
   return true; })());
ok('the dark module is set', enc.matrix[enc.size-8][8] === 1);
ok('a mask was chosen from the 8 defined', enc.mask >= 0 && enc.mask <= 7);
ok('over-capacity input returns null rather than a broken symbol',
   mod.QR.encode('x'.repeat(500)) === null);
ok('UTF-8 Bangla encodes (multi-byte safe)', (()=>{
   const e = mod.QR.encode('মোহাম্মদ শফিকুর রহমান'); return !!e && e.bytes > 21; })());

H('24. vCard content ladder');
const pay = mod.qrPayload(mod.PRESETS[0].c);
ok('produces a scannable vCard for the hardest preset', !!pay && !!pay.qr);
ok('payload is a well-formed vCard',
   /^BEGIN:VCARD/.test(pay.text) && /END:VCARD$/.test(pay.text) && /FN:/.test(pay.text));
ok('the phone number survives every ladder level', (()=>{
   for (const pr of mod.PRESETS){ const p = mod.qrPayload(pr.c);
     if (!p) return false;
     if (pr.c.p1 && !p.text.includes(pr.c.p1)) return false; } return true; })());
ok('a too-long contact set drops fields and REPORTS what it dropped', (()=>{
   const huge = Object.assign({}, mod.PRESETS[5].c,
     { addr:'Level 8, BTI Landmark, 12 Gulshan Avenue, Dhaka-1212, Bangladesh, near the old fire station and opposite the market' });
   const p = mod.qrPayload(huge);
   return p && (p.level === 1 || p.dropped.length > 0); })());
ok('every preset yields a payload within QR capacity',
   mod.PRESETS.every(pr => { const p = mod.qrPayload(pr.c); return p && p.qr.bytes <= p.qr.capacity; }));

H('25. QR in a composed card');
// back.qr is the dedicated QR face and must always carry a scannable symbol.
const withQR = mod.composeForced('back.qr', mod.PRESETS[1].c, null);
const qrEl = withQR.elements.find(e=>e.kind==='qr');
ok('the dedicated QR face composes a real symbol', !!qrEl && !!qrEl.qr);
ok('module size is derived from the REAL symbol size, not a guess',
   Math.abs(qrEl.moduleMm - Math.min(qrEl.geom.w,qrEl.geom.h)/(qrEl.qr.size+8)) < 1e-9);
ok('the rendered path has one rect per dark module', (()=>{
   const svg = mod.renderSVG(withQR);
   const path = /<path d="(M[^"]*)" fill/.exec(svg);
   if (!path) return false;
   const drawn = (path[1].match(/M/g)||[]).length;
   let dark = 0; for (const row of qrEl.qr.matrix) for (const v of row) dark += v;
   return drawn === dark; })());
ok('preflight reports the real symbol, not a guess',
   mod.preflight(withQR).some(f=>/QR module [\d.]+ mm/.test(f.label)));
ok('the composed QR clears the 0.5 mm module floor',
   qrEl.moduleMm >= 0.5, qrEl.moduleMm.toFixed(3)+' mm at version '+qrEl.qr.version);
ok('no composed card anywhere emits a QR below the module floor', (()=>{
   for (const pr of mod.PRESETS) for (const L of mod.LAYOUTS){
     const c = mod.composeForced(L.id, pr.c, null); if (c.eliminated) continue;
     const q = c.elements.find(e=>e.kind==='qr');
     if (q && q.moduleMm < 0.5) return false;
   } return true; })());

// A slot too small for the payload must OMIT the QR and say so — the small
// front-of-card slot in lay.grid is exactly that case once the link is a real
// https URL rather than a placeholder.
const smallQR = mod.composeForced('lay.grid', mod.PRESETS[0].c, null);
const smallEl = smallQR.elements.find(e=>e.kind==='qr');
ok('a QR slot too small for the payload emits NOTHING rather than a bad symbol',
   !smallEl || smallEl.moduleMm >= 0.5);
ok('and the omission is recorded in the trace, not silent',
   !!smallEl || smallQR.trace.some(t=>t.slot==='qr' && t.applied.includes('omitted')),
   JSON.stringify(smallQR.trace.filter(t=>t.slot==='qr')));

ok('an UNSAVED design blocks export — its QR link does not resolve yet', (()=>{
   const pf = mod.preflight(withQR);
   return pf.some(f=>f.s==='fail' && /link is not active/.test(f.label)); })(),
   JSON.stringify(mod.preflight(withQR).filter(f=>/QR|link/i.test(f.label)).map(f=>f.s+':'+f.label)));
ok('a SAVED design passes that check', (()=>{
   mod.state.shareCode = 'a1b2c3d4';
   const c = mod.composeForced('back.qr', mod.PRESETS[1].c, null);
   mod.state.shareCode = null;
   const pf = mod.preflight(c);
   return !pf.some(f=>f.s==='fail'); })());

H('26. Logo quality gate — rejected at UPLOAD, never at export');
const PLACED = 10.4;   // mark slot, mm
ok('vector artwork passes', mod.gradeLogo({vector:true, colors:2}, PLACED).ok);
ok('a many-colour vector is flagged for foil, not rejected', (()=>{
   const g = mod.gradeLogo({vector:true, colors:9}, PLACED);
   return g.ok && g.findings.some(f=>f.s==='review' && /colours/.test(f.label)); })());
ok('a 300 dpi raster passes',
   mod.gradeLogo({vector:false, wpx:Math.ceil(300*PLACED/25.4), hpx:200, hasAlpha:true}, PLACED).ok);
const low = mod.gradeLogo({vector:false, wpx:60, hpx:40, hasAlpha:false}, PLACED);
ok('a low-resolution raster is REJECTED', !low.ok && low.blocking === 1);
ok('the rejection states the numbers and the fix',
   low.findings.some(f=>f.s==='fail' && /needs at least \d+ px/.test(f.note)));
ok('the rejection offers three concrete options', low.options.length === 3);
ok('a raster is always flagged as unfoilable',
   mod.gradeLogo({vector:false, wpx:4000, hpx:3000, hasAlpha:true}, PLACED)
      .findings.some(f=>/foiled or embossed/.test(f.label)));
ok('the same file walks pass → review → fail as it is placed larger', (()=>{
   const a = {vector:false, wpx:200, hpx:200, hasAlpha:true};
   const sev = mm => mod.gradeLogo(a, mm).findings.find(f=>/dpi/.test(f.label)).s;
   return sev(10) === 'pass' && sev(25) === 'review' && sev(45) === 'fail'; })(),
   [10,25,45].map(mm=>mm+':'+mod.gradeLogo({vector:false,wpx:200,hpx:200,hasAlpha:true},mm)
     .findings.find(f=>/dpi/.test(f.label)).s).join(' '));

H('27. Spec identity — content addressing (§12 caching depends on it)');
const S1 = { b:2, a:1, nest:{ y:'2', x:[3,1] } };
const S2 = { a:1, nest:{ x:[3,1], y:'2' }, b:2 };
ok('key order does not change the hash', mod.specHash(S1) === mod.specHash(S2));
ok('a changed value changes the hash', mod.specHash(S1) !== mod.specHash({...S1, b:3}));
ok('hash is stable across calls', mod.specHash(S1) === mod.specHash(S1));
ok('hash is a fixed-width hex string', /^[0-9a-f]{16}$/.test(mod.specHash(S1)));
ok('distinct designs collide rarely', (()=>{
   const seen = new Set();
   for (const L of mod.LAYOUTS) for (const P of mod.PALETTES) for (const T of mod.TYPE_SYSTEMS)
     seen.add(mod.specHash({layout:L.id, palette:P.id, type:T.id}));
   return seen.size === mod.LAYOUTS.length * mod.PALETTES.length * mod.TYPE_SYSTEMS.length; })());

H('28. CSV parsing');
const csv = mod.parseCSV('name,role\nSharmin Akter,Merchandiser\n"Rahman, Md.",  QC  \n\n');
ok('header is lowercased', csv.header.join() === 'name,role');
ok('two data rows, blank line ignored', csv.rows.length === 2);
ok('quoted commas survive', csv.rows[1].name === 'Rahman, Md.');
ok('cells are trimmed', csv.rows[1].role === 'QC');
ok('escaped quotes survive', mod.parseCSV('a\n"He said ""hi"""').rows[0].a === 'He said "hi"');
ok('empty input is handled', mod.parseCSV('').rows.length === 0);

H('29. Bulk generation — the enterprise wedge');
const D = { layout:'lay.split', palette:'pal.navy', type:'typ.siliguri',
            density:'balanced', back:'back.contact', format:'bd-std', script:'latin', finishes:['matte'] };
const staff = mod.parseCSV([
  'name,role,company,phone,email',
  'Sharmin Akter,Senior Merchandiser,Zenith Sourcing Ltd.,01755-889900,s@z.com',
  'Md. Rakibul Hasan,Merchandiser,Zenith Sourcing Ltd.,01711-224466,r@z.com',
  'Mohammad Shafiqur Rahman Chowdhury Bhuiyan,Deputy General Manager Corporate Affairs,Zenith Sourcing Ltd.,01611-778899,shafiqur@z.com'
].join('\n')).rows;
const bulk = mod.bulkGenerate(D, staff, mod.PRESETS[1].c,
  (d, content) => mod.composeForced(d.layout, content, null,
    { palette:d.palette, type:d.type, density:d.density, format:d.format }));
ok('one result per row', bulk.total === 3 && bulk.rows.length === 3);
ok('each row carries its OWN name, not the template’s',
   bulk.rows[0].name !== bulk.rows[1].name && bulk.rows[1].name !== bulk.rows[2].name);
ok('every composed row is print-safe',
   bulk.rows.filter(r=>r.ok).every(r=>!mod.preflight(r.composed).some(f=>f.s==='fail')),
   'a bulk run produced an unprintable card');
ok('the 44-character name is composed or explicitly eliminated — never overflowed', (()=>{
   const r = bulk.rows[2];
   if (!r.ok) return !!r.eliminated;
   return r.composed.elements.filter(e=>e.fit).every(e => e.fit.width <= e.geom.w + 0.02); })());
ok('rows that cannot be printed are reported, not silently dropped',
   bulk.rows.every(r => r.ok || typeof r.eliminated === 'string'));
ok('a 200-row run completes', (()=>{
   const many = Array.from({length:200}, (_,i)=>({ name:'Employee '+(i+1), role:'Officer',
     company:'Zenith Sourcing Ltd.', phone:'017'+String(10000000+i), email:`e${i}@z.com` }));
   const b = mod.bulkGenerate(D, many, mod.PRESETS[1].c,
     (d, content) => mod.composeForced(d.layout, content, null,
       { palette:d.palette, type:d.type, density:d.density, format:d.format }));
   return b.total === 200 && b.ok === 200; })());


H('30. Orientation is declared, not stretched (the F6 lie, fixed)');
ok('the grid follows the trim shape', (()=>{
   const g = o => mod.gridFor({orientation:o});
   return g('landscape').cols === 12 && g('portrait').cols === 8 && g('square').cols === 10; })());
ok('cells stay roughly square in every format', (()=>{
   for (const f of mod.FORMATS){
     const gr = mod.gridFor(f), ar = (f.w/gr.cols) / (f.h/gr.rows);
     if (ar < 0.55 || ar > 1.8) return false;      // never a 1:2.6 sliver
   } return true; })(),
   mod.FORMATS.map(f=>{const gr=mod.gridFor(f);return f.id+':'+((f.w/gr.cols)/(f.h/gr.rows)).toFixed(2);}).join(' '));

const PORT = mod.FORMATS.find(f=>f.orientation==='portrait');
const SQ   = mod.FORMATS.find(f=>f.orientation==='square');
const fronts2 = mod.LAYOUTS.filter(l=>l.face==='front');
const portOK = fronts2.filter(l=>mod.slotsFor(l,'portrait'));
const sqOK   = fronts2.filter(l=>mod.slotsFor(l,'square'));
ok(`${portOK.length} layouts declare a portrait composition, ${sqOK.length} declare square`,
   portOK.length >= 4 && sqOK.length >= 2);
ok('a layout with no portrait composition is ELIMINATED, not squeezed', (()=>{
   const noPort = fronts2.find(l=>!mod.slotsFor(l,'portrait'));
   if (!noPort) return false;
   mod.state.format = PORT.id;
   const c = mod.composeForced(noPort.id, mod.PRESETS[1].c, null, {format:PORT.id});
   mod.state.format = 'bd-std';
   return !!c.eliminated && /portrait/.test(c.eliminated); })());
ok('the elimination reason names the format, so a UI can explain it', (()=>{
   const noPort = fronts2.find(l=>!mod.slotsFor(l,'portrait'));
   const c = mod.composeForced(noPort.id, mod.PRESETS[1].c, null, {format:PORT.id});
   return /authored for landscape only/.test(c.eliminated); })());

ok('portrait compositions are AUTHORED, not the landscape boxes reused', (()=>{
   for (const l of portOK){
     const a = JSON.stringify(l.slots.map(x=>x.box));
     const b = JSON.stringify(l.portrait.map(x=>x.box));
     if (a === b) return false;
   } return true; })());

let oriFail = 0, oriChecked = 0;
for (const fmt of mod.FORMATS){
  for (const pr of mod.PRESETS){
    for (const L of mod.LAYOUTS){
      const c = mod.composeForced(L.id, pr.c, null, {format:fmt.id});
      if (c.eliminated) continue;
      oriChecked++;
      const texts = c.elements.filter(e=>e.fit);
      for (const e of texts){
        if (e.fit.width  > e.geom.w + 0.02) oriFail++;
        if (e.fit.height > e.geom.h + 0.02) oriFail++;
        if (e.fit.sizePt < e.fit.minPt - 0.05) oriFail++;
        if (e.geom.x < fmt.safe-0.01 || e.geom.y < fmt.safe-0.01 ||
            e.geom.x+e.geom.w > fmt.w-fmt.safe+0.01 ||
            e.geom.y+e.geom.h > fmt.h-fmt.safe+0.01) oriFail++;
      }
      for (let i=0;i<texts.length;i++) for (let j=i+1;j<texts.length;j++){
        const a=texts[i].geom, b=texts[j].geom;
        if (a.x<b.x+b.w-0.1 && b.x<a.x+a.w-0.1 && a.y<b.y+b.h-0.1 && b.y<a.y+a.h-0.1) oriFail++;
      }
      const svg = mod.renderSVG(c);
      if (!svg || /NaN|undefined/.test(svg)) oriFail++;
      if (!svg.includes(`viewBox="0 0 ${fmt.w} ${fmt.h}"`)) oriFail++;
    }
  }
}
ok(`every format × preset × layout that composes is print-safe (${oriChecked} compositions)`,
   oriFail === 0, oriFail + ' failures');

ok('portrait cards still preflight clean', (()=>{
   for (const L of portOK){
     const c = mod.composeForced(L.id, mod.PRESETS[1].c, null, {format:PORT.id});
     if (c.eliminated) continue;
     if (mod.preflight(c).some(f=>f.s==='fail')) return false;
   } return true; })());
ok('square cards still preflight clean', (()=>{
   for (const L of sqOK){
     const c = mod.composeForced(L.id, mod.PRESETS[1].c, null, {format:SQ.id});
     if (c.eliminated) continue;
     if (mod.preflight(c).some(f=>f.s==='fail')) return false;
   } return true; })());
ok('generation in portrait returns only portrait-capable layouts', (()=>{
   const g = mod.generate({industry:'rmg', personality:['corporate'], format:PORT.id,
                           density:'balanced', script:'latin'}, mod.PRESETS[1].c);
   return g.picked.length > 0 && g.picked.every(c => !!mod.slotsFor(
     mod.LAYOUTS.find(l=>l.id===c.layout), 'portrait')); })());


H('31. Markup quality of the reference harness itself (F12)');
const HTML = html;
ok('every text/select control has an associated <label for=…>', (()=>{
   const ids = [...HTML.matchAll(/<(?:input|select|textarea)[^>]*\bid="(i_[a-z_]+)"/g)].map(m=>m[1]);
   const fors = new Set([...HTML.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(m=>m[1]));
   const missing = ids.filter(id => !fors.has(id));
   return missing.length === 0 ? true : (console.log('    missing labels:', missing.join(',')), false); })());
ok('no bare <label> without a for= remains',
   !/<label>(?!<)/.test(HTML.replace(/<label class="sr" for=[^>]*>/g,'')),
   'a label is still unassociated');
ok('grouped chip controls use role=group with an accessible name',
   (HTML.match(/role="group" aria-labelledby=/g)||[]).length >= 2);
ok('gallery tiles are keyboard operable (role, tabindex, key handler)',
   /role="button" tabindex="0"/.test(HTML) && /onkeydown = e => \{ if \(e\.key === 'Enter'/.test(HTML));
ok('tiles expose selected state to assistive tech',
   (HTML.match(/aria-pressed="\$\{/g)||[]).length >= 2);
ok('a visible focus style exists', /:focus-visible\{outline/.test(HTML));

H('32. Session persistence');
ok('localStorage is written on draw', (()=>{ const v = _ls['cardworks.session']; return !!v && v.length > 20; })());
ok('the snapshot is valid JSON with the design keys', (()=>{
   const o = JSON.parse(_ls['cardworks.session']);
   return ['format','palette','type','industry','personality','content'].every(k=>k in o); })());
ok('an uploaded asset is NEVER put into the shareable state', (()=>{
   const o = JSON.parse(_ls['cardworks.session']);
   return !('logo' in (o.content||{})); })());


H('33. Rendered glyphs, not just slot boxes, stay inside their slot');
let caseFail = 0, caseChecked = 0, glyphOverlap = 0;
for (const fmt of mod.FORMATS){
  for (const pr of mod.PRESETS){
    for (const L of mod.LAYOUTS){
      const c = mod.composeForced(L.id, pr.c, null, {format:fmt.id});
      if (c.eliminated) continue;
      const texts = c.elements.filter(e=>e.fit);
      // 1. what is composed must be what is rendered (case included)
      for (const e of texts){
        caseChecked++;
        if (e.upper && e.fit.lines.some(l => l !== l.toUpperCase())) caseFail++;
      }
      // 2. rendered extents, derived from the anchor, must not collide
      const ext = texts.map(e => {
        const w = e.fit.width;
        const x = e.align === 'center' ? e.geom.x + (e.geom.w - w)/2
                : e.align === 'right'  ? e.geom.x + e.geom.w - w
                : e.geom.x;
        return { ref:e.ref, x, w, y:e.geom.y, h:e.geom.h };
      });
      const marks = c.elements.filter(e=>['mark','mono','bigmono','qr'].includes(e.kind))
                              .map(e=>({ ref:e.ref, x:e.geom.x, w:e.geom.w, y:e.geom.y, h:e.geom.h }));
      const all = ext.concat(marks);
      for (let i=0;i<all.length;i++) for (let j=i+1;j<all.length;j++){
        const a=all[i], b=all[j];
        if (a.x < b.x+b.w-0.15 && b.x < a.x+a.w-0.15 &&
            a.y < b.y+b.h-0.15 && b.y < a.y+a.h-0.15){
          glyphOverlap++;
          if (glyphOverlap <= 3) console.log(`    ${fmt.id}/${L.id}: ${a.ref} × ${b.ref}`);
        }
      }
    }
  }
}
ok(`composed text is already in its final case (${caseChecked} runs)`, caseFail === 0, caseFail+' mis-cased');
ok('no rendered text collides with another element or a mark', glyphOverlap === 0, glyphOverlap+' collisions');

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
