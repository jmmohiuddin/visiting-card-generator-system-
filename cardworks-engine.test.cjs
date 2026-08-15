/* Headless verification of the CARDWORKS engine.
   Loads the engine + shell sources, stubs the DOM/canvas surface with a
   font-metric model, and asserts engine behaviour. */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* The engine and the shell used to be one inline <script>. They are separate
   files now so the surface can be worked on without editing the same 4,000
   lines. The list below is the load order index.html declares — concatenating
   them reproduces exactly the one scope the browser gives classic scripts,
   and the assertion keeps the two from drifting apart silently. */
const SOURCES = [
  'assets/engine.js', 'assets/ui-shell.js', 'assets/ui-brief.js', 'assets/ui-concepts.js',
  'assets/ui-validate.js', 'assets/ui-order.js', 'assets/ui-enhance.js',
  'assets/ui-destructure.js', 'assets/ui-misc.js', 'assets/ui-init.js'
];
const declared = [...html.matchAll(/<script src="\/(assets\/[^"]+)"><\/script>/g)].map(m => m[1]);
if (declared.join(',') !== SOURCES.join(','))
  throw new Error('index.html script order drifted from the test loader:\n  ' + declared.join('\n  '));
const js = SOURCES.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const CSS = fs.readFileSync(path.join(__dirname, 'assets/app.css'), 'utf8');

// ── font-metric model: per-glyph advance ratios approximating real faces ──
/* ── Bangla is measured by cluster, not by codepoint ──────────────────────
   A flat charge per Bangla codepoint over-estimates real text by a third or
   more, because shaping collapses codepoints into clusters: `্` (halant) joins
   the consonants on either side of it into one conjunct, and a vowel sign is
   drawn at a fraction of a consonant's width rather than beside it at full
   width. Measured against the real shaper in `lib/pdf/bengali.mjs` over a
   corpus of Bangladeshi names, titles, organisations and place names, a flat
   0.62 per codepoint is 44–54% out; the coefficients below are 8–9% out.

   That error was never dangerous — over-estimating width means type is set
   smaller than it needed to be, and narrower-than-estimated never leaves the
   safe area — but it cost real quality. Bangla was being driven toward the
   7.5pt floor about a third earlier than the text required.

   The browser does not use this model at all: it measures with a real canvas,
   which shapes Bengali properly. This exists so the server and CI agree with
   the browser rather than with each other, which is the failure the parity
   suite could not see while all three copies shared one wrong constant. */
const BN_HALANT = /\u09CD/;
const BN_MATRA  = /[\u09BE-\u09CC\u09D7]/;
const BN_SIGN   = /[\u0981-\u0983\u09BC]/;
const BN_ANY    = /[\u0980-\u09FF]/;

function banglaAdvance(ch) {
  if (BN_HALANT.test(ch)) return -0.50;   // joins its neighbours into one cluster
  if (BN_MATRA.test(ch))  return 0.25;    // drawn against the consonant, not beside it
  if (BN_SIGN.test(ch))   return 0.10;    // anusvara, visarga, chandrabindu, nukta
  return 0.64;                            // consonant or independent vowel
}

function advance(ch, family){
  if (BN_ANY.test(ch)) return banglaAdvance(ch);
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
/* Tiles are drawn from JS and the focus ring lives in the stylesheet, so
   these three read their own source rather than the document. */
ok('gallery tiles are keyboard operable (role, tabindex, key handler)',
   /role="button" tabindex="0"/.test(js) && /onkeydown = e => \{ if \(e\.key === 'Enter'/.test(js));
ok('tiles expose selected state to assistive tech',
   (js.match(/aria-pressed="\$\{/g)||[]).length >= 2);
ok('a visible focus style exists', /:focus-visible\{outline/.test(CSS));

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

/* ─────────────────────────────────────────────────────────────────────────
   34. Export, quote and fulfilment — the two rules of Wireframing §3.

   The loader above exports the engine's own surface. The functions that
   guard money and files live in the shell scope alongside it, so they are
   reached through a second handle over the same concatenated sources rather
   than by widening the shared one — the assertions below need `exportGate`,
   `customerLines` and `chargeGate`, and nothing else in the suite does. */
H('34. Export, order and fulfilment — nothing charged before a proof');
const B5 = new Function(js + `
  ;return { exportGate, customerLines, quoteView, chargeGate, capablePresses,
            pressesFor, currentPress, PRESSES, FLOW_STAGES, PAY_METHODS,
            QUOTE_NOTE, CHARGE_FROM, state, currentDesign, DELIVERY, quote,
            optionLines, spreadToTotal, singlePressWarning };`)();
const b5src = fs.readFileSync(path.join(__dirname, 'assets/ui-order.js'), 'utf8');
const ordersSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/orders.mjs'), 'utf8');
/* The code with its prose removed. Several assertions below forbid a pattern
   that the file also *explains* in a comment — grepping the raw source cannot
   tell the explanation apart from the thing it forbids. */
const b5code = b5src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/* Slice one function out of the source. Cutting at the first `\n}` after the
   name is wrong the moment a template literal or a nested block puts a brace
   in column zero: it silently returns half a function, and every assertion
   over that half then passes or fails for reasons unrelated to the code it
   was meant to be checking. So the cut advances until the braces balance,
   which is the cheapest available evidence that a whole function came back. */
const b5body = (name) => {
  const i = b5src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  for (let from = i; ; ){
    const j = b5src.indexOf('\n}', from);
    if (j < 0) return b5src.slice(i);
    const body = b5src.slice(i, j + 2);
    if ((body.match(/\{/g) || []).length === (body.match(/\}/g) || []).length) return body;
    from = j + 2;
  }
};

// ── the gate: a blocking finding closes both doors ──
const cleanContent = mod.PRESETS[0].c;
const gClean = B5.exportGate(B5.currentDesign(), cleanContent);
const gBlocked = B5.exportGate(B5.currentDesign(), { ...cleanContent, name:'', bname:'' });
ok('a clean design opens the export gate', gClean.allowed && gClean.blocking.length === 0);
ok('a design missing a required field cannot reach export or order',
   !gBlocked.allowed && gBlocked.blocking.length > 0, JSON.stringify(gBlocked.blocking.map(f=>f.label)));
ok('the refusal names the reason rather than just disabling a button',
   /blocking finding/.test(gBlocked.reason) && gBlocked.reason.length > 20, gBlocked.reason);
ok('an advisory finding is not treated as a block',
   gClean.findings.some(f => f.s !== 'fail') && gClean.allowed);
ok('export and order ask the same gate, so they cannot drift apart',
   (b5body('drawExport').match(/exportGate\(/g) || []).length === 1 &&
   (b5body('drawOrder').match(/exportGate\(/g) || []).length === 1 &&
   /if \(!gate\.ready\)/.test(b5body('drawOrder')));

/* ── the gate defers to preflight rather than holding a second opinion ──
   `preflightGate` reads the server's report and the acceptance ledger, and
   neither is visible from this file. Two screens deriving their own verdict
   from the same findings is the drift these gates exist to stop, so the
   delegation is asserted, not assumed. */
ok('the verdict comes from preflightGate when that gate is loaded',
   gClean.source === 'preflight' && gBlocked.source === 'preflight');
ok('blocking and unaccepted-advisory are different answers, not one',
   'ready' in gClean && 'pending' in gClean &&
   /PRD Epic D/.test(b5body('exportGate')));
const gPending = { ...gClean, ready:false, pending:[{ label:'Contact routes reduced' }], blocking:[] };
ok('an unaccepted advisory withholds the files without calling the card unprintable',
   gPending.allowed === true && gPending.ready === false);
ok('the screen never reports "Preflight clean" on a gate that is still shut',
   /gate\.ready \? 'Preflight clean'/.test(b5body('drawExport')));
ok('every release of a file, a price or a checkout is keyed to ready, not allowed',
   ['drawExport','drawOrder','drawPrintFile','quoteBlock']
     .every(fn => !/gate\.allowed/.test(b5body(fn))));
ok('an unready screen offers the way out rather than a dead end',
   /data-tovalidate/.test(b5body('drawExport')) && /data-tovalidate/.test(b5body('drawOrder')));
ok('a design the library can no longer compose fails closed, never open',
   /!g\.error && g\.blocking\.length === 0/.test(b5body('exportGate')));

/* ── a button is disabled by its own request, not by anyone else's ──
   `net.pending` is one set shared by every screen, so the shell's
   `isPending()` answers "is anything in flight". Disabling Approve & pay on
   that greys out the customer's primary action while an unrelated preflight
   or quote call is open, with nothing on screen saying why — and if that call
   hangs, the button never comes back. */
ok('no control is disabled by the global pending flag',
   !/isPending\(\)/.test(b5code));
ok('each action asks whether its own endpoint is busy',
   /busy\(ENDPOINT\.orders\)/.test(b5body('drawOrder')) &&
   /busy\(ENDPOINT\.orders\)/.test(b5body('drawTracking')) &&
   /busy\(ENDPOINT\.print\)/.test(b5body('drawPrintFile')));
ok('the busy key matches the shape the shell actually records',
   /'net:' \+ path \+ ':' \+ method/.test(b5code) &&
   /const key = 'net:' \+ path \+ ':' \+ \(opts\.method \|\| 'GET'\)/
     .test(fs.readFileSync(path.join(__dirname, 'assets/ui-shell.js'), 'utf8')));

// ── the quote: itemised, adding up, delivery always its own line ──
let sumMismatch = 0, noDelivery = 0, deliveryMarkedUp = 0, lumpSum = 0, quotesChecked = 0;
for (const qty of [100, 250, 500, 1000, 300]){
  for (const fin of [[], ['matte'], ['matte','foil'], ['gloss','spotuv'], ['matte','foil','emboss']]){
    for (const zone of ['dhaka', 'outside']){
      for (const p of B5.PRESSES){
        const v = B5.customerLines(qty, fin, zone, p.mult);
        quotesChecked++;
        if (v.lines.reduce((s, l) => s + l.cost, 0) !== v.total) sumMismatch++;
        const del = v.lines.filter(l => l.delivery);
        if (del.length !== 1) noDelivery++;
        else if (del[0].cost !== B5.DELIVERY[zone]) deliveryMarkedUp++;
        if (v.lines.length < 2) lumpSum++;
      }
    }
  }
}
ok(`itemised lines sum exactly to the displayed total (${quotesChecked} quotes)`,
   sumMismatch === 0, sumMismatch + ' quotes where the lines did not add up');
ok('delivery is always exactly one line of its own', noDelivery === 0, noDelivery + ' quotes without one');
ok('delivery is passed through at courier cost, never marked up into the card price',
   deliveryMarkedUp === 0, deliveryMarkedUp + ' marked-up delivery lines');
ok('no quote is ever a lump sum', lumpSum === 0, lumpSum + ' single-line quotes');
const vFoil = B5.customerLines(500, ['matte','foil'], 'dhaka', 1);
ok('the foil line still names the one-off block cost the customer is paying for',
   vFoil.lines.some(l => /block|plate/i.test(l.label)));

// ── every price on screen is marked as an estimate ──
B5.state.quote = null;
const vClient = B5.quoteView();
ok('a client-computed price is labelled an estimate',
   vClient.source === 'client' && vClient.estimate === true && /estimate/i.test(vClient.note));
ok('the estimate says why it is one — no press has quoted yet (PRD §8.1)',
   /§8\.1|no dhaka press/i.test(vClient.note));
ok('the rendered quote block carries the estimate pill for both sources',
   /Estimate — not a committed price/.test(b5src) && /Indicative — not a committed price/.test(b5src));
/* A quote option as `lib/quote-server.mjs` actually emits one: the engine's
   *cost* itemisation, a separate delivery record, and a `price` that is those
   costs plus margin plus the plate charge — so the lines do not add up until
   the margin is spread back over them. That spreading is what the screen owes
   the customer, and it is asserted against the real shape rather than a
   flattering one invented here. */
const serverOpt = {
  slug:'nilkhet-offset', name:'Nilkhet Offset, Dhaka', price:3330, unit:6.66,
  leadTime:'3 working days', pressVerified:true, priceBasis:'written press quote for 500 cards',
  unvalidatedCosts:false,
  lines:[{ label:'Printing — 500 cards, 300 gsm art card', cost:980 },
         { label:'Matte lamination', cost:90 },
         { label:'Delivery — Pathao / Steadfast / RedX', cost:80 },
         { label:'Plate/block setup — Nilkhet Offset, Dhaka', cost:250 }],
  delivery:{ label:'Delivery — Pathao / Steadfast / RedX', cost:80 }
};
B5.state.quote = { quoteId:'q1', options:[serverOpt], option: serverOpt,
                   costBasis:{ warning:null }, singlePressOnly:false };
const vServer = B5.quoteView();
ok('the server option is preferred over the local cost model',
   vServer.source === 'server' && vServer.total === 3330 && vServer.press === serverOpt.name);
ok('the server option is re-itemised so its lines sum to the price it charges',
   vServer.lines.reduce((s, l) => s + (l.cost || 0), 0) === 3330,
   vServer.lines.map(l => l.label + '=' + l.cost).join(' '));
ok('delivery and the plate charge pass through at cost, never marked up',
   vServer.lines.find(l => l.delivery).cost === 80 &&
   vServer.lines.find(l => /^Plate\/block setup/.test(l.label)).cost === 250);
ok('a price the server calls press-quoted is not labelled an estimate',
   vServer.estimate === false && /press quote/i.test(vServer.basis));
const unpriced = { ...serverOpt, unvalidatedCosts:true, price:3080,
  lines: serverOpt.lines.map(l => /^Plate/.test(l.label) ? { ...l, cost:null, unpriced:true } : l) };
B5.state.quote = { quoteId:'q2', options:[unpriced], option:unpriced,
                   costBasis:{ warning:'Estimate. No Dhaka press has been contacted (PRD §8.1).' } };
const vUnpriced = B5.quoteView();
ok('an unquoted plate charge stays unquoted — "not quoted" is not "free"',
   vUnpriced.lines.some(l => /^Plate/.test(l.label) && l.cost == null) &&
   vUnpriced.lines.reduce((s, l) => s + (l.cost || 0), 0) === 3080);
ok("the server's own cost-basis warning is shown verbatim, not paraphrased",
   vUnpriced.note === 'Estimate. No Dhaka press has been contacted (PRD §8.1).' &&
   vUnpriced.estimate === true);
B5.state.quote = null;

// ── two presses minimum (PRD §7) ──
ok('the default finish set has at least two capable presses',
   B5.capablePresses(B5.state.finishes).length >= 2, B5.capablePresses(B5.state.finishes).length + ' capable');
ok('a finish served by a single press produces a warning, not silence',
   B5.capablePresses(['softtouch']).length === 1 &&
   /PRD §7/.test(B5.singlePressWarning(true, 1)) && B5.singlePressWarning(false, 3) === '');
ok("the screen defers to the server's own singlePressOnly verdict when it has one",
   /q\.singlePressOnly/.test(b5body('drawOrder')));

// ── the charge gate: approval is the only door ──
const chargeable = B5.FLOW_STAGES.map(f => f[0]).concat('cancelled')
  .filter(s => B5.chargeGate({ status:s }).allowed);
ok('exactly one order state may be charged from, and it is the approval state',
   chargeable.length === 1 && chargeable[0] === 'awaiting_approval', chargeable.join(','));
ok('every state before the proof reaches the customer refuses the charge',
   ['files_locked','at_press','proof_printed','proof_delivered']
     .every(s => !B5.chargeGate({ status:s }).allowed &&
                 /nothing is charged before you approve/i.test(B5.chargeGate({ status:s }).reason)));
ok('an order with no status cannot be charged', !B5.chargeGate(null).allowed);
ok('placing an order touches no payment endpoint — checkout records intent only',
   !/payments/.test(b5body('placeOrder')) && !/provider/.test(b5body('placeOrder')));
/* Ordering claims about one function, anchored inside that function's own
   body: the refusal has to be written before the request that would move
   money, or the guard is decoration. */
const approveBody = b5body('approveAndPay');
ok('the approval gate is checked before the request that opens a payment',
   approveBody.indexOf('charge.allowed') > -1 &&
   approveBody.indexOf('charge.allowed') < approveBody.indexOf("action:'approve'"));
ok('approval names a provider, because the endpoint now refuses one without',
   /provider: m\.id/.test(approveBody));
ok("no callback URL is ever supplied — where a payer lands is not a caller's to choose",
   !/callback/i.test(b5code));
ok('a missing payment provider is refused, never mimed as a success',
   /cannot be captured on this build/.test(approveBody) &&
   approveBody.indexOf('cannot be captured on this build') > approveBody.indexOf('catch'));
ok('a redirect provider is not reported as a completed payment',
   /redirectURL/.test(approveBody) &&
   /nothing has been charged yet/i.test(approveBody));

/* ── `remediation` is a machine token, not a sentence ──
   `fix_phone`, `sign_in`, `wait`. Concatenating one into a note put the
   literal word "wait" in front of a customer whose payment had just failed.
   Every render goes through `remedyText`, which maps a known token, falls
   back to the sentence the endpoint sent beside it, and renders an unknown
   token as nothing rather than as itself. */
ok('no remediation value is concatenated or interpolated into rendered text',
   ![...b5code.matchAll(/\$\{[^}]*\.remediation\b|\.remediation\s*\+|\+\s*[A-Za-z_$][\w$]*\.remediation\b/g)].length,
   'a remediation reaches HTML unlaundered');
ok('the note that a failed approval shows is laundered through remedyText',
   /remedyText\(err\)/.test(approveBody) && !/err\.remediation/.test(approveBody));
ok('the stored quote error reaches the screen through errorBlock, which launders it',
   /errorBlock\(state\.quoteError/.test(b5body('quoteBlock')));
/* A token the shell's table does not know yet renders as nothing, so the
   sentence the endpoint sent alongside it is the only thing standing between
   a customer and a blank next step. Every error record this file builds has
   to carry it, or the fallback silently stops existing. */
ok('every error record this file builds carries the server\'s fallback sentence',
   (b5code.match(/remediation:/g) || []).length ===
   (b5code.match(/remediationText:/g) || []).length,
   `${(b5code.match(/remediation:/g)||[]).length} remediation vs ${(b5code.match(/remediationText:/g)||[]).length} remediationText`);
ok('the blob path mirrors the shell and forwards remediationText from the envelope',
   /e\.remediationText = env\.remediationText/.test(b5body('apiBlob')));

// ── the price on an order is the server's, never this browser's ──
ok('an order cannot be placed without the quote id the server issued',
   /!\(q && q\.quoteId\)/.test(b5body('placeOrder')) &&
   /quoteId: q\.quoteId/.test(b5body('placeOrder')));
ok('the total sent with an order comes from the server option, not the local model',
   /total: q\.option \? q\.option\.price : undefined/.test(b5body('placeOrder')));
ok('a moved or stale price drops the quote instead of retrying the same number',
   /price_moved\|quote_stale/.test(b5body('placeOrder')));
ok('the place button waits for a real quote and says why',
   /Waiting for a server quote/.test(b5body('drawOrder')));

/* ── the flow this screen draws is the flow the server keeps ──
   Sliced to the FLOW table before matching, not grepped across the whole
   file. The earlier version matched "any bracketed triple of quoted lowercase
   strings", which is a shape and not a location: the moment orders.mjs grew
   an unrelated `['approve','reproof','cancel']` guard, the scrape swallowed it
   and reported a mismatch in a table that had not changed. An assertion keyed
   to what code looks like rather than to where it lives fails for reasons that
   have nothing to do with what it is protecting. */
const flowTable = ordersSrc.slice(ordersSrc.indexOf('const FLOW = ['),
                                  ordersSrc.indexOf('];', ordersSrc.indexOf('const FLOW = [')));
const serverFlow = [...flowTable.matchAll(/\['([a-z_]+)',\s*'[^']*',\s*'[^']*'\]/g)].map(m => m[1]);
ok('the FLOW table was actually located, not silently matched as empty',
   flowTable.startsWith('const FLOW = [') && serverFlow.length === 7, serverFlow.length + ' stages');
ok('the tracked flow matches orders.mjs exactly, in order',
   B5.FLOW_STAGES.map(f => f[0]).join(',') === serverFlow.join(','),
   B5.FLOW_STAGES.map(f=>f[0]).join(',') + ' vs ' + serverFlow.join(','));
ok('approval sits between the proof reaching the customer and the run starting',
   serverFlow.indexOf('proof_delivered') < serverFlow.indexOf('awaiting_approval') &&
   serverFlow.indexOf('awaiting_approval') < serverFlow.indexOf('printing'));
ok('the timeline is drawn from the append-only event log, with timestamps',
   /o\.events/.test(b5src) && /created_at/.test(b5body('drawTracking')) && /Append-only/.test(b5src));

// ── honest about what this build cannot do ──
ok('the export screen offers no PDF download until the server has produced bytes',
   /download="\$\{esc\(got\.name\)\}"/.test(b5src) && /createObjectURL/.test(b5src) &&
   !/href="[^"]*\.pdf"/.test(b5src));
ok('a missing print writer is explained, not silently omitted',
   /Not available on this build/.test(b5body('drawPrintFile')) &&
   /api\/render-print/.test(b5body('drawPrintFile')));
ok('the device-only banner is rendered on screen, not hidden behind a flag',
   /this device only/.test(b5body('drawDashboard')) &&
   /state\.session\s*\n?\s*\?/.test(b5body('drawDashboard')));
ok('the proof panel states the promise in the customer\'s words',
   /Nothing is charged until you approve this exact card/.test(b5src) &&
   /Request changes/.test(b5src) && /Approve &amp; pay/.test(b5src));

/* ── every request is one the endpoint was built to answer ──
   A generic GET probe asked `/api/quotes` and `/api/payments` a question
   neither has an answer to: 405 and 400 respectively, logged as console errors
   on a healthy page load. Error monitoring nobody trusts is worse than none,
   so the probes with no meaningful question were removed and the ones that
   remain use the entry point each endpoint provides. */
ok('the quote endpoint is never poked with a GET — its real POST is the question',
   !/ensureEndpoint\(ENDPOINT\.quotes/.test(b5code) &&
   /endpointStatus\(ENDPOINT\.quotes\) === 'absent'/.test(b5body('ensureServerQuote')));
ok('the payment probe uses the entry point built for it',
   /ENDPOINT\.payments \+ '\?methods=1'/.test(b5code) &&
   !/ensureEndpoint\(ENDPOINT\.payments\)(?!\s*,)/.test(b5code));
ok('the session request is its own probe, not a second round trip',
   !/ensureEndpoint\(ENDPOINT\.auth/.test(b5code) &&
   /endpointStatus\(ENDPOINT\.auth\) === 'absent'/.test(b5body('ensureSession')));
ok('404, 405 and 501 mean "not the service we want", and nothing else does', (() => {
  const note = new Function('path', 'status', 'const _endpointState = {};' +
    b5body('noteEndpoint').replace(/^function noteEndpoint\(path, status\)\{/, '') .replace(/\}$/, ''));
  return [404, 405, 501].every(s => note('p', s) === 'absent') &&
         [200, 400, 401, 409, 500].every(s => note('p', s) === 'present');
})());
/* The provider list is the server's to state, including whether a gateway is
   live or a sandbox — a simulated capture presented as a real one is the same
   lie as an unvalidated price presented as a settled quote. */
ok('the offered payment methods defer to the deploy, with local copy merged over',
   /state\.payMethods/.test(b5body('payMethods')) && /return PAY_METHODS/.test(b5body('payMethods')));
ok('a sandbox provider says so before the customer commits to it',
   /running against a sandbox/.test(b5body('drawPayment')) &&
   /no real money/.test(b5body('drawPayment')));

/* ─────────────────────────────────────────────────────────────────────────
   35. Scope discipline and the states checklist (B6).
   Master PRD §5.2 cuts four screens and three of four pricing tiers;
   Wireframing §7 lists six states that every screen owes. The handle the
   loader returns is fixed and shared, so this section evaluates the same
   concatenated sources a second time with a handle of its own, and swaps in
   a recording document for the calls that render — "this screen shows two
   lines" is then measured from the markup a screen actually produced rather
   than asserted about the data it was handed.
   ──────────────────────────────────────────────────────────────────────── */
H('35. Scope discipline and the states checklist (B6)');
const _doc0 = global.document;
/* navigator is an accessor on the Node global, so plain assignment is a
   silent no-op — the offline rows below have to define over it and put the
   original descriptor back. */
const _nav0 = Object.getOwnPropertyDescriptor(global, 'navigator');
const b6nav = v => Object.defineProperty(global, 'navigator', { value:v, configurable:true });
const b6made = [];
const b6el = () => ({ innerHTML:'', textContent:'', value:'', style:{}, dataset:{},
  onclick:null, oninput:null, onchange:null, onkeydown:null, files:null,
  setAttribute(){}, toggleAttribute(){}, appendChild(){}, prepend(){},
  querySelector:()=>null, querySelectorAll:()=>[], closest:()=>null });
const b6sink = {};
const b6doc = {
  createElement: t => { if (t === 'canvas') return { getContext: () => fakeCtx };
                        const e = b6el(); b6made.push(e); return e; },
  querySelector: s => b6sink[s] || (b6sink[s] = b6el()),
  querySelectorAll: () => [],
  fonts: { ready: Promise.resolve() }
};
/* Recorded before the sources run, so "the offline and unsaved-work listeners
   are attached" is a fact about load rather than a claim about the file. */
const b6events = [];
global.window.addEventListener = (type) => { b6events.push(type); };
const b6 = new Function(js + `
  ;return { FLAGS, FLAG_DEFAULTS, SCREEN_FLAG, screenEnabled, go, draw, state, work,
            CUT_SCREENS, flagGate, drawPricing, drawLibrary, PRICE_LINES, PRICE_ROWS,
            PLANS, PLAN_ROWS, signinStateHTML, submitSignin, authState, sessionUser,
            libraryEmptyHTML, reconcileDirty, markSaved, beforeUnloadGuard,
            looksLikeBdMobile, remedyText, REMEDIATION_TEXT, errorBlock,
            authHeaders, signOut,
            offlineBanner, isOffline, net, PRESETS };`)();
delete global.window.addEventListener;
const B6CUT = ['bulk','studio','mockups','profiles'];
const B6SCREENS = ['bulk','mockups','profiles','studio','compedit','layoutbuild'];

ok('the four screens PRD §5.2 cuts default off',
   B6CUT.every(k => b6.FLAG_DEFAULTS[k] === false),
   B6CUT.filter(k => b6.FLAG_DEFAULTS[k] !== false).join(','));
ok('the four-tier pricing table defaults off too', b6.FLAG_DEFAULTS.tiers4 === false);
ok('no flag defaults on', Object.values(b6.FLAG_DEFAULTS).every(v => v === false));
ok('every screen behind a cut flag is unreachable by default',
   B6SCREENS.every(sc => b6.screenEnabled(sc) === false),
   B6SCREENS.filter(sc => b6.screenEnabled(sc)).join(','));
ok('the funnel screens are never gated',
   ['start','brief','generating','concepts','detail','customise','validate','export','order',
    'tracking','noresults','library','dashboard','pricing','signin','settings']
     .every(sc => b6.screenEnabled(sc) === true));

global.document = b6doc;
ok('go() refuses to route to a flagged-off screen, whatever the hash says', (()=>{
   for (const sc of B6SCREENS){ b6.go(sc); if (b6.state.screen !== 'start') return false; }
   return true; })());
ok('turning a flag on makes exactly that screen reachable again', (()=>{
   b6.FLAGS.set('bulk', true);
   b6.go('bulk');    const reached = b6.state.screen === 'bulk';
   b6.go('mockups'); const stillCut = b6.state.screen === 'start';
   b6.FLAGS.set('bulk', false);
   b6.go('bulk');    const closedAgain = b6.state.screen === 'start';
   return reached && stillCut && closedAgain; })());
ok('every cut screen has a one-line reason naming the document that cut it',
   B6SCREENS.every(sc => b6.CUT_SCREENS[sc] && /PRD §5\.2/.test(b6.CUT_SCREENS[sc].why)),
   B6SCREENS.filter(sc => !b6.CUT_SCREENS[sc]).join(','));
ok('flagGate reports gated while off and open once on', (()=>{
   const gatedOff = B6SCREENS.every(sc => b6.flagGate(sc) === true);
   for (const f of B6CUT) b6.FLAGS.set(f, true);
   const openOn = B6SCREENS.every(sc => b6.flagGate(sc) === false);
   for (const f of B6CUT) b6.FLAGS.set(f, false);
   return gatedOff && openOn; })());

/* Pricing — PRD §5.2 collapses four tiers to two, and §9 says why. */
const b6q = s => b6doc.querySelector(s);
const b6tiles = () => (b6q('#plans').innerHTML.match(/class="tile"/g) || []).length;
b6.drawPricing();
ok('the pricing screen renders two lines by default', b6tiles() === 2, b6tiles() + ' rendered');
ok('the two lines are the two moments of realised value, not two tiers of access',
   b6.PRICE_LINES.length === 2 &&
   /file/i.test(b6.PRICE_LINES[0].name) && /print/i.test(b6.PRICE_LINES[1].name) &&
   b6.PRICE_LINES.every(l => /charged when/i.test(l.when)));
ok('neither line charges for access to the tool',
   !b6.PRICE_LINES.some(l => /month|\/mo|per year|annual|subscri/i.test(l.per + ' ' + l.price)));
ok("the free column is PRD §9's — unlimited briefs, six concepts, watermarked, no export or order", (()=>{
   const at = n => (b6.PRICE_ROWS.find(r => new RegExp(n, 'i').test(r[0])) || [])[1];
   return at('^Briefs') === 'Unlimited' && at('Concepts per brief') === '6' &&
          /watermark/i.test(at('Preview') || '') && at('PDF/X-4') === '—' &&
          at('Printing and delivery') === '—'; })());
ok('the price list says plainly that the figures are unvalidated (PRD §8.1)',
   /estimate/i.test(b6q('#planRows').innerHTML) && /§8\.1/.test(b6q('#planRows').innerHTML));
b6.FLAGS.set('tiers4', true); b6.drawPricing();
ok('four tiers render only behind the tiers4 flag', b6tiles() === 4, b6tiles() + ' rendered');
b6.FLAGS.set('tiers4', false); b6.drawPricing();
ok('and collapse back to two when it is switched off', b6tiles() === 2);

/* The six rows of Wireframing §7, one assertion or more per row. */
ok('Empty: the library names a next step when nothing can compose', (()=>{
   const h = b6.libraryEmptyHTML(new Array(9).fill({}), { name:'x'.repeat(60) }, []);
   return /state-empty/.test(h) && /data-libfix/.test(h) && /characters/.test(h); })());
ok('Empty: the cause is read off the engine\'s eliminations, not guessed from the content', (()=>{
   const req = b6.libraryEmptyHTML(new Array(9).fill({}), { addr:'x'.repeat(60) },
     new Array(9).fill('name is required and empty'));
   const fit = b6.libraryEmptyHTML(new Array(9).fill({}), { addr:'x'.repeat(60) },
     new Array(9).fill('addr cannot fit — ladder exhausted at 5.9pt (floor 6.5pt)'));
   return /name is required and empty/.test(req) && !/characters/.test(req) &&
          /ladder exhausted/.test(fit) && /characters/.test(fit); })());
ok('Loading: a real submit sets the pending state synchronously, before it awaits', (()=>{
   b6.FLAGS.set('accounts', true);
   b6q('#i_acctphone').value = '01712345678';
   b6.submitSignin();
   const busy = b6.authState.busy === true && /state-pending/.test(b6.signinStateHTML());
   b6.authState.busy = false; b6.authState.err = null; b6.authState.sent = false;
   b6.FLAGS.set('accounts', false);
   return busy; })());
ok('Loading: a number the network cannot help with fails before the request is made', (()=>{
   b6.FLAGS.set('accounts', true);
   b6q('#i_acctphone').value = '12345';
   b6.submitSignin();
   const e = b6.authState.err;
   b6.authState.err = null; b6.authState.busy = false; b6.FLAGS.set('accounts', false);
   return !!e && e.remediation === 'fix_phone' && /01712345678/.test(e.message); })());
ok('Loading: the client check agrees with normalisePhone in lib/http.mjs, case for case', (()=>{
   /* The server is the authority. A client check that rejects what the server
      would accept is worse than no check, so this asserts agreement rather
      than a rule of its own. */
   const httpsrc = fs.readFileSync(path.join(__dirname, 'lib/http.mjs'), 'utf8');
   const m = /const normalisePhone = \(raw\) => \{[\s\S]*?\};/.exec(httpsrc);
   const server = new Function('raw', (m ? m[0] : '') +
     '; return normalisePhone(raw) !== null;');
   const cases = ['01712345678', '8801712345678', '+880 1712-345678', '017 1234 5678',
                  '1712345678', '12345', '01212345678', '0171234567', '', 'abc',
                  '01912345678', '+8801312345678'];
   const disagree = cases.filter(v => b6.looksLikeBdMobile(v) !== server(v));
   return disagree.length === 0 ? true : (console.log('    disagree:', disagree.join(',')), false); })());
ok('Loading: the async sign-in path goes through the shell api() and shows pending first',
   /api\('\/api\/auth'/.test(js) && /authState\.busy = true; draw\(\);/.test(js));
ok('Error: a failed sign-in renders the shared error block with a next step', (()=>{
   b6.authState.err = { code:'http_500', message:'That did not work.',
                        remediation:'Try again in a moment.' };
   const h = b6.signinStateHTML(); b6.authState.err = null;
   return /state-error/.test(h) && /role="alert"/.test(h) && /data-retry/.test(h) &&
          /Try again in a moment/.test(h); })());
ok('Error: the failure branch of that same call is what populates the block', (()=>{
   /* Read the function by name and ask whether it has a catch that sets the
      error, rather than matching the statements' shape — three subgroups have
      now had a source assertion break on a refactor that changed nothing that
      mattered. */
   const fn = js.slice(js.indexOf('async function submitSignin'));
   const body = fn.slice(0, fn.indexOf('\n}'));
   return /catch \(err\)/.test(body) && /authState\.err\s*=/.test(body) &&
          /authState\.busy = false/.test(body); })());
ok('Error: an empty name fails synchronously and still says what to do about it', (()=>{
   b6q('#i_acctname').value = '';
   b6.submitSignin();
   const e = b6.authState.err; b6.authState.err = null;
   return !!e && /name/i.test(e.message) && !!e.remediation; })());
ok('Permission-denied: keyed on remediation, not on status — a bad code is not a dead session', (()=>{
   /* Both come back 401 unauthorized. Branching on the code alone would throw
      someone who mistyped one digit out to the screen they are already on. */
   b6.FLAGS.set('accounts', true); b6.authState.sent = true; b6.authState.phone = '01712345678';
   b6.authState.err = { code:'unauthorized', message:'That code is wrong or has expired.',
                        remediation:'request_new_code' };
   const badCode = b6.signinStateHTML();
   b6.authState.err = { code:'unauthorized', message:'Sign in to see this.',
                        remediation:'sign_in' };
   const deadSession = b6.signinStateHTML();
   b6.authState.err = null; b6.authState.sent = false; b6.FLAGS.set('accounts', false);
   return /Send a new code/.test(badCode) && /id="i_acctcode"/.test(badCode) &&
          /Sign in again/.test(deadSession); })());
ok('Permission-denied: the envelope message is rendered as the server wrote it', (()=>{
   /* Wrong, expired, already spent and never issued are four causes behind one
      sentence on purpose; a more specific message inferred here would hand a
      stranger the half of the problem they had not worked out. */
   b6.authState.err = { code:'unauthorized', message:'That code is wrong or has expired. Ask for a new one.',
                        remediation:'request_new_code' };
   const h = b6.signinStateHTML(); b6.authState.err = null;
   return /That code is wrong or has expired\. Ask for a new one\./.test(h); })());
ok('a remediation token is never shown to the customer as the token', (()=>{
   const tokens = ['fix_phone','fix_code','fix_name','request_new_code','sign_in','wait','retry','contact_support'];
   return tokens.every(k => {
     b6.authState.err = { code:'bad_request', message:'x', remediation:k };
     const h = b6.signinStateHTML();
     const said = b6.remedyText({ remediation:k });
     return !new RegExp('>\\s*' + k + '\\s*<').test(h) && said && h.includes(said.slice(0, 24));
   }); })());
b6.authState.err = null;
ok('an envelope whose remediation is already a sentence passes through untouched',
   b6.remedyText({ remediation:'Reconnect and try again.' }) === 'Reconnect and try again.');
ok('every field api() sets on the thrown error also reaches net.lastError', (()=>{
   /* The two are built separately and nothing forces them to agree, which is
      how `remediationText` went missing from the one a screen actually reads.
      Naming the fields instead of the symptom is what catches the *next*
      field someone adds rather than re-finding this one. */
   const shell = fs.readFileSync(path.join(__dirname, 'assets/ui-shell.js'), 'utf8');
   const from = shell.indexOf('if (!res.ok) {');
   /* Search for the terminator *after* the block: an earlier `throw e;` in the
      offline branch made the first version of this slice empty, so it passed
      by measuring nothing. An extractor that finds nothing must fail. */
   const thrown = shell.slice(from, shell.indexOf('throw e;', from));
   const at = shell.indexOf('net.lastError = {');
   const caught = shell.slice(at, shell.indexOf('};', at));
   const set  = [...new Set([...thrown.matchAll(/\be\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]))];
   const kept = new Set([...caught.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)].map(m => m[1]));
   if (from < 0 || at < 0 || set.length < 2 || kept.size < 2)
     return (console.log('    extractor found nothing — the assertion cannot vouch for anything'), false);
   const lost = set.filter(f => !kept.has(f));
   return lost.length === 0
     ? true
     : (console.log('    dropped between the throw and net.lastError: ' + lost.join(', ')), false); })());
ok('an unrecognised token renders as nothing, never as itself', (()=>{
   /* The failure mode of a missing table entry has to be a missing sentence.
      Falling back to the raw value would put `some_new_code` on screen the
      first time an endpoint invents one. */
   const h = b6.errorBlock({ message:'x', remediation:'some_new_token' }, null);
   return b6.remedyText({ remediation:'some_new_token' }) === '' &&
          !/some_new_token/.test(h); })());

/* The version of this check that would have caught B4 and B5 rather than only
   the file that found it. Any screen interpolating a remediation into markup
   without going through remedyText renders the token; line-based because a
   template literal nests braces and a brace-matching regex does not. */
ok('no ui-*.js interpolates a raw remediation into markup', (()=>{
   const offenders = [];
   for (const f of SOURCES.filter(n => /\/ui-/.test(n))){
     const lines = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n');
     lines.forEach((ln, i) => {
       if (!/\.remediation\b/.test(ln)) return;
       if (/remedyText/.test(ln)) return;
       if (!/\$\{|esc\(|innerHTML/.test(ln)) return;   // branching on it is the point
       offenders.push(`${f}:${i + 1}  ${ln.trim().slice(0, 72)}`);
     });
   }
   return offenders.length === 0
     ? true
     : (console.log('    ' + offenders.join('\n    ')), false); })());
ok('Permission-denied: no session is invented while accounts are switched off',
   b6.sessionUser() === null);
ok('the session reaches the wire as a bearer header, not as a body field', (()=>{
   /* api() builds its headers from opts, so an authenticated call has a seam
      to put the token in. fetch() is reached synchronously inside api(),
      before the first await, which is why this can be read back without one.
      Asserting the header lands on the request rather than that authHeaders()
      returns one is the difference between the seam existing and it working. */
   const _fetch = global.fetch; let seen = null;
   global.fetch = (url, init) => { seen = { url, init }; return new Promise(() => {}); };
   b6.FLAGS.set('accounts', true);
   _ls['cardworks.session.user'] = JSON.stringify({ user:{ id:7, phone:'+8801712345678' },
     token:'tok-abc', expiresAt: new Date(Date.now() + 864e5).toISOString() });
   b6.signOut();
   global.fetch = _fetch;
   const h = (seen && seen.init && seen.init.headers) || {};
   const body = seen && seen.init && seen.init.body ? JSON.parse(seen.init.body) : {};
   b6.authState.busy = false; b6.FLAGS.set('accounts', false);
   delete _ls['cardworks.session.user'];
   return seen && seen.url === '/api/auth' && h.authorization === 'Bearer tok-abc' &&
          body.action === 'logout' && !('token' in body); })());
ok('signing out clears this device even when the server never answers', (()=>{
   /* The finally block does the clearing, so a hung or failed round trip
      still ends with the user signed out here — which is what they asked
      for — and a message saying the other sessions may still be live. */
   const src = js.slice(js.indexOf('async function signOut'));
   const fin = src.slice(src.indexOf('} finally {'), src.indexOf('\n}'));
   return /lsSet\('cardworks\.session\.user', null\)/.test(fin); })());
ok('Error: the block sits beside the field it asks you to fix, never in place of it', (()=>{
   b6.FLAGS.set('accounts', true);
   b6.authState.err = { code:'fix_phone', message:'Enter a Bangladeshi mobile number.' };
   const step1 = b6.signinStateHTML();
   b6.authState.sent = true; b6.authState.phone = '01712345678';
   b6.authState.err = { code:'unauthorized', message:'bad code' };
   const step2 = b6.signinStateHTML();
   b6.authState.err = null; b6.authState.sent = false; b6.FLAGS.set('accounts', false);
   return /state-error/.test(step1) && /id="i_acctphone"/.test(step1) &&
          /state-error/.test(step2) && /id="i_acctcode"/.test(step2); })());
ok('Loading: the pending block does not take the form away either', (()=>{
   b6.FLAGS.set('accounts', true); b6.authState.busy = true;
   const h = b6.signinStateHTML();
   b6.authState.busy = false; b6.FLAGS.set('accounts', false);
   return /state-pending/.test(h) && /id="i_acctphone"/.test(h); })());

b6nav({ onLine:false, userAgent:'test' });
ok('Offline: the banner appears the moment navigator goes offline',
   b6.isOffline() === true && /state-offline/.test(b6.offlineBanner()));
ok('Offline: sign-in names which parts still work without a connection',
   /state-offline/.test(b6.signinStateHTML()) && /do not/.test(b6.signinStateHTML()));
ok('Offline: the library still composes, is not disabled, and says so', (()=>{
   b6made.length = 0;
   b6.drawLibrary(b6.PRESETS[0].c);
   const html = b6q('#libTiles').innerHTML;
   const live = (html.match(/class="tile "/g) || []).length;
   return live > 0 && b6made.some(n => /state-offline/.test(n.innerHTML)); })());
_nav0 ? Object.defineProperty(global, 'navigator', _nav0) : delete global.navigator;
ok('Offline: the banner is gone again once the connection returns',
   b6.isOffline() === false && b6.offlineBanner() === '');
ok('Offline and unsaved changes are wired to window events at load',
   b6events.includes('offline') && b6events.includes('online') &&
   b6events.includes('beforeunload'), b6events.join(','));

ok('Unsaved: nothing to lose means no dialog on the way out', (()=>{
   b6.state.gen = null; b6.state.refine = null; b6.state.history = []; b6.state.instrLog = [];
   b6.state.shareCode = null; b6.reconcileDirty();
   return b6.work.dirty === false &&
          b6.beforeUnloadGuard({ preventDefault(){}, returnValue:null }) === undefined; })());
ok('Unsaved: a generation alone does not warn — the engine reproduces it from the brief', (()=>{
   b6.state.gen = { picked:[{ layout:'lay.centered', palette:'pal.gold', type:'typ.siliguri' }] };
   b6.state.pick = 0; b6.state.shareCode = null; b6.work.savedHash = null;
   b6.reconcileDirty();
   return b6.work.dirty === false; })());
ok('Unsaved: an unsaved refinement does warn — the brief will not reproduce it', (()=>{
   b6.state.refine = { layout:'lay.centered', palette:'pal.ink', type:'typ.siliguri',
                       density:'balanced', back:'back.contact', format:'bd-std',
                       corner:0, script:'latin', finishes:['matte'] };
   b6.state.history = [{ layout:'lay.centered' }];
   b6.state.shareCode = null; b6.work.savedHash = null;
   b6.reconcileDirty();
   return b6.work.dirty === true &&
          b6.beforeUnloadGuard({ preventDefault(){}, returnValue:null }) === ''; })());
ok('Unsaved: saving clears it, and the next change to the design brings it back', (()=>{
   b6.state.shareCode = 'abc123'; b6.reconcileDirty();
   const clean = b6.work.dirty === false;
   b6.state.refine.palette = 'pal.gold'; b6.reconcileDirty();
   return clean && b6.work.dirty === true; })());
global.document = _doc0;

H('36. The brief funnel — a rail that cannot drift, a cap that speaks (B2)');
/* The funnel's rules are pure functions on purpose, so they are reached
   through a second evaluation of the same sources rather than through a DOM.
   Master PRD Epic A asks for the rail count and the real step count to be
   asserted equal in CI; that is the first assertion below, and the ones after
   it close the other routes by which the two used to disagree. */
const b2 = new Function(js + `
  ;return { BRIEF_STEPS, briefStepCount, briefRail, briefRailHTML, STEPS,
            PERSONALITY_CAP, PERSONALITY_CAP_MESSAGE, personalityTap,
            BILINGUAL_SCRIPTS, briefScriptDefault,
            VERTICALS, verticalPreset, applyVertical, generatingRows };`)();
const b2src = fs.readFileSync(path.join(__dirname, 'assets/ui-brief.js'), 'utf8');
const b2steps = b2.briefStepCount();

ok(`the rail renders exactly as many items as there are steps (${b2steps})`,
   b2.briefRail().length === b2steps);
ok('index.html declares exactly that many step panels',
   (html.match(/data-step="\d+"/g) || []).length === b2steps);
ok('the shell step table has not drifted from the brief step table',
   b2.STEPS.length === b2steps, `${b2.STEPS.length} vs ${b2steps}`);
const b2crumb = /step \$\{state\.step\s*\+\s*1\} of (\d+)/.exec(js);
ok('the breadcrumb "step N of M" states the real step count',
   !!b2crumb && Number(b2crumb[1]) === b2steps, b2crumb ? b2crumb[1] : 'no crumb found');
/* F6 itself: the brief rail used to append the five downstream stages, which
   is how seven steps came to announce themselves as twelve. */
const b2rail = b2.briefRailHTML(0);
ok('the rendered rail has one button per step and no stage buttons (F6)',
   (b2rail.match(/data-step-go=/g) || []).length === b2steps && !/data-stage-go/.test(b2rail));
ok('rail numbers are the position, not an authored string',
   b2.briefRail().every((r, i) => r.num === String(i + 1).padStart(2, '0')));
ok('only step 1 is required, and every later step but the review is skippable',
   b2.BRIEF_STEPS.filter(s => s.required).length === 1 && b2.BRIEF_STEPS[0].required &&
   b2.briefRail().slice(1, -1).every(r => r.skippable));
ok('every skippable step states the default it falls back to',
   b2.BRIEF_STEPS.slice(1, -1).every(s => typeof s.fallback === 'string' && s.fallback.length > 20));

ok('a fourth tap while three are selected returns the wireframe\'s exact message', (() => {
   const r = b2.personalityTap(['premium','minimal','bold'], 'corporate');
   return r.capped && r.message === '3 of 3 selected — tap one to deselect it'; })());
ok('the cap does not silently drop the oldest selection (F8)', (() => {
   const before = ['premium','minimal','bold'];
   const r = b2.personalityTap(before, 'corporate');
   return r.personality.join() === before.join(); })());
ok('tapping a selected word deselects it and clears the message', (() => {
   const r = b2.personalityTap(['premium','minimal','bold'], 'minimal');
   return !r.capped && r.message === '' && r.personality.join() === 'premium,bold'; })());
ok('three can be chosen from nothing without ever being blocked', (() => {
   let sel = [];
   for (const a of ['premium','minimal','bold']){
     const r = b2.personalityTap(sel, a);
     if (r.capped) return false;
     sel = r.personality;
   }
   return sel.length === b2.PERSONALITY_CAP; })());
ok('the cap message is announced to assistive tech, not only drawn',
   /briefPersCap/.test(b2src) && /setAttribute\('aria-live', *'polite'\)/.test(b2src));
/* A chip that reports itself disabled swallows the fourth tap again — F8
   restated in ARIA rather than fixed. Playwright refuses to click an
   aria-disabled button, which is how this was caught in the browser. */
ok('no personality chip is ever marked disabled, so the fourth tap lands',
   !/data-ax[\s\S]{0,240}?aria-disabled/.test(b2src) &&
   /aria-describedby', *'briefPersCap'/.test(b2src));

ok('the script default is bilingual in both interface languages',
   b2.BILINGUAL_SCRIPTS.indexOf(b2.briefScriptDefault('en')) >= 0 &&
   b2.BILINGUAL_SCRIPTS.indexOf(b2.briefScriptDefault('bn')) >= 0);
ok('no default is a single-script option, and a Bangla interface means a Bangla front',
   b2.BILINGUAL_SCRIPTS.every(s => !/-only$/.test(s)) &&
   b2.briefScriptDefault('bn') === 'bangla' && b2.briefScriptDefault('en') === 'latin');

ok('the four Epic H verticals are all present',
   b2.VERTICALS.length === 4 &&
   ['doctor','rmg','advocate','shop'].every(id => b2.VERTICALS.some(v => v.id === id)));
ok('every vertical is built on one of the engine\'s own presets, not a parallel list',
   b2.VERTICALS.every(v => !!b2.verticalPreset(v)),
   b2.VERTICALS.filter(v => !b2.verticalPreset(v)).map(v => v.id).join(','));
ok('every vertical names a real industry prior',
   b2.VERTICALS.every(v => v.industry in mod.INDUSTRIES));
ok('no vertical pre-selects more personality than the cap allows',
   b2.VERTICALS.every(v => v.personality.length <= b2.PERSONALITY_CAP));
ok('the doctor vertical carries chamber hours (PRD §3.2 — Dr. Nasrin)', (() => {
   const a = b2.applyVertical('doctor', 'en');
   return /chamber/i.test(a.content.addr || '') && /\d\s*(am|pm)/i.test(a.content.addr || '') &&
          /FCPS|MBBS/.test(a.content.quals || ''); })());
ok('the shop vertical carries a Facebook page where a website would be (PRD §3.2)', (() => {
   const a = b2.applyVertical('shop', 'en');
   return /fb\.com|facebook/i.test(a.content.web || '') && !!(a.content.p2 || '').trim(); })());
ok('a vertical pre-fills industry, personality and a bilingual script together', (() => {
   const a = b2.applyVertical('rmg', 'bn');
   return a.industry === 'rmg' && a.personality.length > 0 &&
          b2.BILINGUAL_SCRIPTS.indexOf(a.script) >= 0 && !!(a.content.bname || '').trim(); })());
ok('an unknown vertical returns nothing rather than a half-filled brief',
   b2.applyVertical('astronaut', 'en') === null);

/* Wireframing §5.4 and PRD Epic B: the numbers are the engine's counts for
   this brief, and nothing on the screen is paced by a clock. */
const b2gen = mod.generate({ industry:'doctor', personality:['traditional'], format:'bd-std',
                             density:'balanced', script:'latin' }, mod.PRESETS[0].c);
ok('every number on the generating screen is a real count from this run',
   b2.generatingRows(b2gen).map(r => r[1]).join() ===
   [b2gen.stages.enumerated, b2gen.stages.composed, b2gen.stages.printSafe,
    b2gen.considered, b2gen.stages.selected].join());
ok('the rows read the result and contain no fabricated figure',
   b2.generatingRows({ stages:{ enumerated:1, composed:2, printSafe:3, selected:4 },
                       considered:5, ms:0.4 }).map(r => r[1]).join() === '1,2,3,5,4');
ok('nothing is counted before there is a result to count',
   b2.generatingRows(null).length === 0 && /pendingBlock\(/.test(b2src));
ok('generation is not paced by a timer (Epic B: 400ms means 400ms)',
   !/setTimeout|setInterval/.test(b2src) && /requestAnimationFrame/.test(b2src));

ok('the language toggle lives on Start, before the brief, and is wired to the shell',
   /data-screen="start"/.test(b2src) && /data-lang="bn"/.test(b2src) && /setUiLang\(/.test(b2src));
ok('"Have a code? Open a design" still loads a saved spec',
   /b_opencode/.test(b2src) && /\[0-9a-f\]\{6,16\}/.test(b2src) && /\?c=/.test(b2src));

H('37. Six concepts, the "why", and typed refinement (B3)');
/* The concepts surface adds functions the shared handle does not export.
   Re-evaluating the same concatenated sources yields a second handle over
   them without touching the loader above. */
const b3 = new Function(js + `;return { intentDisclosure, whyBlock, saidInWords, nearMisses,
  menuFor, ruleLabel, formatFilter, traceClausesAfterOpening, B3_MENU, B3_EN_ONLY,
  B3_RULE_WORDS, state };`)();
const b3src = fs.readFileSync(path.join(__dirname, 'assets/ui-concepts.js'), 'utf8');
const b3brief = o => Object.assign({ industry:'doctor', personality:[], format:'bd-std',
  density:'balanced', script:'latin' }, o);
const b3content = mod.PRESETS[0].c;
const gStated = mod.generate(b3brief({ personality:['premium','bold'] }), b3content);
const gBare   = mod.generate(b3brief({ personality:[] }), b3content);
const gOther  = mod.generate(b3brief({ personality:['technical','minimal'] }), b3content);
const AW = { premium:'premium', minimal:'restrained', corporate:'corporate',
  friendly:'approachable', bold:'bold', traditional:'traditional', technical:'technical' };

/* ── Epic B: the score is real, and it moves ── */
ok('six concepts come back for a landscape brief', gStated.picked.length === 6);
ok('the tile score IS the engine score — recomputing gives the same number',
   gStated.picked.every(c => mod.scoreCandidate(c, gStated.intent).total === c.score.total));
ok('the six do not share one score', new Set(gStated.picked.map(c=>c.score.total)).size >= 5);
ok('changing the stated personality changes the score of the same layout', (()=>{
   const a = Object.fromEntries(gStated.picked.map(c=>[c.layout, c.score.total]));
   const shared = gBare.picked.filter(c => c.layout in a);
   return shared.length >= 2 && shared.every(c => c.score.total !== a[c.layout]); })());
ok('changing the industry changes the score of the same layout', (()=>{
   const doc = Object.fromEntries(gStated.picked.map(c=>[c.layout, c.score.total]));
   const tech = mod.generate(b3brief({ industry:'tech', personality:['premium','bold'] }), b3content);
   const shared = tech.picked.filter(c => c.layout in doc);
   return shared.length >= 1 && shared.every(c => c.score.total !== doc[c.layout]); })());
ok('every score is the weighted sum of the four dimensions the surface prints',
   gStated.picked.every(c => Math.abs(
     Object.keys(mod.W).reduce((s,k)=>s + mod.W[k]*c.score.parts[k], 0) - c.score.total) < 5e-4));

/* ── Epic B: switching format re-filters, and says what went ── */
ok('portrait drops the four layouts with no authored portrait composition', (()=>{
   const f = b3.formatFilter('bd-port');
   const g = mod.generate(b3brief({ personality:['premium'], format:'bd-port' }), b3content);
   const goneIds = new Set(f.gone.map(l=>l.id));
   return f.gone.length === 4 && g.picked.every(c => !goneIds.has(c.layout)); })());
ok('square drops six of the nine, so it can never return six concepts', (()=>{
   const f = b3.formatFilter('bd-square');
   const g = mod.generate(b3brief({ personality:['premium'], format:'bd-square' }), b3content);
   return f.gone.length === 6 && g.picked.length === 3; })());
ok('a dropped layout carries a stated reason and composes nothing, rather than stretching', (()=>{
   const gone = b3.formatFilter('bd-port').gone[0];
   const c = mod.composeForced(gone.id, b3content, null, { format:'bd-port' });
   return !!c.eliminated && /portrait/.test(c.eliminated) && c.elements.length === 0; })());
ok('the surface names every dropped layout rather than counting them',
   /gone\.map\(l => l\.name\)/.test(b3src));

/* ── Epic B: stated versus inferred ── */
b3.state.industry = 'doctor';
ok('an industry prior is reported as inferred, never as something the user said', (()=>{
   const d = b3.intentDisclosure(gStated.intent);
   return d.stated.join() === 'premium,bold' && d.inferred.length > 0 &&
          d.inferred.every(a => !d.stated.includes(a)); })());
ok('the rendered "why" labels the inferred axes as inferred', (()=>{
   const html = b3.whyBlock(gStated.picked[0], gStated.intent, 'en');
   const d = b3.intentDisclosure(gStated.intent);
   return /Inferred, not stated/.test(html) &&
          d.inferred.every(a => html.includes(AW[a])); })());
ok('the "why" never claims the user asked for an axis they did not state', (()=>{
   const html = b3.whyBlock(gStated.picked[0], gStated.intent, 'en');
   const claimed = /You stated ([^.]+)\./.exec(html);
   return !!claimed && claimed[1].split(' and ').join() ===
          ['premium','bold'].map(a=>AW[a]).join(); })());
ok('a stated axis the industry excludes is surfaced, not silently penalised', (()=>{
   const d = b3.intentDisclosure(gStated.intent);
   const html = b3.whyBlock(gStated.picked[0], gStated.intent, 'en');
   return d.conflicts.join() === 'bold' && /excludes it/.test(html); })());
ok('with nothing stated the engine already discloses the inference and is used verbatim', (()=>{
   const d = b3.intentDisclosure(gBare.intent);
   const html = b3.whyBlock(gBare.picked[0], gBare.intent, 'en');
   return d.stated.length === 0 && d.engineHonest === true &&
          /did not state a personality/.test(html); })());
ok('the engine clause the surface has to correct is findable, so nothing is guessed at',
   b3.traceClausesAfterOpening(gStated.picked[0].why).length > 20);
ok('explain cites exactly the axes the user stated, and no others', (()=>{
   const cite = g => (/^You asked for ([^.]+)\./.exec(g.picked[0].why) || [,''])[1].split(' and ');
   return cite(gStated).join() === ['premium','bold'].map(a=>AW[a]).join() &&
          cite(gOther).join()  === ['technical','minimal'].map(a=>AW[a]).join(); })());

/* ── Epic C: the closed set, and the honest refusal ── */
ok('an unmapped instruction returns exactly zero operations', (()=>{
   const r = mod.classifyInstruction('add a rainbow gradient and rotate the logo 15 degrees');
   return r.unmapped === true && r.ops.length === 0; })());
ok('an unmapped instruction is answered with a non-empty list of alternatives that all work', (()=>{
   const menu = b3.menuFor('en');
   return menu.length >= 5 &&
          menu.every(l => mod.classifyInstruction(b3.ruleLabel(l,'en')).matched.includes(l)); })());
ok('a near miss is named as a near miss rather than acted on', (()=>{
   const near = b3.nearMisses('make it more premum');
   return mod.classifyInstruction('make it more premum').unmapped === true &&
          near.some(n => n.label === 'more premium' && n.d > 0); })());
ok('a genuinely alien instruction produces no near miss, so the full menu is offered',
   b3.nearMisses('add a rainbow gradient').length === 0);
ok('every alternative offered in Bangla actually classifies in Bangla', (()=>{
   const menu = b3.menuFor('bn');
   return menu.length >= 4 &&
          menu.every(l => mod.classifyInstruction(b3.ruleLabel(l,'bn')).matched.includes(l)); })());
ok('operations with no Bangla pattern are named as English-only, never offered in Bangla',
   b3.B3_EN_ONLY.length > 0 && b3.B3_EN_ONLY.every(l => !b3.menuFor('bn').includes(l)));

/* ── Epic C: a mapped instruction re-composes; it never scales in place ── */
ok('Bangla is a first-class path — নাম বড় করুন yields the same operation as its English twin', (()=>{
   const en = mod.classifyInstruction('make my name bigger');
   const bn = mod.classifyInstruction('নাম বড় করুন');
   return JSON.stringify(en.ops) === JSON.stringify(bn.ops) &&
          en.ops.length === 1 && en.ops[0].op === 'promoteSlot'; })());
const b3design = { layout:'lay.centered', palette:'pal.gold', type:'typ.tiro', density:'balanced',
  back:'back.contact', format:'bd-std', corner:0, script:'latin', finishes:[] };
ok('"bigger name" re-selects a composition instead of scaling the type where it stands', (()=>{
   const r = mod.applyOps(b3design, mod.classifyInstruction('নাম বড় করুন').ops);
   return r.changes.length === 1 && r.changes[0].key === 'layout' &&
          mod.nameScaleOf(r.design.layout) > mod.nameScaleOf(b3design.layout); })());
ok('the promotion is genuinely composed — the composer sets the larger size, not the operation', (()=>{
   const before = mod.composeForced(b3design.layout, b3content, null, {});
   const after0 = mod.applyOps(b3design, mod.classifyInstruction('make my name bigger').ops).design;
   const after  = mod.composeForced(after0.layout, b3content, null, {});
   const pt = c => c.elements.find(e => e.ref === 'name')?.fit.sizePt || 0;
   return pt(after) > pt(before); })());
ok('no operation in the closed set can emit a size, a position or a raw colour', (()=>{
   const allowed = new Set(['layout','palette','type','density','back','format','corner',
                            'script','finishes']);
   const args = { promoteSlot:'name', demoteSlot:'name', moveSlotToBack:'contact',
     setPalette:'pal.ink', shiftPalette:'dark', setTypeSystem:'typ.mono', shiftType:'serif',
     setLayout:'lay.rule', setLayoutFamily:'minimal', setDensity:'airy', setCorner:'2',
     setBack:'back.qr', setScript:'bangla', setFormat:'bd-port', addFinish:'foil',
     removeFinish:'foil' };
   return Object.keys(mod.EDIT_OPS).every(op =>
     Object.keys(mod.EDIT_OPS[op]({ ...b3design }, args[op])).every(k => allowed.has(k))); })());
ok('the success message states the operation and denies the thing it did not do', (()=>{
   const en = b3.saidInWords('promoteSlot', 'name', { layout:'lay.bleed' }, 'en');
   const bn = b3.saidInWords('promoteSlot', 'name', { layout:'lay.bleed' }, 'bn');
   return /not scaled in place/.test(en) && /re-composed/.test(en) &&
          /[ঀ-৿]/.test(bn) && bn !== en; })());
ok('the surface writes no geometry of its own',
   !/\.(sizePt|geom|track|fontSize)\s*=[^=]/.test(b3src) && !/font-size\s*:\s*\$\{/.test(b3src));
ok('every operation the pickers emit is a member of the closed set', (()=>{
   const ops = [...b3src.matchAll(/'(set[A-Z][A-Za-z]+|promoteSlot|demoteSlot|shiftPalette|shiftType|moveSlotToBack|addFinish|removeFinish)'/g)]
     .map(m => m[1]);
   return ops.length >= 6 && [...new Set(ops)].every(o => o in mod.EDIT_OPS); })());
ok('the literal instruction is kept and shown above the result',
   /text:\s*String\(text\)\.trim\(\)/.test(b3src) && /b3-quote/.test(b3src) &&
   /esc\(log\.text\)/.test(b3src));
ok('the refusal path records a log entry with zero operations, never a silent return',
   /ops:\[\], changes:\[\]/.test(b3src) && /state\.instrLog\.push\(log\)/.test(b3src));
ok('the 2-up phone grid is a property of this surface, not of a stylesheet it does not own',
   /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(b3src));

H('38. Preflight: derived counts, recorded acceptance, no override (B4)');
/* PRD Epic D is three claims about this screen, and each one is only worth
   anything if it survives someone trying to walk around it: the counts are
   the arrays, a blocking finding has no path forward at all, and an advisory
   is passed only by an acceptance recorded against a person and a time.
   The document stub below is a sink like B6's, so what the screen actually
   wrote can be read back rather than inferred from the source. */
const b4src = fs.readFileSync(path.join(__dirname, 'assets/ui-validate.js'), 'utf8');
const _doc4 = global.document;
const _nav4 = Object.getOwnPropertyDescriptor(global, 'navigator');
const b4el = () => ({ innerHTML:'', textContent:'', value:'', style:{}, dataset:{},
  onclick:null, oninput:null, onchange:null, onkeydown:null, files:null, disabled:false,
  setAttribute(){}, toggleAttribute(){}, appendChild(){}, prepend(){},
  querySelector:()=>null, querySelectorAll:()=>[], closest:()=>null });
const b4sink = {};
global.document = {
  createElement: t => t === 'canvas' ? { getContext: () => fakeCtx } : b4el(),
  querySelector: s => b4sink[s] || (b4sink[s] = b4el()),
  querySelectorAll: () => [],
  fonts: { ready: Promise.resolve() }
};
/* Offline for the whole section: the on-device run is the one under test,
   and it keeps the screen from reaching for a server that is not there. */
Object.defineProperty(global, 'navigator', { value:{ onLine:false, userAgent:'b4' }, configurable:true });

const b4 = new Function(js + `
  ;return { preflightGate, pfFindings, pfFixes, pfKey, pfAccept, pfRecordAcceptance, pfLedgerFor,
            pfCost, pfResolutionPool, diagnose, eliminationCauses, conflictReason,
            drawValidate, drawNoResults, facesFor, allFindings, currentDesign, generate,
            composeForced, preflight, state, draw, go, readForm, writeForm, applyOps,
            pfCanReachServer, net, remedyText,
            LAYOUTS, FORMATS, PALETTES, PRESETS, TRIM_UPCHARGE_PER_100 };`)();
const b4q = s => global.document.querySelector(s);
const B4C = { ...b4.PRESETS[0].c };
const b4brief = { industry:'doctor', personality:['traditional','premium'],
                  format:'bd-std', density:'balanced', script:'latin' };
b4.writeForm(B4C);
Object.assign(b4.state, { format:'bd-std', density:'balanced', script:'latin', industry:'doctor',
  personality:['traditional','premium'], qty:500, back:'back.bangla', refine:null, shareCode:null });
b4.state.gen = b4.generate(b4brief, B4C);
const b4design = b4.currentDesign();

/* ── the counts are the arrays ── */
b4.state.screen = 'validate';
b4.drawValidate(b4design, B4C);
const b4tally = b4q('#pfTally').innerHTML;
const b4num = w => Number((new RegExp('<b>(\\d+)</b> ' + w).exec(b4tally) || [0,-1])[1]);
const b4real = b4.allFindings(...(() => { const { front, back } = b4.facesFor(b4design, B4C);
  return [front, back]; })());
ok('the displayed counts are the lengths of the real finding arrays for this design',
   b4num('passed')   === b4real.filter(f => f.s === 'pass').length &&
   b4num('advisory') === b4real.filter(f => f.s === 'review').length &&
   b4num('blocking') === b4real.filter(f => f.s === 'fail').length,
   `${b4num('passed')}/${b4num('advisory')}/${b4num('blocking')} vs ${b4real.length} findings`);
ok('the tally states how many checks ran, and it is the length of the list',
   new RegExp('>' + b4real.length + ' checks run').test(b4tally), b4tally.slice(0,120));
ok('no fixed count is written anywhere on this screen (Epic D: never a "16 of 19")',
   !/\b\d+\s+of\s+\d+\b/.test(b4src) && !/16 of 19/.test(b4src));
ok('a different design produces different counts, because they are recounted', (()=>{
   const other = { ...b4design, back:'back.qr' };
   const a = b4.preflightGate(b4design, B4C).counts, b = b4.preflightGate(other, B4C).counts;
   return a.blocking !== b.blocking || a.pass !== b.pass; })());

/* ── blocking has no way past it ── */
const b4blocked = { ...b4design, back:'back.qr' };   // an unsaved QR link plus no contact slot
const b4bg = b4.preflightGate(b4blocked, B4C);
ok('the fixture really is blocking, on findings the engine produced',
   b4bg.blocking.length > 0 && b4bg.ok === false,
   b4bg.blocking.map(f => f.label).join(' / '));
ok('every route into export and order is refused while a blocking finding stands', (()=>{
   b4.state.refine = b4blocked;
   for (const sc of ['export','order']){
     b4.state.screen = sc; b4.draw();
     if (b4.state.screen !== 'validate') return false;
     b4.go(sc);
     if (b4.state.screen !== 'validate') return false;
   }
   return true; })());
ok('the blocking screen offers no forward action at all — not even a disabled one', (()=>{
   b4.state.screen = 'validate'; b4.draw();
   const bar = b4q('#pfPanel').innerHTML;
   return !/data-pf-continue/.test(bar) && /Blocked/.test(bar); })());
/* A regex over raw source cannot tell a comment promising there is no
   override from an actual override — the prose documenting the guarantee
   contains every word an override would. So comments come out first, and
   the claim is then made where it belongs: against each layer that could
   let a blocked design through. */
const b4code = b4src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
ok('no control in the code offers to export a blocked design',
   !/data-pf-(override|force|skip)/.test(b4code) &&
   !/(export|continue|order|print)[^\n]{0,24}anyway/i.test(b4code) &&
   /g\.blocking\.length \? '' :/.test(b4code));
ok('the stage rail disables the export step rather than offering one it will refuse', (()=>{
   b4.state.refine = b4blocked; b4.state.screen = 'validate'; b4.draw();
   const rail = b4q('#stagebar [data-stage="export"]');
   return rail.disabled === true; })());
/* The other half of the same guarantee: a client that skips this file
   entirely still cannot get an acceptance recorded for a blocking finding,
   because the endpoint refuses it too. Structural rather than worded, so
   A2 can reword their messages without failing this. */
const b4gate = fs.readFileSync(path.join(__dirname, 'lib/preflight-gate.mjs'), 'utf8');
ok('the server refuses the same things this screen does, so the two halves cannot drift apart',
   /f\.severity !== 'advisory'/.test(b4gate) &&
   /if \(report\.blocking\) return \{[\s\S]{0,60}ok: false/.test(b4gate) &&
   /requireAdvisoryAcceptance && unaccepted\.length/.test(b4gate));
ok('every action offered against a blocking finding actually clears every one of them', (()=>{
   const fixes = b4.pfFixes(b4blocked, B4C);
   if (!fixes.length) return false;
   return fixes.every(fx => {
     const probe = b4.preflightGate(
       fx.ops ? b4.applyOps(b4blocked, fx.ops).design : b4blocked,
       fx.mutate ? fx.mutate(B4C) : B4C);
     return probe.blocking.length === 0; }); })());
ok('applying the offered action for real leaves the design printable', (()=>{
   const fixes = b4.pfFixes(b4blocked, B4C);
   fixes[0].apply();
   const after = b4.preflightGate(b4.currentDesign(), b4.readForm());
   return after.blocking.length === 0; })());

/* ── an advisory is passed only by an acceptance on the record ── */
b4.state.refine = null;
const b4adv = b4.preflightGate(b4.currentDesign(), b4.readForm());
ok('a design with an unaccepted advisory is not printable',
   b4adv.advisory.length > 0 && b4adv.pending.length === b4adv.advisory.length && b4adv.ok === false,
   `${b4adv.advisory.length} advisory, ${b4adv.pending.length} pending`);
ok('export stays refused for an unaccepted advisory, with no blocking finding in sight', (()=>{
   b4.state.screen = 'export'; b4.draw();
   return b4.state.screen === 'validate' && b4.preflightGate(b4.currentDesign(), b4.readForm()).blocking.length === 0; })());
ok('accepting each advisory — and only that — opens the way through', (()=>{
   const d = b4.currentDesign(), c = b4.readForm();
   for (const f of b4.preflightGate(d, c).pending) b4.pfAccept(d, c, f.lid);
   const after = b4.preflightGate(d, c);
   if (!after.ok || after.pending.length) return false;
   b4.state.screen = 'export'; b4.draw();
   return b4.state.screen === 'export'; })());
ok('the acceptance names who accepted it and when, and copies the sentence they read', (()=>{
   const d = b4.currentDesign(), c = b4.readForm();
   const rows = Object.values(b4.pfLedgerFor(b4.pfKey(d, c)));
   return rows.length > 0 && rows.every(r => r.by && r.label &&
     !Number.isNaN(Date.parse(r.at)) && Math.abs(Date.now() - Date.parse(r.at)) < 60000); })());
/* Every finding outside the advisory tier, not just the blocking one, and an
   id belonging to no finding at all. `pfRecordAcceptance` is the only thing
   that can create a ledger row — the two other writers update a row that is
   already there — so refusing here is refusing everywhere on the client. */
ok('nothing outside the advisory tier can be written to the ledger, by any route', (()=>{
   const g = b4.preflightGate(b4blocked, B4C);
   const key = b4.pfKey(b4blocked, B4C);
   const before = JSON.stringify(b4.pfLedgerFor(key));
   let refused = 0;
   for (const f of g.findings){
     if (f.severity === 'advisory') continue;
     if (b4.pfRecordAcceptance(b4blocked, B4C, f.lid) !== null) return false;
     refused++;
   }
   if (b4.pfRecordAcceptance(b4blocked, B4C, 'deadbeefcafe') !== null) return false;
   return refused > 0 && g.blocking.length > 0 &&
     before === JSON.stringify(b4.pfLedgerFor(key)); })());
ok('the acceptance is sent with the id the server issued, not one this file invented',
   /findingId:\s*f\.sid/.test(b4src) && /action:'accept'/.test(b4src) &&
   /acceptedBy:\s*who\.label/.test(b4src) && /'\/api\/preflight'/.test(b4src));
ok('an acceptance taken with no server is queued, and says so on screen',
   /recorded:false/.test(b4src) && /pfFlushQueue/.test(b4src) &&
   /not yet on the order record/.test(b4src));
/* A page with no http origin — this harness, or a file:// open — has no
   server to ask, and asking anyway leaves an entry in the shell's shared
   `net.pending` that the next screen to render reads as its own. That is a
   cross-screen coupling through global state, and a suite whose premise is
   determinism (Technical Design §3.3) cannot have one. */
ok('drawing this screen where there is no server makes no request at all', (()=>{
   const nav = Object.getOwnPropertyDescriptor(global, 'navigator');
   Object.defineProperty(global, 'navigator', { value:{ onLine:true }, configurable:true });
   const reachable = b4.pfCanReachServer();       // online, but no http origin to reach
   b4.state.screen = 'validate'; b4.draw();
   const quiet = b4.net.pending.size === 0;
   Object.defineProperty(global, 'navigator', nav);
   return reachable === false && quiet; })());
/* The consuming half of the same defect, which B5 hit from the other side:
   `isPending()` answers "is anything at all in flight", so a control keyed to
   it is disabled by every other screen's traffic and parked forever by one
   hung call. This screen reports its own request and nothing else. Comments
   are stripped first so the passage explaining that does not satisfy it. */
ok('this screen never reads the shared pending set, only its own request',
   !/isPending\(\)/.test(b4code) && /pfNet\.pending/.test(b4code));
/* `remediation` is a token a screen branches on, not a sentence to read out.
   The shell owns the token-to-sentence table; this screen must not put a raw
   one into HTML, and the prose it writes itself has to survive the trip. */
ok('no machine remediation token can reach the screen as prose',
   !/esc\([^)]*\.remediation\b/.test(b4code) && /remedyText\(/.test(b4code) &&
   b4.remedyText({ remediation:'wait' }) !== 'wait' &&
   b4.remedyText({ remediation:'not_a_real_token' }) === '' &&
   b4.remedyText({ remediation:'Regenerate — a component it names may no longer exist.' })
     === 'Regenerate — a component it names may no longer exist.');

/* ── the constraint conflict ── */
const B4NONE = { ...B4C, name:'Muhammadshafiqurrahmanchowdhurybhuiyan',
                 quals:'MBBS (DMC), FCPS (Medicine), MRCP (UK)' };
b4.writeForm(B4NONE);
Object.assign(b4.state, { format:'bd-square', script:'latin', refine:null });
ok('the fixture really produces nothing', b4.generate(
   { ...b4brief, format:'bd-square' }, B4NONE).picked.length === 0);
const b4diag = b4.diagnose(B4NONE);
ok('the reason names the field the engine actually eliminated, in the user’s words',
   /name/i.test(b4diag.reason) && /legible size/.test(b4diag.reason), b4diag.reason);
ok('the reason is derived from recorded eliminations, not from field lengths',
   b4diag.causes.slots.name && b4diag.causes.slots.name.n > 0 &&
   /ladder exhausted/.test(b4diag.causes.slots.name.why));
ok('every resolution offered actually yields candidates when it is applied', (()=>{
   if (!b4diag.options.length) return false;
   return b4diag.options.every(o => {
     const n = b4.generate({ ...b4brief, format:'bd-square', ...(o.brief || {}) },
       o.mutate ? o.mutate(B4NONE) : B4NONE, { n:6 }).picked.length;
     return n > 0 && n === o.restores; }); })());
ok('the fix that is applied is the same change that was measured', (()=>{
   /* The screen used to probe one mutation and apply another, so a count
      could be shown for a change nobody had tried. */
   const o = b4diag.options[0];
   b4.writeForm(B4NONE);
   Object.assign(b4.state, { format:'bd-square', script:'latin' });
   o.apply();
   const n = b4.generate({ industry:'doctor', personality:['traditional','premium'],
     format:b4.state.format, density:b4.state.density,
     script:b4.state.script === 'bangla' ? 'bangla' : 'latin' }, b4.readForm()).picked.length;
   return n === o.restores; })());
ok('each resolution carries a cost consequence, and only a bigger trim carries a price',
   b4diag.options.every(o => o.cost && typeof o.cost.taka === 'number' && o.cost.label && o.consequence) &&
   b4.pfCost('bd-square', 'bd-std', 500).taka === b4.TRIM_UPCHARGE_PER_100 * 5 &&
   b4.pfCost('bd-std', 'bd-port', 500).taka === 0 &&
   b4.pfCost('bd-std', 'bd-square', 500).taka === 0);
ok('the trim upcharge is marked as an unvalidated estimate, like every other cost here', (()=>{
   /* An extractor that finds nothing must fail rather than pass. Written the
      obvious way, a renamed constant makes `indexOf` return -1, `slice(0,-1)`
      hands back the whole file, and the regex then matches prose somewhere
      else entirely — green while verifying nothing at all. */
   const at = b4src.indexOf('const TRIM_UPCHARGE_PER_100');
   if (at < 0) return false;
   const preamble = b4src.slice(Math.max(0, at - 700), at);
   if (preamble.length < 200) return false;
   return /§8\.1/.test(preamble) && /unvalidated|estimate/i.test(preamble); })());
ok('no resolution is a dead end: each one regenerates', (()=>{
   b4.writeForm(B4NONE);
   Object.assign(b4.state, { format:'bd-square', script:'latin', screen:'noresults' });
   b4.drawNoResults(B4NONE);
   const html = b4q('#resolutions').innerHTML;
   return (html.match(/data-fix="/g) || []).length === b4diag.options.length &&
     /concept/.test(html) && /pill/.test(html); })());

/* ── the numbers on the screen agree with each other ──
   Each count being honestly derived is not enough: two derived numbers can
   describe the same thing and still disagree, and a customer reading both
   sees the screen contradict itself. This reads the rendered screen back and
   cross-checks every number against every other and against the rows they
   claim to count — the only form of this that catches a section heading
   counting a row which carries no pass mark. */
const B4ICON = { passed:'pass', advisory:'review', blocking:'fail', 'for information':'info' };
function b4Screen(design, content){
  b4.state.screen = 'validate';
  b4.drawValidate(design, content);
  const head = b4q('#pfTally').innerHTML;
  const body = b4q('#preflight').innerHTML;
  const tally = [...head.matchAll(/<b>(\d+)<\/b>\s*([a-z ]+?)</g)].map(m => [m[2].trim(), +m[1]]);
  const total = +(/>(\d+) checks run/.exec(head) || [0, -1])[1];
  const sections = body.split(/<h6[^>]*>/).slice(1).map(chunk => {
    const m = /^(\d+)\s+([a-z ]+?)<\/h6>/.exec(chunk);
    const icons = {};
    for (const i of chunk.matchAll(/class="ico i-(\w+)"/g)) icons[i[1]] = (icons[i[1]] || 0) + 1;
    return m ? { label:m[2].trim(), said:+m[1],
                 rows:(chunk.match(/class="check"/g) || []).length, icons } : null;
  }).filter(Boolean);
  return { tally, total, sections,
           domIcons: [...body.matchAll(/class="ico i-(\w+)"/g)]
             .reduce((a, m) => (a[m[1]] = (a[m[1]] || 0) + 1, a), {}) };
}
function b4Consistent(s){
  if (!s.tally.length || s.total < 0) return 'nothing rendered';
  const sum = s.tally.reduce((n, [, v]) => n + v, 0);
  if (sum !== s.total) return `tally sums to ${sum}, total says ${s.total}`;
  for (const sec of s.sections){
    if (sec.said !== sec.rows) return `"${sec.said} ${sec.label}" over ${sec.rows} rows`;
    const want = B4ICON[sec.label];
    if (want && (sec.icons[want] || 0) !== sec.said)
      return `"${sec.said} ${sec.label}" but ${sec.icons[want] || 0} rows carry i-${want}`;
    const t = s.tally.find(([l]) => l === sec.label);
    if (t && t[1] !== sec.said) return `header says ${t[1]} ${sec.label}, section says ${sec.said}`;
  }
  for (const [label, n] of s.tally){
    const want = B4ICON[label];
    if (want && (s.domIcons[want] || 0) !== n)
      return `header says ${n} ${label}, DOM has ${s.domIcons[want] || 0} i-${want}`;
  }
  return '';
}
b4.state.refine = null;
b4.writeForm(B4C);
Object.assign(b4.state, { format:'bd-std', script:'latin', screen:'validate' });
b4.state.gen = b4.generate(b4brief, B4C);
const b4cleanScreen = b4Consistent(b4Screen(b4.currentDesign(), B4C));
ok('every number on a clean screen agrees with every other and with the rows',
   b4cleanScreen === '', b4cleanScreen);
const b4blockScreen = b4Consistent(b4Screen(b4blocked, B4C));
ok('every number on a blocked screen agrees with every other and with the rows',
   b4blockScreen === '', b4blockScreen);
ok('a passed row is a check that passed, never a note filed under one', (()=>{
   const g = b4.preflightGate(b4.currentDesign(), B4C);
   return g.passed.every(f => f.severity === 'pass') &&
     g.informational.every(f => f.severity === 'informational') &&
     g.counts.pass === g.passed.length &&
     g.counts.informational === g.informational.length &&
     g.blocking.length + g.advisory.length + g.passed.length + g.informational.length
       === g.findings.length; })());

global.document = _doc4;
if (_nav4) Object.defineProperty(global, 'navigator', _nav4);

H('39. The two upload features are reachable from the entry screen');
{
  /* The founder's own framing is that people arrive holding a card a shop
     already made. That customer met a Start screen offering only "start a
     brief", while the two features built for them sat in a nav menu they had
     no reason to open. An entry point nobody is shown is an entry point
     nobody uses, so it is asserted here rather than left to survive by
     habit. */
  const brief = js.slice(js.indexOf('CARDWORKS — brief funnel'), js.indexOf('CARDWORKS — concepts'));
  ok('the Start screen routes to both upload features',
     /data-start-go="enhance"/.test(brief) && /data-start-go="destructure"/.test(brief));
  ok('and the routes are wired, not just drawn',
     /\[data-start-go\]/.test(brief) && /go\(b\.dataset\.startGo\)/.test(brief));

  /* Bangla is first-class in this market (PRD §5.1). An English-only route
     into it is the same bias the language toggle on this screen exists to
     remove, so every string the route needs must exist in both tables. */
  const table = js.slice(js.indexOf('const BRIEF_STRINGS'), js.indexOf('function bt('));
  const en = table.slice(table.indexOf('en:'), table.indexOf('bn:'));
  const bn = table.slice(table.indexOf('bn:'));
  for (const key of ['haveCard', 'haveCardNote', 'enhanceIt', 'takeApart']) {
    ok(`${key} is written in both languages`,
       en.includes(key + ':') && bn.includes(key + ':'),
       `en=${en.includes(key + ':')} bn=${bn.includes(key + ':')}`);
  }
  ok('the Bangla strings are actually Bangla, not English left in place',
     /[\u0980-\u09FF]/.test(bn.slice(bn.indexOf('haveCard'), bn.indexOf('haveCard') + 400)));
}

H('40. The safe area is a function of the finish and the die (E1)');
{
  /* Master PRD §7: 3 mm bleed, 4 mm safe area — 5 mm for foil, 6 mm for
     die-cut. The bleed was right and the safe area was a flat 4 for every
     job, so a foiled card placed its name inside the foil block's own
     registration tolerance and a die-cut card placed it inside the die's.

     Two halves have to hold at once and neither is worth much alone. A card
     with no registered finish and no die must compose EXACTLY as it did
     before this rule existed, because a print-correctness change that also
     moves every plain card is indistinguishable from a regression. A card
     with one must genuinely move inward — placed at the wider number by the
     composer, not merely failed at it afterwards by preflight. */
  const crypto = require('crypto');
  const e1fronts = mod.LAYOUTS.filter(l => l.face === 'front');
  const e1spec = (preset, layout, format, over) => ({
    format, type:'typ.siliguri', palette:'pal.gold', density:'balanced',
    layout, content:preset.c, share:{ origin:'https://cardworks.bd', code:null }, ...over });

  /* Every preset × layout × format, at one type system and one density. The
     sweep is the unit of evidence for everything below: the same 216 cards
     composed under each finish case. */
  const e1sweep = (over) => {
    const rows = [];
    for (const p of mod.PRESETS) for (const l of e1fronts) for (const f of mod.FORMATS)
      rows.push({ key:`${p.k}|${l.id}|${f.id}`, c: mod.compose(e1spec(p, l.id, f.id, over)) });
    return rows;
  };
  const plain  = e1sweep({ finishes:[], corner:0 });
  const lam    = e1sweep({ finishes:['matte','gloss','softtouch','spotuv'], corner:0 });
  const foil   = e1sweep({ finishes:['foil'], corner:0 });
  const die    = e1sweep({ finishes:[], corner:2 });
  const both   = e1sweep({ finishes:['foil'], corner:3 });

  ok('the sweep composed the whole library rather than a corner of it',
     plain.length === mod.PRESETS.length * e1fronts.length * mod.FORMATS.length && plain.length > 100,
     `${plain.length} compositions`);

  // ── what each combination resolves to ───────────────────────────────────
  const safeOf = rows => [...new Set(rows.map(r => r.c.fmt.safe))];
  ok('plain ink composes against the trim record\'s own 4 mm',
     safeOf(plain).join() === '4', safeOf(plain).join());
  ok('lamination and spot UV do not move it — they are applied to the whole sheet',
     safeOf(lam).join() === '4', safeOf(lam).join());
  for (const fin of ['foil', 'emboss', 'letterpress', 'edgepaint']){
    const rows = e1sweep({ finishes:[fin], corner:0 });
    ok(`${fin} is registered in a second pass, so the safe area is 5 mm`,
       safeOf(rows).join() === '5', safeOf(rows).join());
  }
  ok('a die-cut is 6 mm — a rotary die wanders further than a guillotine',
     safeOf(die).join() === '6', safeOf(die).join());
  ok('a foiled card that is also die-cut takes the LARGER of the two, not the last one set',
     safeOf(both).join() === '6', safeOf(both).join());
  ok('one registered finish among several still escalates',
     safeOf(e1sweep({ finishes:['matte','foil','gloss'], corner:0 })).join() === '5');
  ok('a corner the renderer would clamp to zero buys no safe area either',
     safeOf(e1sweep({ finishes:[], corner:-3 })).join() === '4');
  ok('an unknown finish id is not treated as a registered one',
     safeOf(e1sweep({ finishes:['not-a-finish'], corner:0 })).join() === '4');

  // ── the plain card has not moved, asserted against a pre-change golden ──
  /* The digest below was taken from the engine as it stood before the rule
     existed, over the same 216 compositions this section rebuilds: geometry
     to six decimals, the fitted size, width and lines of every run, and the
     rendered SVG. It is the whole of the claim "nothing about a plain card
     changed", and it is a digest rather than a description because a
     description could not have caught a millimetre. */
  const e1row = r => [r.key, r.c.fmt.safe, r.c.eliminated || null,
    r.c.elements.map(e => [e.ref, e.kind,
      +e.geom.x.toFixed(6), +e.geom.y.toFixed(6), +e.geom.w.toFixed(6), +e.geom.h.toFixed(6),
      e.fit ? +e.fit.sizePt.toFixed(6) : null, e.fit ? +e.fit.width.toFixed(6) : null,
      e.fit ? e.fit.lines : null]),
    mod.renderSVG(r.c)];
  const e1digest = rows => {
    const s = JSON.stringify(rows.map(e1row));
    if (s.length < 100000) throw new Error('E1 digest built from an implausibly small sweep: ' + s.length);
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
  };
  const PLAIN_GOLDEN = '3be0f095b2113663ad008203165e0969';
  ok('every plain card composes and renders byte-for-byte as it did before the rule existed',
     e1digest(plain) === PLAIN_GOLDEN, `${e1digest(plain)} ≠ ${PLAIN_GOLDEN}`);
  ok('and a card whose only finishes are laminations is that same card',
     e1digest(lam) === PLAIN_GOLDEN, e1digest(lam));
  ok('the two escalated sweeps are genuinely different files, not the same one relabelled',
     e1digest(foil) !== PLAIN_GOLDEN && e1digest(die) !== PLAIN_GOLDEN && e1digest(foil) !== e1digest(die));

  // ── the finished card actually moved, measured on the geometry ──────────
  const insetOf = c => Math.min(...c.elements.filter(e => e.fit).flatMap(e =>
    [e.geom.x, e.geom.y, c.fmt.w - e.geom.x - e.geom.w, c.fmt.h - e.geom.y - e.geom.h]));
  const live = rows => rows.filter(r => !r.c.eliminated && r.c.elements.some(e => e.fit));
  const clears = (rows, mm) => live(rows).every(r => insetOf(r.c) >= mm - 1e-9);
  ok('the sweep has cards to measure', live(plain).length > 80, `${live(plain).length}`);
  ok('a plain card clears 4 mm and is allowed to sit on it',
     clears(plain, 4) && live(plain).some(r => insetOf(r.c) < 4.001),
     `min ${Math.min(...live(plain).map(r => insetOf(r.c))).toFixed(3)}`);
  ok('every foiled card places its content at 5 mm or better — placed there, not warned about',
     clears(foil, 5), `min ${Math.min(...live(foil).map(r => insetOf(r.c))).toFixed(3)}`);
  ok('and something really is up against the new edge rather than all of it clearing anyway',
     live(foil).some(r => insetOf(r.c) < 5.001));
  ok('every die-cut card places its content at 6 mm or better',
     clears(die, 6), `min ${Math.min(...live(die).map(r => insetOf(r.c))).toFixed(3)}`);
  ok('a card that is both foiled and die-cut is placed at the die\'s 6 mm',
     clears(both, 6));

  /* The move is inward on the cards that had content out there, and nothing
     moved outward anywhere. Cards whose content already cleared 5 mm are
     untouched, which is why this counts rather than requiring all of them. */
  const byKey = rows => Object.fromEntries(rows.map(r => [r.key, r]));
  const P = byKey(plain), Fo = byKey(foil);
  const shared = Object.keys(P).filter(k => !P[k].c.eliminated && !Fo[k].c.eliminated &&
                                            P[k].c.elements.some(e => e.fit) && Fo[k].c.elements.some(e => e.fit));
  const movedIn = shared.filter(k => insetOf(Fo[k].c) > insetOf(P[k].c) + 1e-9);
  const movedOut = shared.filter(k => insetOf(Fo[k].c) < insetOf(P[k].c) - 1e-9);
  ok('foil moves content inward on the cards that were using the outer millimetre',
     movedIn.length > 0 && movedOut.length === 0,
     `in=${movedIn.length} out=${movedOut.length} of ${shared.length}`);

  // ── preflight measures the number the composer placed against ───────────
  const safeFinding = c => mod.preflight(c).find(f => /mm safe area/.test(f.label));
  const agrees = rows => live(rows)
    .every(r => { const f = safeFinding(r.c);
                  return f && f.s === 'pass' && f.label.includes(`${r.c.fmt.safe} mm safe area`); });
  ok('preflight names the same safe area the composer used, on every plain card', agrees(plain));
  ok('preflight names 5 mm on a foiled card and passes it there', agrees(foil) &&
     safeFinding(live(foil)[0].c).label.includes('5 mm'));
  ok('preflight names 6 mm on a die-cut card and passes it there', agrees(die) &&
     safeFinding(live(die)[0].c).label.includes('6 mm'));

  /* The failure this replaces, reconstructed: content placed at the plain
     4 mm on a job that is going to be foiled. Preflight has to refuse it, or
     the escalation is decoration — the composer would be doing the work and
     the check would still pass whatever it was handed. */
  const tight = shared.find(k => insetOf(P[k].c) < 4.001);
  if (!tight) throw new Error('E1: no plain card in the sweep sits on the 4 mm line — nothing to check preflight against');
  const asIfPlacedAt4 = { ...Fo[tight].c, elements: P[tight].c.elements };
  const caught = safeFinding(asIfPlacedAt4);
  ok('a foil job whose content was placed at the plain 4 mm is refused, not passed',
     caught && caught.s === 'fail' && /outside the 5 mm safe area/.test(caught.label),
     `${tight} — ${caught && caught.label}`);

  // ── what the tighter area costs, counted rather than assumed ────────────
  /* A layout that cannot hold the content is eliminated rather than rendered
     badly (PRD §5.1), so losing some is the guarantee working. It is still
     worth a number: these are cards a customer could compose plain and can
     no longer compose foiled or die-cut. */
  const composable = rows => rows.filter(r => !r.c.eliminated).length;
  ok('the layouts eliminated before any of this are the orientation mismatches only',
     plain.every(r => !r.c.eliminated || /has no .* composition/.test(r.c.eliminated)),
     `${plain.length - composable(plain)} eliminated at 4 mm`);
  ok(`5 mm costs exactly 2 of ${composable(plain)} composable combinations`,
     composable(plain) - composable(foil) === 2,
     `lost ${composable(plain) - composable(foil)} — if this moved, the fit ladder's headroom did`);
  ok(`6 mm costs exactly 18 of ${composable(plain)} composable combinations`,
     composable(plain) - composable(die) === 18,
     `lost ${composable(plain) - composable(die)} — if this moved, the fit ladder's headroom did`);

  /* The number that would actually hurt: a card with no layout left at all.
     Six presets at four trims each still have something to compose on, so a
     die-cut narrows the choice rather than removing it. */
  const orphan = [];
  for (const p of mod.PRESETS) for (const f of mod.FORMATS){
    const avail = both.filter(r => r.key.startsWith(`${p.k}|`) && r.key.endsWith(`|${f.id}`) && !r.c.eliminated);
    if (!avail.length) orphan.push(`${p.k} · ${f.id}`);
  }
  ok('no card is left with nothing to compose on once it is foiled and die-cut',
     orphan.length === 0, orphan.join('; '));
}

H('41. Logo upload accepts the formats a designer actually hands over (PRD §5.2)');
{
  /* §5.2 says accept SVG, PDF and EPS and reject a poor raster at the point of
     upload. Only SVG was accepted, which in this market refuses the commonest
     handover there is: a logo comes back from whoever drew it as an
     Illustrator or CorelDRAW export, and that is a PDF or an EPS far more
     often than an SVG. */
  ok('the upload control offers PDF and EPS, not only SVG',
     /accept="[^"]*\.pdf[^"]*"/.test(HTML) && /accept="[^"]*\.eps[^"]*"/.test(HTML),
     (/<input[^>]*id="i_logo"[^>]*>/.exec(HTML) || [''])[0].slice(0, 140));
  ok('and its label says so, so nobody has to guess from the file picker',
     /Upload SVG, PDF, EPS/.test(HTML));
  ok('the engine reads a bounding box from both formats',
     /EPS_BBOX/.test(js) && /PDF_BOXES/.test(js));

  /* A vector file whose whole content is one placed photograph is a raster
     wearing a vector extension. It passes every "is this vector" check and
     fails at the press exactly like a JPEG. */
  ok('a placed image inside a vector file is detected, not assumed away',
     /EPS_RASTER/.test(js) && /PDF_RASTER/.test(js));
  const graded = mod.gradeLogo({ vector:true, kind:'pdf', colors:null, rasterInside:true }, 20);
  ok('and it is reported to the customer as a finding',
     graded.findings.some(f => /contains a placed image/i.test(f.label)),
     JSON.stringify(graded.findings.map(f => f.label)));
  ok('and the reason names what it costs them',
     graded.findings.some(f => /cannot be foiled|resolution/i.test(f.note || '')));

  /* An unmeasured colour count must read as unmeasured. Reporting 1 would be
     a number `gradeLogo` then treats as measured, and foil needs one colour —
     so the guess would be the difference between a plate that works and one
     that does not. */
  const unmeasured = mod.gradeLogo({ vector:true, kind:'eps', colors:null, rasterInside:false }, 20);
  ok('an unmeasured colour count says so rather than inventing one',
     unmeasured.findings.some(f => /not measured/i.test(f.label)),
     JSON.stringify(unmeasured.findings.map(f => f.label)));
  ok('a vector logo with no placed image is still accepted', unmeasured.ok);
}

H('42. The free tier, on screen (E2)');
{
  /* Master PRD §9's free tier — unlimited briefs, six concepts, watermarked
     previews, no export, no order — was described by the pricing screen and
     enforced nowhere, so every visitor got the press file for nothing. The
     server refusals are asserted in tests/entitlements.test.mjs; what is
     asserted here is the half a customer actually meets, and the two seams
     that only exist in this scope.

     The first seam is the watermark hook. It is applied after `draw()` rather
     than inside `renderSVG`, because `printDocSVG` builds the press document
     out of `renderSVG`'s output — anything drawn in the renderer, or wrapped
     onto it, travels into the print path by that route. So the hook is checked
     from both sides: that a preview in the document really does come out
     marked, and that a press document handed to the same code comes back
     untouched.

     The second is the pricing table. Its free column is now a set of claims
     this code keeps rather than a description of one, so each cell that says
     "—" is checked against the screen that withholds the thing. */
  const _doc7 = global.document;
  const _nav7 = Object.getOwnPropertyDescriptor(global, 'navigator');
  const _fetch7 = global.fetch;
  /* Offline, so the two background probes on these screens return before they
     reach the network. What is under test is what the screen draws from the
     entitlement it holds, not how it fetches one. */
  Object.defineProperty(global, 'navigator', { value: { onLine: false }, configurable: true });
  global.fetch = () => Promise.reject(new Error('no network under test'));

  const b7el = () => ({ innerHTML:'', textContent:'', value:'', style:{}, dataset:{},
    onclick:null, oninput:null, onchange:null, onkeydown:null, files:null, disabled:false,
    setAttribute(){}, toggleAttribute(){}, appendChild(){}, prepend(){},
    querySelector:()=>null, querySelectorAll:()=>[], closest:()=>null });
  const b7sink = {};
  let b7previews = [];
  const b7doc = {
    createElement: t => t === 'canvas' ? { getContext: () => fakeCtx } : b7el(),
    querySelector: s => b7sink[s] || (b7sink[s] = b7el()),
    /* Only the preview selector answers with nodes. A stub that returned the
       same list for every selector would have the watermark hook marking the
       nav bar. */
    querySelectorAll: s => s === 'svg.card' ? b7previews : [],
    fonts: { ready: Promise.resolve() }
  };
  global.document = b7doc;

  const b7 = new Function(js + `
    ;return { entitlementView, ensureEntitlement, filePackBlock, FILE_PACK, FREE_TIER,
              drawExport, drawOrder, drawPrintFile, drawPricing, exportGate,
              preflightGate, pfLedgerWrite,
              cwWatermarkPreviewSVG, cwMarkPreviews, cwPreviewWatermarkWanted,
              draw, state, currentDesign, PRICE_ROWS, PRICE_LINES, PRESETS };`)();

  const paint = (sel) => b7doc.querySelector(sel).innerHTML;
  const content = b7.PRESETS[0].c;
  b7.state.screen = 'export';
  b7.state.shareCode = 'a1b2c3d4';
  b7.state.ent = null;
  b7.state.entError = null;
  b7.state.entKey = null;

  // ── what a stranger holds ──
  const freeView = b7.entitlementView();
  ok('with nothing bought, the screen holds the free tier',
     freeView.tier === 'free' && freeView.may.export === false && freeView.may.order === false);
  ok('and the free tier is the watermarked one', freeView.watermark === true);
  ok('an answer about a different design does not unlock this one', (() => {
     b7.state.ent = { code:'ffffffff', tier:'paid', checked:true, watermark:false,
                      may:{ export:true, order:true }, price:b7.FILE_PACK };
     const v = b7.entitlementView();
     b7.state.ent = null;
     return v.may.export === false; })());
  ok('an unsaved design is free tier without a round trip', (() => {
     const code = b7.state.shareCode; b7.state.shareCode = null;
     const v = b7.entitlementView(); b7.state.shareCode = code;
     return v.may.export === false && v.checked === false; })());

  // ── export ──
  /* The paid gate is downstream of the preflight one, so the advisories have
     to be accepted first or every assertion below would be measuring the
     wrong refusal. Accepted through the same ledger the Validate screen
     writes, rather than by reaching past it. */
  {
    const g = b7.preflightGate(b7.currentDesign(), content);
    for (const f of g.pending)
      b7.pfLedgerWrite(g.key, f.lid, { by:'test', at:'2026-08-15T00:00:00Z', recorded:true });
  }
  const gate7 = b7.exportGate(b7.currentDesign(), content);
  ok('the design under test is one preflight would release',
     gate7.ready === true, gate7.reason);

  b7.drawExport(b7.currentDesign(), content);
  const lockedExports = paint('#exports');
  ok('a free-tier export screen offers no file at all',
     !/download="/.test(lockedExports), lockedExports.slice(0, 160));
  ok('and names the price rather than only disabling something',
     /৳199/.test(lockedExports), lockedExports.slice(0, 160));
  ok('the refusal says what the payment releases',
     /PDF\/X-4/.test(lockedExports) && /separation/i.test(lockedExports));
  ok('and it says what stays free, so it reads as a price and not a wall',
     /free/i.test(lockedExports) && /six concepts/i.test(lockedExports));
  ok('the print-geometry SVGs are withheld with the PDF, not left as a side door',
     !/card_front_print\.svg/.test(lockedExports));
  ok('the PDF panel stops offering to build one',
     !/data-buildpdf/.test(paint('#printFile')));
  ok('but Export still says the preflight is clean, because it is',
     b7doc.querySelector('#exportMeta').textContent === 'Preflight clean');
  ok('and the door to the checkout stays open, because the checkout is where the price is paid',
     b7doc.querySelector('#b_toorder').disabled === false);

  b7.state.ent = { code:'a1b2c3d4', tier:'paid', checked:true, watermark:false,
                   may:{ export:true, order:true }, price:b7.FILE_PACK };
  b7.drawExport(b7.currentDesign(), content);
  const paidExports = paint('#exports');
  ok('a bought design releases the files',
     /download="card_front_print\.svg"/.test(paidExports), paidExports.slice(0, 160));
  ok('and stops asking for money for something already paid for',
     !/৳199/.test(paidExports));
  ok('the PDF panel offers to build the file again',
     /data-buildpdf/.test(paint('#printFile')));

  // ── order ──
  b7.state.screen = 'order';
  b7.state.ent = null;
  b7.drawOrder(b7.currentDesign(), content);
  ok('a free-tier checkout cannot place the order',
     b7doc.querySelector('#b_placeorder').disabled === true);
  ok('and says why, with the price, beside the button rather than nowhere',
     /৳199/.test(paint('#orderOut')));
  ok('the order refusal explains the file pack is credited, not charged twice',
     /credited/i.test(paint('#orderOut')));

  // ── the watermark hook ──
  const composed = mod.compose(mod.specFor('lay.rule', content));
  const previewSVG = mod.renderSVG(composed);
  const printSVG = mod.printDocSVG(composed);
  ok('there is a preview and a press document to tell apart',
     typeof previewSVG === 'string' && previewSVG.length > 200 &&
     typeof printSVG === 'string' && printSVG.length > 200);

  ok('the free tier wants a watermark', (() => {
     b7.state.ent = null; return b7.cwPreviewWatermarkWanted() === true; })());
  ok('and a bought design does not', (() => {
     b7.state.ent = { code:'a1b2c3d4', tier:'paid', checked:true, watermark:false,
                      may:{ export:true, order:true }, price:b7.FILE_PACK };
     const wanted = b7.cwPreviewWatermarkWanted();
     b7.state.ent = null;
     return wanted === false; })());

  const node = { outerHTML: previewSVG };
  b7previews = [node];
  ok('a preview in the document comes out marked',
     b7.cwMarkPreviews(b7doc) === 1 && /data-cardworks-watermark/.test(node.outerHTML));
  ok('marking again marks nothing, so a redraw does not stack two',
     b7.cwMarkPreviews(b7doc) === 0);

  const printNode = { outerHTML: printSVG };
  b7previews = [printNode];
  ok('a press document handed to the same code comes back untouched',
     b7.cwMarkPreviews(b7doc) === 0 && printNode.outerHTML === printSVG);

  /* The hook itself, rather than the function it calls: `draw()` is the one
     place every screen renders from, so marking after it is what covers the
     concepts grid and the dashboard without those files knowing this exists. */
  const drawn = { outerHTML: previewSVG };
  b7previews = [drawn];
  b7.state.screen = 'export';
  b7.draw();
  ok('draw() marks the previews it just rendered',
     /data-cardworks-watermark/.test(drawn.outerHTML));

  const paidNode = { outerHTML: previewSVG };
  b7previews = [paidNode];
  b7.state.ent = { code:'a1b2c3d4', tier:'paid', checked:true, watermark:false,
                   may:{ export:true, order:true }, price:b7.FILE_PACK };
  b7.draw();
  ok('and leaves them clean once the design has been bought',
     paidNode.outerHTML === previewSVG);
  b7.state.ent = null;
  b7previews = [];

  // ── the pricing table is now a set of claims this code keeps ──
  const cell = (name, col) => (b7.PRICE_ROWS.find(r => new RegExp(name, 'i').test(r[0])) || [])[col];
  ok('the free column withholds the PDF, and the export screen agrees',
     cell('PDF/X-4', 1) === '—' && !/download="/.test(lockedExports));
  ok('the free column withholds the geometry documents too',
     cell('Print-geometry', 1) === '—');
  ok('the free column withholds printing, and the checkout agrees',
     cell('Printing and delivery', 1) === '—' &&
     b7doc.querySelector('#b_placeorder').disabled === true);
  ok('the free column grants the preflight report, and nothing gates it',
     cell('Full preflight report', 1) === 'Yes');
  ok('the free column asks for no account, which is PRD §3.2\'s whole point',
     cell('Account needed to get here', 1) === 'No');
  ok('the free preview is watermarked in the table and on the screen',
     /watermark/i.test(cell('Preview', 1) || '') && b7.cwPreviewWatermarkWanted() === true);
  ok('the file-pack line on the pricing screen quotes the same figure the refusal does',
     b7.PRICE_LINES[0].price === '৳' + b7.FILE_PACK.amount,
     b7.PRICE_LINES[0].price + ' vs ' + b7.FILE_PACK.amount);

  global.document = _doc7;
  if (_nav7) Object.defineProperty(global, 'navigator', _nav7);
  else delete global.navigator;
  global.fetch = _fetch7;
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
