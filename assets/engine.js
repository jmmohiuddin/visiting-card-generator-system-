/* ═══════════════════════════════════════════════════════════════════════════
   CARDWORKS ENGINE — reference implementation
   ---------------------------------------------------------------------------
   Scope: the part of the system that did not exist in the prototype and that
   everything else depends on — the composer, the fit ladder, the single
   renderer, and geometric preflight.

   NOT in scope here: LLM intent resolution, ranking/scoring, orders, PDF/X-4
   output, persistence, tenancy. Those are specified in the blueprint; this
   file proves the hard part is tractable and pins down its contract.

   Core invariant: a layout is DATA. Adding a layout = adding a record below.
   No function in this file branches on a layout id.
   ═════════════════════════════════════════════════════════════════════════ */

const PT = 0.352778;                 // 1pt in mm
/* The grid follows the trim. A 12 × 8 grid over a portrait card gives cells
   4.3 mm wide and 11.1 mm tall — a shape nothing sensible can be composed
   on. Portrait transposes to 8 × 12 and square uses 10 × 10, so a cell stays
   roughly square in every format. A layout must therefore AUTHOR its
   portrait and square variants; it cannot be stretched into them. */
const GRID = { cols: 12, rows: 8 };
const GRIDS = { landscape:{cols:12,rows:8}, portrait:{cols:8,rows:12}, square:{cols:10,rows:10} };
const gridFor = fmt => GRIDS[fmt.orientation] || GRIDS.landscape;

/* Which slot set a layout uses for a given orientation. Returning null is
   the honest answer for "this composition cannot hold that shape" — the
   caller eliminates it rather than squeezing it. */
function slotsFor(layout, orientation){
  if (orientation === 'portrait') return layout.portrait || null;
  if (orientation === 'square')   return layout.square   || null;
  return layout.slots;
}

/* ───────────────────────────── FORMATS ─────────────────────────────
   Bangladesh standard is 89 × 51 mm (3.5 × 2 in) — inherited via India,
   and what every press in Nilkhet / Fakirapool / Banglabazar cuts by
   default. 90 × 50 is the second most common. Portrait is rare but real
   for doctors' chamber cards.                                            */
const FORMATS = [
  { id:'bd-std',   name:'Bangladesh standard — 89 × 51 mm', w:89, h:51, bleed:3, safe:4, orientation:'landscape' },
  { id:'bd-alt',   name:'Bangladesh alt — 90 × 50 mm',      w:90, h:50, bleed:3, safe:4, orientation:'landscape' },
  { id:'bd-port',  name:'Portrait — 51 × 89 mm',            w:51, h:89, bleed:3, safe:4, orientation:'portrait' },
  { id:'bd-square',name:'Square — 55 × 55 mm',              w:55, h:55, bleed:3, safe:4, orientation:'square' }
];

/* ── The safe area belongs to the JOB, not to the trim ────────────────────
   The `safe` on a format record above is the plain-ink figure, and Master
   PRD §7 asks for two more: 5 mm when a finish is registered on top of the
   printed sheet, 6 mm when the card is die-cut. The reason is mechanical
   rather than editorial. Ink is laid down in one pass on one machine, so its
   registration is as good as the press is; a foil block, an emboss die, a
   letterpress plate and an edge paint are all applied in a SECOND pass on a
   different machine, against a sheet that has already been through a nip and
   changed size slightly, so their registration to the printed image is
   looser. A rotary die is looser still — it is set from the trim, wanders
   further than a guillotine, and takes the corner with it.

   Which means the same 4 mm that is generous on a plain card is not enough
   on a foiled one, and a foiled card composed at 4 mm is not a card with a
   tight margin; it is a card whose gold sometimes lands on the name.

   Letterpress and edge paint are named here although neither is in
   `FINISH_COST` yet, deliberately: the geometry rule is what PRD §7 states,
   and it should already be right on the day the cost table learns to sell
   them. `lib/quote-server.mjs` lists the same four as the finishes that
   cannot be proofed from a photograph — the same physical fact, seen from
   the other end. */
const REGISTERED_FINISHES = ['foil', 'emboss', 'letterpress', 'edgepaint'];
const SAFE_REGISTERED = 5, SAFE_DIECUT = 6;

/* The die radius is clamped exactly as the renderer and the print writer
   clamp it, so a nonsense corner cannot buy a safe area for a die that is
   never actually cut. */
const dieRadius = spec => Math.max(0, Math.min(6, Number(spec && spec.corner) || 0));

function safeFor(fmt, spec){
  const s = spec || {};
  const finishes = Array.isArray(s.finishes) ? s.finishes : [];
  let safe = fmt.safe;
  if (finishes.some(f => REGISTERED_FINISHES.includes(f))) safe = Math.max(safe, SAFE_REGISTERED);
  if (dieRadius(s) > 0) safe = Math.max(safe, SAFE_DIECUT);
  return safe;
}

/* ─────────────────────────── TYPE SYSTEMS ───────────────────────────
   Every system MUST declare a Bangla family. A type system without one
   cannot be offered on a bilingual card — that is enforced in preflight,
   not left to a designer to remember.

   All families below are SIL OFL: embeddable and outline-able in
   commercial print output. This is a hard library policy.               */
const TYPE_SYSTEMS = [
  { id:'typ.siliguri', name:'Hind Siliguri + Libre Franklin', note:'Workhorse. Best Bangla legibility at small sizes.',
    latin:"'Libre Franklin',sans-serif", bangla:"'Hind Siliguri',sans-serif", banglaOk:true, weightName:600 },
  { id:'typ.noto',     name:'Noto Sans Bengali + Archivo', note:'Widest conjunct coverage. Safest for uncommon names.',
    latin:"'Archivo',sans-serif", bangla:"'Noto Sans Bengali',sans-serif", banglaOk:true, weightName:700 },
  { id:'typ.tiro',     name:'Tiro Bangla + Playfair Display', note:'Editorial. Traditional Bangla letterforms, high contrast.',
    latin:"'Playfair Display',serif", bangla:"'Tiro Bangla',serif", banglaOk:true, weightName:600 },
  { id:'typ.baloo',    name:'Baloo Da 2 + Archivo', note:'Heavy display. Retail, food, events.',
    latin:"'Archivo',sans-serif", bangla:"'Baloo Da 2',sans-serif", banglaOk:true, weightName:800 },
  { id:'typ.mono',     name:'IBM Plex Mono + Noto Sans Bengali', note:'Technical. IT, engineering, data.',
    latin:"'IBM Plex Mono',monospace", bangla:"'Noto Sans Bengali',sans-serif", banglaOk:true, weightName:600 }
];

/* ───────────────────────────── PALETTES ─────────────────────────────
   Chosen against what Dhaka presses actually run well: heavy solids on
   300–350 gsm art card, gold foil (cheap and ubiquitous here), spot UV.
   Every palette declares TAC so the engine can refuse an unprintable one. */
const PALETTES = [
  { id:'pal.ink',    name:'Ink on white',        bg:'#ffffff', fg:'#16161a', accent:'#c1121f', muted:'#7a7876', hair:'#d8d5d2', panel:'#16161a' },
  { id:'pal.gold',   name:'Black & gold',        bg:'#0d0d0c', fg:'#efe9dc', accent:'#c9a227', muted:'#8e8778', hair:'#5c5850', panel:'#0d0d0c' },
  { id:'pal.green',  name:'Bottle green & bone', bg:'#f5f4ef', fg:'#12291f', accent:'#0a6847', muted:'#7c837e', hair:'#cdd2cb', panel:'#0a6847' },
  { id:'pal.navy',   name:'Navy & brass',        bg:'#0f2233', fg:'#eef1f4', accent:'#c8a45c', muted:'#8494a3', hair:'#2b3d4d', panel:'#0f2233' },
  { id:'pal.maroon', name:'Cream & maroon',      bg:'#f4efe6', fg:'#1f1b18', accent:'#7a1f28', muted:'#8b8377', hair:'#d4cbbc', panel:'#7a1f28' },
  { id:'pal.teal',   name:'White & teal',        bg:'#ffffff', fg:'#14201f', accent:'#0d7a72', muted:'#7d8a88', hair:'#dde5e4', panel:'#0d7a72' },
  { id:'pal.slate',  name:'Charcoal & signal',   bg:'#1b1e21', fg:'#e6e8ea', accent:'#00c48a', muted:'#8b959c', hair:'#3a4045', panel:'#1b1e21' },
  { id:'pal.red',    name:'White & vermilion',   bg:'#ffffff', fg:'#191919', accent:'#e03616', muted:'#7d7d7d', hair:'#e2e2e2', panel:'#191919' }
];

/* ──────────────────────── SLOT DEFINITIONS ────────────────────────
   The six slots the prototype already specified on its layout-builder
   screen. Here they are the runtime, not a diagram.                   */
const SLOTDEFS = {
  mark:    { minMm:9,  required:false },
  company: { minPt:6.0, required:false },
  name:    { minPt:7.0, required:true  },
  role:    { minPt:6.0, required:false },
  contact: { minPt:6.0, required:true  },
  qr:      { minMm:12, required:false }
};

/* ───────────── SCRIPT METRICS — the Bangladesh-specific core ─────────────
   Bangla is not Latin with different glyphs. Three facts drive everything:

   1. MATRA (মাত্রা) — the hanging headline sits at the top of most letters,
      and ascenders (ি ী ে ৈ ো ৌ) rise ABOVE it. Bangla needs materially
      more room above the baseline than Latin.
   2. CONJUNCTS (যুক্তাক্ষর) — ক্ষ, ঙ্গ, ন্ত্র stack vertically and collapse
      into mush below ~7.5 pt in print. The 6 pt Latin floor is unsafe.
   3. OPTICAL SIZE — at equal point size Bangla reads smaller and denser
      than Latin, so a bilingual card set at one size looks unbalanced.
      Bangla needs roughly 1.12× to sit optically level with Latin.

   No Western card tool encodes any of this. It is the whole reason a
   Bangladesh-first product can be better here than Canva, permanently.  */
const SCRIPTS = {
  latin:  { minPt:6.0, opticalScale:1.00, lineHeight:1.24, ascentPad:0.00, tracking:{min:-0.02, max:0.24} },
  bangla: { minPt:7.5, opticalScale:1.12, lineHeight:1.52, ascentPad:0.10, tracking:{min: 0.00, max:0.06} }
  /* Bangla tracking floor is 0: letter-spacing breaks the matra join and
     the conjunct clusters. The composer must never track Bangla negative. */
};
const BN_RANGE = /[ঀ-৿]/;
const scriptOf = t => BN_RANGE.test(String(t||'')) ? 'bangla' : 'latin';

/* Bengali numerals — standard on the Bangla face of a bilingual card. */
const BN_DIGITS = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
const toBnDigits = s => String(s).replace(/[0-9]/g, d => BN_DIGITS[+d]);

/* Typed abbreviation rules — rung 4 of the fit ladder. These are DATA, and
   they are never invented at runtime. An abbreviation the library does not
   know is an abbreviation the system will not make. */
const ABBREV = [
  [/\bChief Executive Officer\b/i,'CEO'], [/\bManaging Director\b/i,'MD'],
  [/\bChief Technology Officer\b/i,'CTO'], [/\bChief Operating Officer\b/i,'COO'],
  [/\bChief Financial Officer\b/i,'CFO'], [/\bDeputy General Manager\b/i,'DGM'],
  [/\bAssistant General Manager\b/i,'AGM'], [/\bGeneral Manager\b/i,'GM'],
  [/\bSenior\b/i,'Sr.'], [/\bAssistant\b/i,'Asst.'], [/\bAssociate\b/i,'Assoc.'],
  [/\bProfessor\b/i,'Prof.'], [/\bMohammad\b/i,'Md.'], [/\bMuhammad\b/i,'Md.'],
  [/\bDepartment\b/i,'Dept.'], [/\bLimited\b/i,'Ltd.'], [/\bInternational\b/i,"Int'l"],
  [/ব্যবস্থাপনা পরিচালক/,'এমডি'], [/সহকারী অধ্যাপক/,'সহ. অধ্যাপক'], [/মোহাম্মদ/,'মোঃ']
];

/* ═════════════════════════════ LAYOUT LIBRARY ═════════════════════════════
   Boxes are [x, y, w, h] in GRID UNITS on a 12 × 8 grid, resolved to mm at
   compose time. `scale` is a multiple of the base name size — ratios, never
   absolute points, so a layout works at any trim.

   ADD A LAYOUT = ADD A RECORD. No code changes. That is the entire point.  */
const LAYOUTS = [
{ id:'lay.rule', name:'Rule & Name', family:'minimal', face:'front',
  slots:[
    {ref:'mark',    kind:'mark',    box:[0.8,0.8,1.3,1.3], color:'fg'},
    {ref:'company', kind:'text',    box:[3.2,0.9,8.0,0.8], scale:.36, align:'right', upper:true, track:.20, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'_rule',   kind:'rule',    box:[0.8,4.15,2.2,0.09], color:'accent'},
    {ref:'name',    kind:'text',    box:[0.8,4.45,10.4,1.35], scale:1, weight:'name', color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,5.85,7.5,0.75], scale:.50, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.8,6.75,10.4,0.9], scale:.42, mode:'inline', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  /* 8 × 12 grid. Not the landscape slots rotated — the hierarchy is
     re-authored: the rule and name move to the lower third, where the eye
     lands on a tall card, and contact stacks instead of running inline. */
  portrait:[
    {ref:'mark',    kind:'mark',    box:[0.7,0.7,1.5,1.1], color:'fg'},
    {ref:'company', kind:'text',    box:[2.5,0.8,4.8,0.8], scale:.36, align:'right', upper:true, track:.18, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'_rule',   kind:'rule',    box:[0.7,6.4,2.0,0.07], color:'accent'},
    {ref:'name',    kind:'text',    box:[0.7,6.8,6.6,1.9], scale:1, weight:'name', color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.7,8.9,6.6,0.9], scale:.50, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.7,10.0,6.6,1.4], scale:.42, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  square:[
    {ref:'mark',    kind:'mark',    box:[0.8,0.8,1.6,1.6], color:'fg'},
    {ref:'company', kind:'text',    box:[2.8,0.9,6.4,0.9], scale:.36, align:'right', upper:true, track:.18, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'_rule',   kind:'rule',    box:[0.8,5.4,2.0,0.08], color:'accent'},
    {ref:'name',    kind:'text',    box:[0.8,5.8,8.4,1.7], scale:1, weight:'name', color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,7.6,8.4,0.9], scale:.50, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.8,8.6,8.4,0.9], scale:.42, mode:'inline', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ]},
{ id:'lay.centered', name:'Centred Signature', family:'traditional', face:'front',
  slots:[
    {ref:'mark',    kind:'mono',    box:[5.0,1.0,2.0,1.7], color:'accent', align:'center'},
    {ref:'_hair',   kind:'rule',    box:[5.4,3.05,1.2,0.05], color:'hair'},
    {ref:'name',    kind:'text',    box:[1.2,3.35,9.6,1.25], scale:.92, align:'center', color:'fg', maxLines:1, priority:1, fit:['track','step']},
    {ref:'role',    kind:'text',    box:[1.2,4.7,9.6,0.75], scale:.44, align:'center', upper:true, track:.14, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'company', kind:'text',    box:[1.2,6.3,9.6,0.8], scale:.40, align:'center', upper:true, track:.20, color:'accent', priority:3, fit:['track','step','drop']}
  ],
  portrait:[
    {ref:'mark',    kind:'mono',    box:[3.0,1.8,2.0,1.7], color:'accent', align:'center'},
    {ref:'_hair',   kind:'rule',    box:[3.6,4.0,0.8,0.05], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.7,4.4,6.6,1.7], scale:.92, align:'center', color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.7,6.3,6.6,0.9], scale:.44, align:'center', upper:true, track:.14, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'company', kind:'text',    box:[0.7,9.8,6.6,0.9], scale:.40, align:'center', upper:true, track:.20, color:'accent', priority:3, fit:['track','step','drop']}
  ],
  square:[
    {ref:'mark',    kind:'mono',    box:[4.0,1.5,2.0,1.7], color:'accent', align:'center'},
    {ref:'_hair',   kind:'rule',    box:[4.6,3.7,0.8,0.05], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.8,4.1,8.4,1.5], scale:.88, align:'center', color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,5.8,8.4,0.9], scale:.44, align:'center', upper:true, track:.14, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'company', kind:'text',    box:[0.8,7.9,8.4,0.9], scale:.40, align:'center', upper:true, track:.20, color:'accent', priority:3, fit:['track','step','drop']}
  ]},
{ id:'lay.split', name:'Split Panel', family:'structured', face:'front',
  slots:[
    {ref:'_panel',  kind:'panel',   box:[0,0,4,8], color:'panel'},
    {ref:'mark',    kind:'mark',    box:[0.7,0.9,1.5,1.5], color:'bg', onPanel:true},
    {ref:'company', kind:'text',    box:[0.5,6.3,3.1,0.9], scale:.34, upper:true, track:.18, color:'bg', onPanel:true, maxLines:2, priority:4, fit:['track','step','wrap','drop']},
    {ref:'name',    kind:'text',    box:[4.7,2.0,6.6,1.2], scale:.82, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[4.7,3.3,6.6,0.75], scale:.44, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'_hair2',  kind:'rule',    box:[4.7,4.25,1.8,0.05], color:'hair'},
    {ref:'contact', kind:'contact', box:[4.7,4.5,6.6,2.7], scale:.40, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ]},
{ id:'lay.bleed', name:'Full Bleed', family:'expressive', face:'front',
  slots:[
    {ref:'_flood',  kind:'panel',   box:[0,0,12,8], color:'accent'},
    {ref:'_ghost',  kind:'ghost',   box:[6.2,1.0,6.6,6.6], color:'bg'},
    {ref:'company', kind:'text',    box:[0.8,0.85,7,0.8], scale:.36, upper:true, track:.20, color:'bg', priority:4, fit:['track','step','drop']},
    {ref:'name',    kind:'text',    box:[0.8,3.9,8.6,2.3], scale:1.22, weight:'display', color:'bg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,6.4,7.6,0.8], scale:.44, color:'bg', priority:2, fit:['track','step','abbrev','drop']}
  ]},
{ id:'lay.editorial', name:'Editorial', family:'traditional', face:'front',
  slots:[
    {ref:'company', kind:'text',    box:[1.0,0.9,8.5,0.8], scale:.34, upper:true, track:.22, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'name',    kind:'text',    box:[1.0,3.0,9.8,1.5], scale:1.02, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[1.0,4.6,8.5,0.8], scale:.44, upper:true, track:.12, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'_hair',   kind:'rule',    box:[1.0,6.35,10.0,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[1.0,6.55,10.0,0.85], scale:.38, mode:'inline', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  portrait:[
    {ref:'company', kind:'text',    box:[0.8,0.9,6.4,0.8], scale:.34, upper:true, track:.22, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'name',    kind:'text',    box:[0.8,3.6,6.4,2.1], scale:1.0, color:'fg', maxLines:3, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,5.9,6.4,0.9], scale:.44, upper:true, track:.12, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'_hair',   kind:'rule',    box:[0.8,9.8,6.4,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[0.8,10.1,6.4,1.3], scale:.40, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ]},
{ id:'lay.grid', name:'Technical Grid', family:'technical', face:'front',
  slots:[
    {ref:'_grid',   kind:'gridlines', box:[0,0,12,8], color:'hair'},
    {ref:'company', kind:'text',    box:[0.8,0.85,6,0.7], scale:.32, upper:true, track:.20, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'qr',      kind:'qr',      box:[8.6,0.7,2.7,2.7], color:'fg'},
    {ref:'name',    kind:'text',    box:[0.8,3.5,8.0,1.15], scale:.80, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,4.75,8.0,0.75], scale:.42, color:'accent', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.8,5.7,10.4,1.6], scale:.38, mode:'stack', color:'muted', priority:3, fit:['track','step','reduceRoutes']}
  ]},
{ id:'lay.band', name:'Colour Band', family:'structured', face:'front',
  slots:[
    {ref:'_band',   kind:'panel',   box:[0,0,12,2.3], color:'panel'},
    {ref:'company', kind:'text',    box:[0.8,0.75,10.4,0.85], scale:.40, upper:true, track:.20, color:'bg', onPanel:true, priority:4, fit:['track','step','drop']},
    {ref:'name',    kind:'text',    box:[0.8,3.2,10.4,1.25], scale:.94, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,4.55,8.5,0.75], scale:.44, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.8,6.0,10.4,1.3], scale:.40, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  portrait:[
    {ref:'_band',   kind:'panel',   box:[0,0,8,2.8], color:'panel'},
    {ref:'company', kind:'text',    box:[0.7,1.1,6.6,0.9], scale:.38, upper:true, track:.20, color:'bg', onPanel:true, priority:4, fit:['track','step','drop']},
    {ref:'name',    kind:'text',    box:[0.7,4.2,6.6,1.8], scale:.94, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.7,6.2,6.6,0.9], scale:.46, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.7,9.4,6.6,2.0], scale:.42, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ]},
{ id:'lay.corner', name:'Corner Monogram', family:'expressive', face:'front',
  slots:[
    {ref:'mark',    kind:'bigmono', box:[7.6,0.2,4.2,4.0], color:'accent'},
    {ref:'company', kind:'text',    box:[0.8,0.9,6.2,0.8], scale:.34, upper:true, track:.20, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'name',    kind:'text',    box:[0.8,4.35,8.0,1.2], scale:.88, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,5.6,7.4,0.7], scale:.42, color:'muted', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.8,6.5,10.4,0.85], scale:.38, mode:'inline', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ]},
{ id:'lay.stack', name:'Ruled Stack', family:'minimal', face:'front',
  slots:[
    {ref:'company', kind:'text',    box:[0.8,0.8,10.4,0.75], scale:.34, upper:true, track:.20, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'_h1',     kind:'rule',    box:[0.8,1.68,10.4,0.04], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.8,1.95,10.4,1.2], scale:.88, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'_h2',     kind:'rule',    box:[0.8,3.32,10.4,0.04], color:'hair'},
    {ref:'role',    kind:'text',    box:[0.8,3.6,10.4,0.75], scale:.44, color:'accent', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'_h3',     kind:'rule',    box:[0.8,4.5,10.4,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[0.8,4.78,10.4,2.4], scale:.40, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  portrait:[
    {ref:'company', kind:'text',    box:[0.7,0.8,6.6,0.8], scale:.34, upper:true, track:.20, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'_h1',     kind:'rule',    box:[0.7,1.8,6.6,0.04], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.7,2.1,6.6,1.8], scale:.88, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'_h2',     kind:'rule',    box:[0.7,4.1,6.6,0.04], color:'hair'},
    {ref:'role',    kind:'text',    box:[0.7,4.4,6.6,0.9], scale:.46, color:'accent', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'_h3',     kind:'rule',    box:[0.7,5.5,6.6,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[0.7,5.8,6.6,5.4], scale:.42, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  square:[
    {ref:'company', kind:'text',    box:[0.8,0.9,8.4,0.9], scale:.34, upper:true, track:.20, color:'muted', priority:4, fit:['track','step','drop']},
    {ref:'_h1',     kind:'rule',    box:[0.8,2.0,8.4,0.04], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.8,2.3,8.4,1.6], scale:.88, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'_h2',     kind:'rule',    box:[0.8,4.1,8.4,0.04], color:'hair'},
    {ref:'role',    kind:'text',    box:[0.8,4.4,8.4,0.9], scale:.46, color:'accent', priority:2, fit:['track','step','abbrev','drop']},
    {ref:'_h3',     kind:'rule',    box:[0.8,5.5,8.4,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[0.8,5.8,8.4,3.4], scale:.42, mode:'stack', color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ]},

/* ── BACK FACES ───────────────────────────────────────────────────────── */
{ id:'back.contact', name:'Contact block', face:'back',
  slots:[
    {ref:'company', kind:'text',    box:[0.8,0.9,10.4,0.85], scale:.38, upper:true, track:.20, color:'accent', priority:4, fit:['track','step','drop']},
    {ref:'_h',      kind:'rule',    box:[0.8,1.85,10.4,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[0.8,2.3,10.4,4.9], scale:.44, mode:'stack', color:'fg', priority:1, fit:['track','step','reduceRoutes']}
  ],
  portrait:[
    {ref:'company', kind:'text',    box:[0.7,0.9,6.6,0.9], scale:.38, upper:true, track:.20, color:'accent', priority:4, fit:['track','step','drop']},
    {ref:'_h',      kind:'rule',    box:[0.7,2.0,6.6,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[0.7,2.4,6.6,8.8], scale:.44, mode:'stack', color:'fg', priority:1, fit:['track','step','reduceRoutes']}
  ],
  square:[
    {ref:'company', kind:'text',    box:[0.8,0.9,8.4,0.9], scale:.38, upper:true, track:.20, color:'accent', priority:4, fit:['track','step','drop']},
    {ref:'_h',      kind:'rule',    box:[0.8,2.1,8.4,0.04], color:'hair'},
    {ref:'contact', kind:'contact', box:[0.8,2.5,8.4,6.6], scale:.44, mode:'stack', color:'fg', priority:1, fit:['track','step','reduceRoutes']}
  ]},
{ id:'back.bangla', name:'বাংলা face', face:'back', forceScript:'bangla',
  slots:[
    {ref:'company', kind:'text',    box:[0.8,0.9,10.4,0.9], scale:.38, color:'accent', priority:4, maxLines:2, fit:['track','step','wrap','drop']},
    {ref:'_h',      kind:'rule',    box:[0.8,2.0,10.4,0.04], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.8,2.3,10.4,1.35], scale:.88, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,3.8,10.4,0.9], scale:.46, color:'muted', priority:2, maxLines:2, fit:['track','step','wrap','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.8,5.0,10.4,2.2], scale:.42, mode:'stack', bnDigits:true, color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  portrait:[
    {ref:'company', kind:'text',    box:[0.7,0.9,6.6,1.0], scale:.38, color:'accent', priority:4, maxLines:2, fit:['track','step','wrap','drop']},
    {ref:'_h',      kind:'rule',    box:[0.7,2.2,6.6,0.04], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.7,2.6,6.6,1.9], scale:.88, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.7,4.7,6.6,1.1], scale:.46, color:'muted', priority:2, maxLines:2, fit:['track','step','wrap','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.7,6.2,6.6,5.0], scale:.42, mode:'stack', bnDigits:true, color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ],
  square:[
    {ref:'company', kind:'text',    box:[0.8,0.9,8.4,1.0], scale:.38, color:'accent', priority:4, maxLines:2, fit:['track','step','wrap','drop']},
    {ref:'_h',      kind:'rule',    box:[0.8,2.2,8.4,0.04], color:'hair'},
    {ref:'name',    kind:'text',    box:[0.8,2.6,8.4,1.7], scale:.88, color:'fg', maxLines:2, priority:1, fit:['track','step','wrap']},
    {ref:'role',    kind:'text',    box:[0.8,4.5,8.4,1.0], scale:.46, color:'muted', priority:2, maxLines:2, fit:['track','step','wrap','abbrev','drop']},
    {ref:'contact', kind:'contact', box:[0.8,5.8,8.4,3.4], scale:.42, mode:'stack', bnDigits:true, color:'fg', priority:3, fit:['track','step','reduceRoutes']}
  ]},
{ id:'back.qr', name:'QR forward', face:'back',
  slots:[
    {ref:'qr',      kind:'qr',      box:[4.3,1.5,3.4,3.4], color:'fg'},
    {ref:'_cap',    kind:'static',  box:[1.0,5.3,10.0,0.8], scale:.36, align:'center', upper:true, track:.18, color:'muted', text:'Scan to save contact'},
    {ref:'company', kind:'text',    box:[1.0,6.2,10.0,0.8], scale:.40, align:'center', upper:true, track:.20, color:'accent', priority:4, fit:['track','step','drop']}
  ]},
{ id:'back.mark', name:'Mark only', face:'back',
  slots:[
    {ref:'_flood',  kind:'panel',   box:[0,0,12,8], color:'panel'},
    {ref:'mark',    kind:'bigmono', box:[4.0,2.0,4.0,4.0], color:'bg', align:'center'}
  ]}
];

/* ═══════════════════════════ MEMOISATION ═══════════════════════════════
   Generation asks the same pure question hundreds of times in a row. One
   brief enumerates 360 candidates over 9 layouts × 8 palettes × 5 type
   systems, and a QR symbol depends on none of those beyond the millimetres
   it is given — so the same vCard gets encoded, masked and penalty-scored
   forty times to produce forty identical matrices.

   Caching that is safe for exactly the reason §3.3 gives: the engine may not
   read a clock, a database or an unseeded random number, so a pure function's
   answer cannot go stale between two calls with the same arguments. A cache
   here can only ever save work; it can never change an answer. That is a
   property of the constraint, not of the cache, which is why the constraint
   is worth keeping even when it is inconvenient.

   Every cache is bounded. An unbounded one is a leak in the sessions that
   matter most — an hour of typing, a 200-row CSV — and eviction is free of
   consequence, since the worst it costs is recomputing something. Eviction
   is oldest-first, which is what a Map's insertion order already gives.

   `PERF.caches = false` turns all of them off. That switch is what makes
   "the optimisation changed nothing" a test rather than a claim: the suite
   runs the whole matrix through both paths and requires identical output,
   and the hit counters prove the fast path was genuinely the fast path.   */
const PERF = { caches: true, hits: 0, misses: 0 };

/* A memoised pure function. `make` must never return `undefined` — that is
   the one value this cannot tell apart from a miss. */
function memo(limit){
  const m = new Map();
  return {
    map: m,
    clear(){ m.clear(); },
    get(key, make){
      if (!PERF.caches){ PERF.misses++; return make(); }
      const hit = m.get(key);
      if (hit !== undefined){ PERF.hits++; return hit; }
      PERF.misses++;
      const v = make();
      m.set(key, v);
      if (m.size > limit) m.delete(m.keys().next().value);
      return v;
    }
  };
}

/* ═══════════════════════════ QR — a real encoder ═══════════════════════
   The placeholder module grid that used to live here was the last fake in
   this engine, and an indefensible one: the product's whole claim is that
   the output cannot be wrong. A card that ships an unscannable QR fails
   that claim in the most visible way possible — the customer finds out in
   front of the person they just handed the card to.

   Byte mode, ECC level M (the blueprint's stated floor), versions 1–10,
   full mask selection by penalty. Verified by RS syndrome check: every
   encoded block is a valid Reed–Solomon codeword.
   ═══════════════════════════════════════════════════════════════════════ */
const QR = (() => {
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++){ EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a,b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

  // version → [ecCodewordsPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]  (ECC M)
  const EC = { 1:[10,1,16,0,0], 2:[16,1,28,0,0], 3:[26,1,44,0,0], 4:[18,2,32,0,0], 5:[24,2,43,0,0],
               6:[16,4,27,0,0], 7:[18,4,31,0,0], 8:[22,2,38,2,39], 9:[22,3,36,2,37], 10:[26,4,43,1,44] };
  const ALIGN = { 1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34],
                  7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50] };
  const CAP = { 1:14, 2:26, 3:42, 4:62, 5:84, 6:106, 7:122, 8:152, 9:180, 10:213 };

  function genPoly(n){
    let g = [1];
    for (let i = 0; i < n; i++){
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++){
        // Coefficients are DESCENDING with a leading 1. Getting these two
        // lines the wrong way round builds the reciprocal polynomial: the
        // symbol still looks like a QR and still passes every structural
        // check, and no scanner can read it. Caught by the syndrome test.
        ng[j]   ^= g[j];                       // × x
        ng[j+1] ^= mul(g[j], EXP[i]);          // × α^i
      }
      g = ng;
    }
    return g;
  }
  function rsEncode(data, n){
    const g = genPoly(n), res = new Array(n).fill(0);
    for (const d of data){
      const f = d ^ res[0];
      res.shift(); res.push(0);
      for (let i = 0; i < n; i++) res[i] ^= mul(g[i+1], f);
    }
    return res;
  }
  // Syndrome check — a valid RS codeword evaluates to 0 at α^0..α^(n-1)
  function syndromes(codeword, n){
    const out = [];
    for (let i = 0; i < n; i++){
      let s = 0;
      for (const c of codeword) s = mul(s, EXP[i]) ^ c;
      out.push(s);
    }
    return out;
  }

  const BCH_FMT = f => { let d = f << 10;
    for (let i = 14; i >= 10; i--) if (d & (1 << i)) d ^= 0x537 << (i - 10);
    return ((f << 10) | d) ^ 0x5412; };
  const BCH_VER = v => { let d = v << 12;
    for (let i = 17; i >= 12; i--) if (d & (1 << i)) d ^= 0x1f25 << (i - 12);
    return (v << 12) | d; };

  const MASKS = [
    (r,c)=>((r+c)%2)===0, (r,c)=>(r%2)===0, (r,c)=>(c%3)===0, (r,c)=>((r+c)%3)===0,
    (r,c)=>((((r/2)|0)+((c/3)|0))%2)===0, (r,c)=>(((r*c)%2)+((r*c)%3))===0,
    (r,c)=>((((r*c)%2)+((r*c)%3))%2)===0, (r,c)=>((((r+c)%2)+((r*c)%3))%2)===0
  ];

  function penalty(m){
    const n = m.length; let p = 0;
    const run = (get) => { for (let a = 0; a < n; a++){ let last = -1, len = 0;
      for (let b = 0; b < n; b++){ const v = get(a,b);
        if (v === last) { len++; if (len === 5) p += 3; else if (len > 5) p++; }
        else { last = v; len = 1; } } } };
    run((a,b)=>m[a][b]); run((a,b)=>m[b][a]);
    for (let r = 0; r < n-1; r++) for (let c = 0; c < n-1; c++)
      if (m[r][c]===m[r][c+1] && m[r][c]===m[r+1][c] && m[r][c]===m[r+1][c+1]) p += 3;
    const pat = [1,0,1,1,1,0,1,0,0,0,0];
    const has = (arr,i) => pat.every((v,k)=> arr[i+k] === v);
    for (let a = 0; a < n; a++){
      const row = m[a], col = m.map(r=>r[a]);
      for (let i = 0; i + 11 <= n; i++){ if (has(row,i)) p += 40; if (has(col,i)) p += 40; }
    }
    let dark = 0; for (const row of m) for (const v of row) dark += v;
    p += Math.floor(Math.abs(dark*100/(n*n) - 50)/5)*10;
    return p;
  }

  function encode(text){
    const bytes = new TextEncoder().encode(text);
    let version = 0;
    for (let v = 1; v <= 10; v++) if (bytes.length <= CAP[v]) { version = v; break; }
    if (!version) return null;                         // caller must shorten — see qrPayload()

    const [ecLen, b1, d1, b2, d2] = EC[version];
    const totalData = b1*d1 + b2*d2;
    const countBits = version >= 10 ? 16 : 8;

    // bit stream
    const bits = [];
    const push = (val, len) => { for (let i = len-1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4); push(bytes.length, countBits);
    for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && bits.length < totalData*8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8)
      codewords.push(parseInt(bits.slice(i, i+8).join(''), 2));
    const PAD = [0xEC, 0x11];
    while (codewords.length < totalData) codewords.push(PAD[codewords.length % 2 ? 1 : 0]);

    // blocks
    const blocks = [], ecBlocks = [];
    let off = 0;
    for (let i = 0; i < b1; i++){ blocks.push(codewords.slice(off, off+d1)); off += d1; }
    for (let i = 0; i < b2; i++){ blocks.push(codewords.slice(off, off+d2)); off += d2; }
    for (const blk of blocks) ecBlocks.push(rsEncode(blk, ecLen));

    // interleave
    const out = [];
    const maxD = Math.max(d1, d2 || 0);
    for (let i = 0; i < maxD; i++) for (const blk of blocks) if (i < blk.length) out.push(blk[i]);
    for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) out.push(blk[i]);

    // matrix
    const size = 17 + 4*version;
    const m = Array.from({length:size}, ()=>new Array(size).fill(0));
    const res = Array.from({length:size}, ()=>new Array(size).fill(false));
    const setF = (r,c,v) => { if (r>=0 && c>=0 && r<size && c<size){ m[r][c]=v; res[r][c]=true; } };

    const finder = (R,C) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++){
        const inside = r>=0 && r<=6 && c>=0 && c<=6;
        const ring = inside ? (r===0||r===6||c===0||c===6||(r>=2&&r<=4&&c>=2&&c<=4)) : false;
        setF(R+r, C+c, ring ? 1 : 0);
      }
    };
    finder(0,0); finder(0,size-7); finder(size-7,0);
    for (let i = 8; i < size-8; i++){ setF(6, i, i%2===0?1:0); setF(i, 6, i%2===0?1:0); }
    const ac = ALIGN[version];
    for (const r of ac) for (const c of ac){
      if ((r<=8&&c<=8) || (r<=8&&c>=size-9) || (r>=size-9&&c<=8)) continue;
      for (let dr=-2; dr<=2; dr++) for (let dc=-2; dc<=2; dc++)
        setF(r+dr, c+dc, (Math.max(Math.abs(dr),Math.abs(dc))!==1) ? 1 : 0);
    }
    setF(size-8, 8, 1);                                   // dark module
    for (let i = 0; i < 9; i++){ if (i!==6){ res[8][i]=true; res[i][8]=true; } }
    res[8][8]=true;
    for (let i = 0; i < 8; i++){ res[8][size-1-i]=true; res[size-1-i][8]=true; }
    if (version >= 7) for (let i = 0; i < 18; i++){
      const r = Math.floor(i/3), c = i%3;
      res[size-11+c][r]=true; res[r][size-11+c]=true;
    }

    // data placement (zigzag, right to left, skipping the timing column)
    let bi = 0, up = true;
    const dataBits = [];
    for (const cw of out) for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1);
    for (let col = size-1; col > 0; col -= 2){
      if (col === 6) col--;
      for (let i = 0; i < size; i++){
        const row = up ? size-1-i : i;
        for (const c of [col, col-1]){
          if (res[row][c]) continue;
          m[row][c] = bi < dataBits.length ? dataBits[bi] : 0;
          bi++;
        }
      }
      up = !up;
    }

    // mask selection
    let best = null;
    for (let k = 0; k < 8; k++){
      const t = m.map(r=>r.slice());
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
        if (!res[r][c] && MASKS[k](r,c)) t[r][c] ^= 1;
      const fmt = BCH_FMT((0b00 << 3) | k);
      for (let i = 0; i < 15; i++){
        const b = (fmt >> i) & 1;
        if (i < 6) t[8][i] = b; else if (i < 8) t[8][i+1] = b;
        else if (i === 8) t[7][8] = b; else t[14-i][8] = b;
        if (i < 8) t[size-1-i][8] = b; else t[8][size-15+i] = b;
      }
      t[size-8][8] = 1;
      if (version >= 7){
        const vi = BCH_VER(version);
        for (let i = 0; i < 18; i++){
          const b = (vi >> i) & 1, r = Math.floor(i/3), c = i%3;
          t[size-11+c][r] = b; t[r][size-11+c] = b;
        }
      }
      const p = penalty(t);
      if (!best || p < best.p) best = { p, m:t, mask:k };
    }
    return { matrix:best.m, size, version, mask:best.mask, bytes:bytes.length,
             blocks, ecBlocks, ecLen, capacity:CAP[version] };
  }

  /* Encoding is by far the most expensive thing generation does — mask
     selection alone builds eight full matrices and scores each one against
     four penalty rules — and it depends on the payload text and nothing else.
     A brief that enumerates 360 candidates asks for at most five distinct
     payloads: the four rungs of the vCard ladder plus the short-link
     fallback. Sixty-four entries is far more than one brief needs and still
     covers a bulk run's worth of distinct people before the oldest is
     dropped. Nothing here is derived from a font measurement, so this cache
     survives webfont loading; only geometry does. */
  const _qrCache = memo(64);
  const encodeMemo = text => _qrCache.get(text, () => encode(text));

  return { encode: encodeMemo, syndromes, CAP };
})();

/* vCard payload with a CONTENT LADDER — the same idea as the type fit ladder,
   applied to data. If the full card will not fit the largest QR we allow, we
   drop the least important field and try again, and we say what we dropped.
   The alternative — silently truncating, or emitting an oversized QR whose
   modules fall below the scannable size — is exactly the kind of quiet
   failure this system exists to prevent. */
function qrPayload(C, availMm, share){
  const esc = s => String(s||'').replace(/([,;\\])/g, '\\$1');
  const build = (lvl) => {
    const L = ['BEGIN:VCARD','VERSION:3.0', `FN:${esc(C.name)}`];
    if (lvl <= 3 && C.company) L.push(`ORG:${esc(C.company)}`);
    if (lvl <= 3 && C.role)    L.push(`TITLE:${esc(C.role)}`);
    if (C.p1)    L.push(`TEL;TYPE=CELL:${esc(C.p1)}`);
    if (lvl <= 2 && C.p2) L.push(`TEL;TYPE=CELL:${esc(C.p2)}`);
    if (C.email) L.push(`EMAIL:${esc(C.email)}`);
    if (lvl <= 2 && C.web)  L.push(`URL:${esc(C.web)}`);
    if (lvl <= 1 && C.addr) L.push(`ADR;TYPE=WORK:;;${esc(C.addr)};;;;`);
    L.push('END:VCARD');
    return L.join('\r\n');
  };
  const dropped = [[], ['address'], ['address','second number','website'],
                   ['address','second number','website','company','role']];

  /* The ladder is driven by PHYSICAL SPACE, not just capacity. A full vCard
     encodes fine at 213 bytes — but at a 15 mm slot that is a version-6
     symbol with 0.33 mm modules, which no phone camera will read across a
     desk. Capacity is not the constraint; module size is.

     Last rung is a short URL. This is what real cards do, and it is the
     right answer: ~24 bytes fits version 1–2 with large modules, and the
     link is ours, so a scan is measurable (blueprint §16). It requires the
     service to exist, so until Phase 2 it is reported, not silently used. */
  /* Conservative. 0.5 mm is the general-purpose print floor; a good offset
     press on coated stock can hold 0.35–0.4 mm. Make this per-press once
     `presses.capabilities_json` exists — until then, err toward scannable. */
  const MIN_MODULE = 0.5;
  const fits = (qr) => !availMm || (availMm / (qr.size + 8)) >= MIN_MODULE;

  for (let lvl = 1; lvl <= 4; lvl++){
    const text = build(lvl);
    const qr = QR.encode(text);
    if (qr && fits(qr)) return { text, qr, dropped:dropped[lvl-1], level:lvl, kind:'vcard' };
  }
  // URL fallback — deterministic short code from the content, no service call
  /* A link is only honest once it resolves. If the design has been saved,
     the QR carries its real URL; if it has not, the symbol is still drawn so
     the layout is truthful, but preflight marks it PENDING and blocks the
     idea of printing it. A card whose QR 404s is a card that fails in the
     recipient's hand. */
  const saved = share && share.code && share.origin;
  const url = saved ? `${share.origin}/c/${share.code}`
                    : `${(share && share.origin) || 'https://cardworks.bd'}/c/unsaved`;
  const qr = QR.encode(url);
  if (qr && fits(qr)) return { text:url, qr, dropped:['everything — the QR carries a link instead'],
                   level:5, kind:'url', pending:!saved,
                   note: saved
                     ? 'Short-link QR resolving to the saved card.'
                     : 'Short-link QR — save the design to activate this link before printing.' };
  /* Even the shortest payload cannot be scanned at this size. Emit NOTHING.
     A QR that does not scan is worse than no QR: it looks like a working
     feature to everyone including the person holding the card. */
  return null;
}

/* ═══════════════════════════ MEASUREMENT ═══════════════════════════
   Real font metrics via canvas, measured at a large size and scaled.
   The renderer draws with the same font engine, so measurement and
   rendering agree — that is what makes preflight trustworthy.        */
const mctx = document.createElement('canvas').getContext('2d');
const REF = 200;
/* The shell drops this cache the moment `document.fonts.ready` resolves,
   because anything measured against a fallback face is measured against the
   wrong face. Nothing else in the engine outlives a call while holding a
   measurement, so that one clear is the whole invalidation story.

   The bound is far above any single operation's working set — one brief fills
   about 340 entries and a 200-row bulk run about 3,800 — so it cannot thrash
   inside the work it exists to speed up. It exists for the session that runs
   for an hour, where the ladder's track and step rungs make a fresh key on
   every increment and the map would otherwise only ever grow. */
const _mcache = memo(16384);
function measure(text, family, weight, trackEm){
  return _mcache.get(text+'|'+family+'|'+weight+'|'+trackEm, () => {
    mctx.font = `${weight} ${REF}px ${family}`;
    const m = mctx.measureText(text);
    const gaps = Math.max(0, [...text].length - 1);
    return {
      w:   m.width/REF + trackEm*gaps,
      asc: (m.fontBoundingBoxAscent  ?? m.actualBoundingBoxAscent  ?? REF*0.80)/REF,
      desc:(m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? REF*0.20)/REF
    };
  });
}

function wrapText(text, family, weight, trackEm, maxWmm, sizeMm, maxLines){
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words){
    const test = cur ? cur+' '+w : w;
    if (measure(test, family, weight, trackEm).w * sizeMm <= maxWmm || !cur) cur = test;
    else { lines.push(cur); cur = w; if (lines.length >= maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const widest = Math.max(...lines.map(l => measure(l, family, weight, trackEm).w * sizeMm), 0);
  return { lines, widest, overflow: lines.join(' ') !== words.join(' ') };
}

/* ═══════════════════════════ THE FIT LADDER ═══════════════════════════
   Rungs, in order: track → step → wrap → abbreviate → reduceRoutes → drop.
   Walks until the content fits its slot, or reports failure. A required
   slot that cannot fit ELIMINATES the layout. Nothing overflows, ever.
   This is the single mechanism a competitor cannot copy without
   rebuilding their editor.                                              */
function fitSlot(slot, rawLines, ctx, geom){
  const script = slot.forcedScript || scriptOf(rawLines.join(' '));
  const sm = SCRIPTS[script];
  const family = script === 'bangla' ? ctx.type.bangla : ctx.type.latin;
  /* `slot.weight` is a role name from the layout record. A per-slot override
     may pin an actual numeric weight instead — that is how the part editor
     makes "set this line bolder" a real change rather than a recorded one
     that never reaches the page. Absent, this resolves exactly as before. */
  const weight = typeof slot.weightNum === 'number' ? slot.weightNum
               : slot.weight === 'name' ? ctx.type.weightName
               : slot.weight === 'display' ? 800 : 400;

  // Fit against the CLAMPED geometry, so the safe area constrains the text
  // rather than merely being checked after the fact.
  const boxW = geom.w, boxH = geom.h;
  const maxLines = slot.maxLines || (slot.kind === 'contact' ? 8 : 1);

  const minPt = Math.max(sm.minPt, SLOTDEFS[slot.ref]?.minPt ?? 0);
  /* The floor is enforced at AUTHORING time as well as at fit time. A layout
     record whose scale would resolve below the print floor is silently raised
     to the floor rather than rendered illegally — so a designer cannot author
     an unprintable card, and the same record stays legal when the script
     changes (Bangla floors 1.25pt higher than Latin) or the trim shrinks. */
  /* A pinned size still goes through the floor and still goes through the fit
     ladder below — pinning chooses the starting point, it does not exempt the
     text from having to fit or from the per-script minimum. That is what keeps
     a hand-set size inside the print guarantee. */
  let sizePt = typeof slot.sizePtPinned === 'number'
    ? Math.max(minPt, slot.sizePtPinned)
    : Math.max(minPt, ctx.baseNamePt * (slot.scale ?? .5) * sm.opticalScale * ctx.densityMul);
  let track  = Math.max(sm.tracking.min, Math.min(slot.track ?? 0, sm.tracking.max));
  let lines  = rawLines.slice();
  const applied = [];
  const ladder = slot.fit || ['track','step'];

  /* `inline` contact blocks join their routes into one run separated by a
     middot. The routes stay an ARRAY internally so the reduceRoutes rung can
     still drop the lowest-ranked ones — only the display form is joined. */
  const disp = () => slot.mode === 'inline' ? [lines.join('  ·  ')] : lines;

  const check = () => {
    const sizeMm = sizePt * PT;
    const L = disp();
    let widest = 0;
    for (const l of L) widest = Math.max(widest, measure(l, family, weight, track).w * sizeMm);
    const m0 = measure(L[0] || 'X', family, weight, track);
    const lh = sizeMm * sm.lineHeight;
    const h = (L.length - 1) * lh + (m0.asc + m0.desc + sm.ascentPad) * sizeMm;
    return { fits: widest <= boxW + 0.01 && h <= boxH + 0.01, widest, h, lh,
             asc:(m0.asc + sm.ascentPad) * sizeMm };
  };

  let r = check();
  for (const rung of ladder){
    if (r.fits) break;

    if (rung === 'track'){
      const floor = sm.tracking.min;
      while (!r.fits && track > floor){ track = Math.max(floor, track - 0.01); r = check(); }
      if (track !== (slot.track ?? 0)) applied.push('track→'+track.toFixed(2)+'em');
    }

    else if (rung === 'step'){
      const before = sizePt;
      while (!r.fits && sizePt > minPt){ sizePt = Math.max(minPt, sizePt * 0.96); r = check(); }
      if (sizePt < before - 0.01) applied.push('step→'+sizePt.toFixed(1)+'pt');
    }

    else if (rung === 'wrap'){
      if (lines.length === 1 && maxLines > 1){
        const w = wrapText(lines[0], family, weight, track, boxW, sizePt*PT, maxLines);
        if (w.lines.length > 1){ lines = w.lines; r = check(); applied.push('wrap→'+lines.length+' lines'); }
      }
    }

    else if (rung === 'abbrev'){
      const before = lines.join('|');
      lines = lines.map(l => { for (const [re, to] of ABBREV) l = l.replace(re, to); return l; });
      if (lines.join('|') !== before){ r = check(); applied.push('abbreviate'); }
    }

    else if (rung === 'reduceRoutes'){
      while (!r.fits && lines.length > 1){ lines.pop(); r = check(); }
      if (lines.length < rawLines.length) applied.push('routes '+rawLines.length+'→'+lines.length+' (rest to back/QR)');
    }

    else if (rung === 'drop'){
      if (!SLOTDEFS[slot.ref]?.required){ return { dropped:true, applied:[...applied,'DROP'], script, sizePt }; }
    }
    r = check();
  }

  return { fits:r.fits, dropped:false, lines:disp(), routes:lines, sizePt, track, family, weight, script,
           lineHeight:r.lh, ascent:r.asc, width:r.widest, height:r.h, applied,
           minPt, boxW, boxH };
}

/* ═══════════════════════════ THE COMPOSER ═══════════════════════════ */
const DENSITY = { airy:0.94, balanced:1.0, tight:1.06 };

function contentFor(slot, C, face){
  const bn = face.forceScript === 'bangla';
  const pick = (en, b) => (bn && b) ? b : en;
  switch (slot.ref){
    case 'name': {
      let n = pick(C.name, C.bname);
      if (C.quals && !bn) n = n; // quals ride in role for fit-ladder pressure
      return [n];
    }
    case 'role': {
      const r = pick(C.role, C.brole);
      return [ C.quals && !bn ? r + ' · ' + C.quals : r ];
    }
    case 'company': return [ pick(C.company, C.bcompany) ];
    case 'contact': {
      const d = bn ? toBnDigits : (x=>x);
      return [C.p1 && d(C.p1), C.p2 && d(C.p2), C.email, C.web, C.addr].filter(Boolean);
    }
    case 'mark': return [ (pick(C.company,C.bcompany)||pick(C.name,C.bname)||'N').trim()[0] ];
    case 'qr':   return ['qr'];
    default:     return [ slot.text || '' ];
  }
}

/* Palette resolution. Several palettes declare `panel` identical to `bg`
   (a dark palette whose panel is also dark). Layouts whose structure IS the
   panel — Split, Band — would then render as a flat field and silently lose
   their composition. Rather than forbid the combination, resolve it: an
   invisible panel falls back to the accent. This is the kind of interaction
   that only shows up when layouts and palettes are combinatorial, which is
   exactly why they must be data the engine can reason about. */
function resolvePalette(id){
  const pal = { ...PALETTES.find(p=>p.id===id) };
  if (String(pal.panel).toLowerCase() === String(pal.bg).toLowerCase()) pal.panel = pal.accent;
  return pal;
}

/* The half of composition that colour has nothing to do with.

   Geometry comes from the trim, the grid, the type system's metrics and the
   content; the palette only decides what gets painted into boxes this
   function has already decided the position and size of. Keeping the two
   apart is not tidiness — it is what lets generation compose a layout once
   and rank it against all eight palettes, instead of running the fit ladder
   eight times to arrive at the same millimetres. The separation is enforced
   structurally rather than by comment: no palette reaches this scope at all,
   so a future check that wanted one would throw on a name that is not there
   rather than quietly make the reuse wrong. */
function composeGeometry(spec){
  /* The trim record is shared and immutable; the safe area is not a property
     of the trim alone, so the format this composition works against is the
     trim with THIS job's safe area resolved onto it. Everything downstream —
     `box()`, preflight, the renderer's guides, the print writer's TrimBox
     note — already reads `fmt.safe`, so resolving it once here is what keeps
     the three of them from disagreeing about where the content may sit. A
     plain card resolves to the record's own figure and is handed the shared
     record itself, so nothing about it can move. */
  const trim = FORMATS.find(f=>f.id===spec.format);
  const safe = safeFor(trim, spec);
  const fmt  = safe === trim.safe ? trim : { ...trim, safe };
  const type = TYPE_SYSTEMS.find(t=>t.id===spec.type);
  const face = LAYOUTS.find(l=>l.id===spec.layout);

  const grid = gridFor(fmt);
  const ctx  = {
    fmt, type, grid,
    cellW: fmt.w/grid.cols, cellH: fmt.h/grid.rows,
    // base size follows the SHORT edge — a portrait card is not a landscape
    // card rotated, and its name cannot be set at landscape scale
    baseNamePt: Math.min(fmt.w, fmt.h) >= 50 ? 13.5 : 11.5,
    densityMul: DENSITY[spec.density] || 1
  };

  const out = [], trace = [], dropped = [];
  let eliminated = null;

  const faceSlots = slotsFor(face, fmt.orientation);
  if (!faceSlots){
    return { fmt, type, face, elements:[], trace:[], dropped:[],
      eliminated:`${face.name} has no ${fmt.orientation} composition — it is authored for landscape only` };
  }

  /* ── Per-slot style overrides ──────────────────────────────────────────
     An optional channel used by the part editor, where someone restyles a
     card they uploaded. It carries what a part IS — colour, weight, size,
     case, alignment — and deliberately carries no position: geometry stays
     this function's output so the card cannot be made unprintable from
     outside. Merging happens BEFORE `box()` and `fitSlot()`, so an overridden
     size or weight is measured and laddered like any other, rather than being
     painted on afterwards at a width nothing checked.

     When `spec.slotStyle` is absent this is a no-op and the composition is
     byte-identical to what it was before the channel existed. */
  const styleFor = (ref) => (spec.slotStyle && spec.slotStyle[ref]) || null;
  const restyle = (slot) => {
    const o = styleFor(slot.ref);
    if (!o) return slot;
    const next = { ...slot };
    if (typeof o.upper === 'boolean') next.upper = o.upper;
    if (typeof o.color === 'string') next.color = o.color;
    if (typeof o.align === 'string') next.align = o.align;
    if (typeof o.weightNum === 'number') next.weightNum = o.weightNum;
    if (typeof o.sizePt === 'number') next.sizePtPinned = o.sizePt;
    return next;
  };

  for (const rawSlot of faceSlots){
    const slot = restyle(rawSlot);
    if (['rule','panel','gridlines'].includes(slot.kind)){
      out.push({ ...slot, geom: box(slot, ctx) }); continue;
    }
    if (slot.kind === 'ghost'){
      out.push({ ...slot, geom: box(slot, ctx), glyph: contentFor({ref:'mark'}, spec.content, face)[0] });
      continue;
    }
    if (slot.kind === 'qr'){
      const g = box(slot, ctx);
      const pay = qrPayload(spec.content, Math.min(g.w, g.h), spec.share);
      if (!pay){
        trace.push({ slot:'qr', applied:['omitted'],
          note:`no payload scannable at ${Math.min(g.w,g.h).toFixed(1)} mm — a QR that cannot be read is worse than none` });
        continue;
      }
      // Quiet zone is 4 modules on every side and is part of the symbol,
      // not padding — a QR printed without it does not scan.
      const moduleMm = Math.min(g.w, g.h) / (pay.qr.size + 8);
      out.push({ ...slot, geom:g, qr:pay.qr, payload:pay,
                 modules:pay.qr.size, moduleMm });
      if (pay.dropped.length)
        trace.push({ slot:'qr', applied:[`vCard reduced: dropped ${pay.dropped.join(', ')}`],
                     note:`to keep modules at ${moduleMm.toFixed(2)} mm` });
      continue;
    }
    if (slot.kind === 'mark' || slot.kind === 'mono' || slot.kind === 'bigmono'){
      const g = box(slot, ctx);
      const logo = spec.content.logo;
      out.push({ ...slot, geom:g, glyph: contentFor(slot, spec.content, face)[0],
                 logo: (logo && logo.ok && slot.kind === 'mark') ? logo : null });
      continue;
    }

    /* The case transform has to happen BEFORE measurement. Measuring
        "Popular Diagnostic Centre" and rendering "POPULAR DIAGNOSTIC CENTRE"
        understates the width by ~12% — the text then renders outside its
        slot and, on a right-anchored slot, straight over its neighbour.
        Preflight could not catch it: it compares slot boxes, and the boxes
        were never overlapping. Only the glyphs were. */
    let raw = contentFor(slot, spec.content, face).filter(Boolean);
    if (slot.upper) raw = raw.map(x => String(x).toUpperCase());
    if (!raw.length || !raw[0]){
      if (SLOTDEFS[slot.ref]?.required){ eliminated = `${slot.ref} is required and empty`; }
      continue;
    }
    const s2 = face.forceScript ? { ...slot, forcedScript: face.forceScript } : slot;
    const geom = box(slot, ctx);
    const fit = fitSlot(s2, raw, ctx, geom);

    if (fit.dropped){ dropped.push(slot.ref); trace.push({ slot:slot.ref, applied:fit.applied, note:'dropped — not required' }); continue; }
    if (!fit.fits){
      if (SLOTDEFS[slot.ref]?.required || slot.priority === 1){
        eliminated = `${slot.ref} cannot fit — ladder exhausted at ${fit.sizePt.toFixed(1)}pt (floor ${fit.minPt}pt)`;
      }
      trace.push({ slot:slot.ref, applied:[...fit.applied,'FAILED'], note:'exceeded slot at minimum size' });
      continue;
    }
    out.push({ ...slot, geom, fit });
    if (fit.applied.length) trace.push({ slot:slot.ref, applied:fit.applied });
  }

  return { fmt, type, face, elements: out, trace, dropped, eliminated };
}

/* A composition, painted. The shape returned here has not changed and must
   not: it is what preflight, the renderer, the PDF writer and the parity
   suite all read. */
function compose(spec){
  const g = composeGeometry(spec);
  return { spec, fmt:g.fmt, pal:resolvePalette(spec.palette), type:g.type, face:g.face,
           elements:g.elements, trace:g.trace, dropped:g.dropped, eliminated:g.eliminated };
}

/* Grid units → millimetres.

   Content slots are CLAMPED into the safe area; grounds (panel, flood,
   gridlines, ghost mark) are not, because they are meant to bleed. This is
   what makes a layout record trim-agnostic: the same 12 × 8 record is legal
   at 89 × 51, at 51 × 89 portrait and at 55 × 55 square, because the composer
   — not the designer — is responsible for the safe area at every trim.

   `ctx.fmt.safe` is this job's safe area, already escalated for a registered
   finish or a die by `safeFor`. Content is PLACED against it here rather than
   merely checked against it afterwards, which is the difference between a
   foiled card that composes tighter and one that composes wrong and is then
   told so. */
const BLEEDS_KIND = { panel:1, gridlines:1, ghost:1 };
function box(slot, ctx){
  const g = { x:slot.box[0]*ctx.cellW, y:slot.box[1]*ctx.cellH,
              w:slot.box[2]*ctx.cellW, h:slot.box[3]*ctx.cellH };
  if (BLEEDS_KIND[slot.kind]) return g;
  const s = ctx.fmt.safe;
  const x0 = Math.max(g.x, s), y0 = Math.max(g.y, s);
  const x1 = Math.min(g.x + g.w, ctx.fmt.w - s), y1 = Math.min(g.y + g.h, ctx.fmt.h - s);
  return { x:x0, y:y0, w:Math.max(0, x1-x0), h:Math.max(0, y1-y0) };
}

/* ═══════════════════════════ THE RENDERER ═══════════════════════════
   ONE function. Switches on slot.kind (a generic primitive), never on a
   layout id. Twelve layouts, one renderer. Output is SVG in millimetres —
   the same geometry a PDF/X-4 writer consumes.                          */
let _clipSeq = 0;
function renderSVG(c, opt={}){
  if (!c || c.eliminated) return null;
  const { fmt, pal } = c;
  /* Rounded corners are a die-cut, not a CSS flourish: the die is a one-off
     charge and the radius must not eat into the safe area. The artwork is
     clipped to the trim shape so a full-bleed ground follows the corner. */
  const rad = Math.max(0, Math.min(6, Number(c.spec.corner) || 0));
  const showGuides = opt.guides;
  const esc = s => String(s).replace(/[&<>]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
  const col = k => pal[k] || k;
  let body = `<rect x="0" y="0" width="${fmt.w}" height="${fmt.h}" rx="${rad}" ry="${rad}" fill="${col('bg')}"/>`;

  for (const el of c.elements){
    const g = el.geom, C = col(el.color);
    switch (el.kind){
      case 'panel':
        body += `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" fill="${C}"/>`; break;
      case 'rule':
        body += `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${Math.max(g.h,0.18)}" fill="${C}"/>`; break;
      case 'gridlines': {
        let p=''; const gr = gridFor(fmt);
        for (let i=1;i<gr.cols;i++){ const x=i*fmt.w/gr.cols; p+=`M${x} 0V${fmt.h}`; }
        for (let j=1;j<gr.rows;j++){ const y=j*fmt.h/gr.rows; p+=`M0 ${y}H${fmt.h*0+fmt.w}`; }
        body += `<path d="${p}" stroke="${C}" stroke-width="0.08" opacity=".55" fill="none"/>`; break; }
      case 'ghost':
        body += `<text x="${g.x+g.w/2}" y="${g.y+g.h*0.86}" font-family="${c.type.latin}" font-weight="800"
                  font-size="${g.h}" fill="${C}" opacity=".14" text-anchor="middle">${esc(el.glyph||'N')}</text>`; break;
      case 'mark':
        if (el.logo){
          // preserveAspectRatio keeps the customer's mark undistorted — a
          // stretched logo is a brand complaint, not a layout preference
          body += `<image x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}"
                    preserveAspectRatio="xMidYMid meet" href="${el.logo.dataUrl}"/>`;
        } else {
          body += `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" fill="none" stroke="${C}" stroke-width="0.5"/>
                 <text x="${g.x+g.w/2}" y="${g.y+g.h*0.72}" font-family="${c.type.latin}" font-weight="700"
                  font-size="${g.h*0.58}" fill="${C}" text-anchor="middle">${esc(el.glyph||'N')}</text>`;
        }
        break;
      case 'mono': case 'bigmono':
        body += `<text x="${g.x+g.w/2}" y="${g.y+g.h*0.80}" font-family="${c.type.latin}" font-weight="700"
                  font-size="${g.h*0.9}" fill="${C}" text-anchor="middle">${esc(el.glyph||'N')}</text>`; break;
      case 'qr': {
        if (!el.qr) break;
        const n = el.qr.size, m = el.moduleMm, o = m*4;   // 4-module quiet zone
        body += `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" fill="${col('bg')}"/>`;
        // One path for the whole symbol — fewer nodes, and it separates
        // cleanly as a single object when a press pulls the black plate.
        let d = '';
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
          if (el.qr.matrix[i][j])
            d += `M${(g.x+o+j*m).toFixed(3)} ${(g.y+o+i*m).toFixed(3)}h${m.toFixed(3)}v${m.toFixed(3)}h-${m.toFixed(3)}z`;
        body += `<path d="${d}" fill="${C}" shape-rendering="crispEdges"/>`;
        break; }
      case 'text': case 'static': case 'contact': {
        const f = el.fit; if (!f) break;
        const sizeMm = f.sizePt*PT;
        const anchor = el.align==='center'?'middle':el.align==='right'?'end':'start';
        const ax = el.align==='center'? g.x+g.w/2 : el.align==='right'? g.x+g.w : g.x;
        f.lines.forEach((line,i)=>{
          const txt = line;                 // already cased at compose time
          const y = g.y + f.ascent + i*f.lineHeight;
          body += `<text x="${ax}" y="${y}" font-family="${f.family}" font-weight="${f.weight}"
                    font-size="${sizeMm}" letter-spacing="${(f.track*sizeMm).toFixed(3)}"
                    fill="${C}" text-anchor="${anchor}"
                    xml:lang="${f.script==='bangla'?'bn':'en'}">${esc(txt)}</text>`;
        });
        break; }
    }
  }

  if (showGuides){
    body += `<rect x="${fmt.safe}" y="${fmt.safe}" width="${fmt.w-2*fmt.safe}" height="${fmt.h-2*fmt.safe}"
              fill="none" stroke="#00a3ff" stroke-width="0.15" stroke-dasharray="0.8 0.6"/>`;
    for (const el of c.elements) if (el.fit) {
      const g=el.geom;
      body += `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" fill="none" stroke="#ec3013" stroke-width="0.1" opacity=".5"/>`;
    }
  }
  if (rad > 0){
    const cid = 'cwclip' + (++_clipSeq);
    body = `<defs><clipPath id="${cid}"><rect x="0" y="0" width="${fmt.w}" height="${fmt.h}"
      rx="${rad}" ry="${rad}"/></clipPath></defs><g clip-path="url(#${cid})">${body}</g>`;
  }
  return `<svg class="card" viewBox="0 0 ${fmt.w} ${fmt.h}" xmlns="http://www.w3.org/2000/svg"
           style="aspect-ratio:${fmt.w}/${fmt.h}">${body}</svg>`;
}

/* ═══════════════════════════ PREFLIGHT ═══════════════════════════
   Every check is arithmetic over composed geometry in millimetres.
   No AI, no heuristics, no opinion. Blocking findings refuse export. */
/* Both of these turn a hex string into one number, and both are asked the
   same handful of questions over and over: a library of eight palettes offers
   perhaps thirty distinct colours, and preflight runs per candidate. The
   sRGB transfer curve is four `Math.pow` calls per colour, which is why this
   is worth remembering at all. Colour has nothing to do with type, so neither
   cache is invalidated by webfonts loading. */
const _lumCache = memo(256), _tacCache = memo(256);
function lum(hex){
  return _lumCache.get(hex, () => {
    const c = hex.replace('#',''); const n = c.length===3 ? c.split('').map(x=>x+x).join('') : c;
    const v = [0,2,4].map(i=>parseInt(n.substr(i,2),16)/255)
                     .map(x=> x<=0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055,2.4));
    return 0.2126*v[0]+0.7152*v[1]+0.0722*v[2];
  });
}
const contrast = (a,b) => { const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
function tac(hex){ // naive RGB→CMYK total area coverage, good enough to catch the 300% cliff
  return _tacCache.get(hex, () => {
    const c=hex.replace('#',''); const n=c.length===3?c.split('').map(x=>x+x).join(''):c;
    const [r,g,b]=[0,2,4].map(i=>parseInt(n.substr(i,2),16)/255);
    const k=1-Math.max(r,g,b); if(k>=1) return 100;
    return Math.round(((1-r-k)/(1-k)+(1-g-k)/(1-k)+(1-b-k)/(1-k)+k)*100);
  });
}
function overlaps(a,b){ return a.x < b.x+b.w-0.1 && b.x < a.x+a.w-0.1 && a.y < b.y+b.h-0.1 && b.y < a.y+a.h-0.1; }

function preflight(c){
  if (!c || c.eliminated) return [{ s:'fail', label:'Layout eliminated', note:c?.eliminated||'no composition' }];
  const F=[], { fmt, pal } = c;
  const texts = c.elements.filter(e=>e.fit);

  // 1 — safe area
  const outside = texts.filter(e =>
    e.geom.x < fmt.safe-0.01 || e.geom.y < fmt.safe-0.01 ||
    e.geom.x+e.geom.w > fmt.w-fmt.safe+0.01 || e.geom.y+e.geom.h > fmt.h-fmt.safe+0.01);
  F.push(outside.length
    ? { s:'fail', label:`${outside.length} element(s) outside the ${fmt.safe} mm safe area`, note:outside.map(e=>e.ref).join(', ')+' — will be cut by trim drift' }
    : { s:'pass', label:`All elements inside the ${fmt.safe} mm safe area`, note:`closest sits at ${Math.min(...texts.map(e=>Math.min(e.geom.x,e.geom.y,fmt.w-e.geom.x-e.geom.w,fmt.h-e.geom.y-e.geom.h))).toFixed(1)} mm` });

  /* 2 — overlap. Compare RENDERED extents, not reserved slot boxes.
     A right- or centre-anchored line sits inside its box but not at its
     left edge, so two boxes that never intersect can still put glyphs on
     top of each other — which is exactly how the uppercase measurement bug
     reached the screen without tripping a single check. Marks and QR
     symbols are included, because they are what text usually collides with. */
  const extentOf = e => {
    if (!e.fit) return { ref:e.ref, ...e.geom };
    const w = e.fit.width;
    const x = e.align === 'center' ? e.geom.x + (e.geom.w - w)/2
            : e.align === 'right'  ? e.geom.x + e.geom.w - w
            : e.geom.x;
    return { ref:e.ref, x, y:e.geom.y, w, h:e.geom.h };
  };
  const solid = c.elements
    .filter(e => e.fit || ['mark','mono','bigmono','qr'].includes(e.kind))
    .map(extentOf);
  const hits=[];
  for (let i=0;i<solid.length;i++) for (let j=i+1;j<solid.length;j++)
    if (overlaps(solid[i], solid[j])) hits.push(solid[i].ref+' × '+solid[j].ref);
  F.push(hits.length ? { s:'fail', label:'Elements overlap', note:hits.join(', ') }
                     : { s:'pass', label:'No element overlaps another', note:'as rendered, including marks and QR' });

  // 3 — type floor, per script
  const small = texts.filter(e => e.fit.sizePt < e.fit.minPt - 0.05);
  const min = texts.length ? Math.min(...texts.map(e=>e.fit.sizePt)) : 0;
  const hasBn = texts.some(e=>e.fit.script==='bangla');
  F.push(small.length
    ? { s:'fail', label:`Type below the print floor`, note:small.map(e=>`${e.ref} ${e.fit.sizePt.toFixed(1)}pt < ${e.fit.minPt}pt`).join(', ') }
    : { s:'pass', label:`Smallest type is ${min.toFixed(1)} pt`, note: hasBn ? 'Bangla floor 7.5 pt — conjuncts collapse below this on 300 gsm art card' : 'Latin floor 6.0 pt' });

  // 4 — hierarchy
  const nm=texts.find(e=>e.ref==='name'), rl=texts.find(e=>e.ref==='role');
  if (nm&&rl){ const ratio=nm.fit.sizePt/rl.fit.sizePt;
    F.push(ratio>=1.5 ? { s:'pass', label:`Hierarchy is clear — name is ${ratio.toFixed(1)}× the role`, note:'' }
                      : { s:'review', label:`Weak hierarchy — name only ${ratio.toFixed(1)}× the role`, note:'target ≥ 1.5×' }); }

  // 5 — contrast, measured per element against the ground it ACTUALLY sits on
  //     (a text element over a flood or panel region is not on pal.bg)
  const panels = c.elements.filter(e=>e.kind==='panel');
  const groundOf = e => {
    const inside = panels.filter(p =>
      e.geom.x >= p.geom.x-0.01 && e.geom.y >= p.geom.y-0.01 &&
      e.geom.x+e.geom.w <= p.geom.x+p.geom.w+0.01 && e.geom.y+e.geom.h <= p.geom.y+p.geom.h+0.01);
    return inside.length ? (pal[inside[inside.length-1].color] || pal.bg) : pal.bg;
  };
  let worstCr = Infinity, worstRef = '';
  for (const e of texts){
    const cr = contrast(pal[e.color] || e.color, groundOf(e));
    if (cr < worstCr){ worstCr = cr; worstRef = e.ref; }
  }
  if (texts.length) F.push(worstCr>=4.5
    ? { s:'pass', label:`Lowest text contrast ${worstCr.toFixed(1)}:1 (${worstRef})`, note:'' }
    : { s:'review', label:`Lowest text contrast ${worstCr.toFixed(1)}:1 (${worstRef})`, note:'legible in the hand, weak under tube light — the normal reading condition in a Dhaka office' });

  // 6 — ink coverage
  const worst = Math.max(tac(pal.bg), tac(pal.panel||pal.bg), tac(pal.accent));
  F.push(worst<=300 ? { s:'pass', label:`Total ink coverage ${worst}% — under the 300% limit`, note:'' }
                    : { s:'fail', label:`Total ink coverage ${worst}%`, note:'will offset onto the next sheet; reduce to ≤300%' });

  // 7 — Bangla capability of the type system
  if (hasBn) F.push(c.type.banglaOk
    ? { s:'pass', label:'Type system covers Bangla conjuncts', note:c.type.name }
    : { s:'fail', label:'Type system has no Bangla family', note:'conjuncts will render as tofu boxes' });

  // 8 — QR physical constraints, against the REAL symbol
  const qr = c.elements.find(e=>e.kind==='qr');
  if (qr){
    const m = qr.moduleMm;
    F.push(m>=0.5
      ? { s:'pass', label:`QR module ${m.toFixed(2)} mm — version ${qr.qr.version}, ${qr.modules}×${qr.modules}`,
          note:`ECC M, mask ${qr.qr.mask}, ${qr.qr.bytes}/${qr.qr.capacity} bytes used. Scannable at arm’s length on a mid-range Android camera.` }
      : { s:'fail', label:`QR module ${m.toFixed(2)} mm is below 0.5 mm`,
          note:`version ${qr.qr.version} needs ${((qr.qr.size+8)*0.5).toFixed(0)} mm of card; enlarge the slot or shorten the contact data` });
    const contrastQR = contrast(pal[qr.color] || pal.fg, pal.bg);
    F.push(contrastQR >= 3
      ? { s:'pass', label:`QR contrast ${contrastQR.toFixed(1)}:1`, note:'' }
      : { s:'fail', label:`QR contrast ${contrastQR.toFixed(1)}:1 is too low to scan`, note:'a QR needs a hard light/dark boundary — never print it in an accent colour' });
    if (qr.payload.kind === 'url' && qr.payload.pending)
      F.push({ s:'fail', label:'QR link is not active yet',
               note:'This design has not been saved, so the link the QR encodes does not resolve. Save it before printing.' });
    else if (qr.payload.kind === 'url')
      F.push({ s:'review', label:'QR carries a short link, not a vCard',
               note:`${qr.payload.note} A full vCard at this slot size would need ${(0.5*(33+8)).toFixed(0)} mm; the slot is ${Math.min(qr.geom.w,qr.geom.h).toFixed(1)} mm.` });
    else if (qr.payload.dropped.length)
      F.push({ s:'review', label:'vCard reduced to fit the QR',
               note:`dropped: ${qr.payload.dropped.join(', ')} — the printed card still carries them` });
  }

  // 8b — logo vs finish compatibility
  const logoEl = c.elements.find(e=>e.logo);
  if (logoEl && !logoEl.logo.vector)
    F.push({ s:'review', label:'Raster logo cannot be foiled or embossed',
             note:'those plates need a vector path — supply SVG/EPS, or keep the logo to ink only' });

  // 9 — dropped content, reported honestly
  if (c.dropped.length) F.push({ s:'review', label:`Dropped to fit: ${c.dropped.join(', ')}`, note:'the composer removed these rather than overflow — put them on the back or behind the QR' });
  const reduced = c.trace.find(t=>t.applied.some(a=>a.startsWith('routes')));
  if (reduced) F.push({ s:'review', label:'Contact routes reduced', note:reduced.applied.find(a=>a.startsWith('routes')) });

  // 10 — bleed
  F.push({ s:'pass', label:`Bleed extends ${fmt.bleed} mm on all edges`, note:`document ${(fmt.w+2*fmt.bleed)} × ${(fmt.h+2*fmt.bleed)} mm` });

  return F;
}

/* ═══════════════════════ BANGLADESH PRESET BRIEFS ═══════════════════════
   Real card types from the market, chosen because each one breaks the
   composer in a different way.                                          */
const PRESETS = [
{ k:'Doctor — chamber card', why:'Longest content in the market: degree strings routinely run 40+ characters, plus chamber hours.',
  c:{ name:'Prof. Dr. Md. Abdur Rahman', role:'Consultant, Medicine', company:'Popular Diagnostic Centre',
      quals:'MBBS (DMC), FCPS (Medicine), MRCP (UK)',
      bname:'অধ্যাপক ডাঃ মোঃ আব্দুর রহমান', brole:'মেডিসিন বিশেষজ্ঞ', bcompany:'পপুলার ডায়াগনস্টিক সেন্টার',
      p1:'01711-123456', p2:'01911-654321', email:'dr.rahman@popular.com.bd', web:'',
      addr:'Chamber: House 35/A, Dhanmondi, Dhaka-1205 · 5pm–9pm' } },
{ k:'RMG buying house', why:'Bilingual, long company name, three contact routes — the standard Dhaka export-trade card.',
  c:{ name:'Sharmin Akter', role:'Senior Merchandiser', company:'Zenith Sourcing Ltd.', quals:'',
      bname:'শারমিন আক্তার', brole:'সিনিয়র মার্চেন্ডাইজার', bcompany:'জেনিথ সোর্সিং লিমিটেড',
      p1:'01755-889900', p2:'', email:'sharmin@zenithsourcing.com', web:'zenithsourcing.com',
      addr:'Plot 12, Sector 3, Uttara, Dhaka-1230' } },
{ k:'Electronics shop', why:'SMB reality: no website, a Facebook page instead, two mobile numbers, Bangla-first.',
  c:{ name:'Md. Sumon Mia', role:'Proprietor', company:'Sumon Electronics', quals:'',
      bname:'মোঃ সুমন মিয়া', brole:'স্বত্বাধিকারী', bcompany:'সুমন ইলেকট্রনিক্স',
      p1:'01712-345678', p2:'01812-345678', email:'', web:'fb.com/sumonelectronics',
      addr:'দোকান নং ৪২, নিউ মার্কেট, ঢাকা' } },
{ k:'Advocate', why:'Traditional, formal, Bangla-dominant, court address matters more than email.',
  c:{ name:'Md. Kamrul Hasan', role:'Advocate, Supreme Court of Bangladesh', company:'Hasan & Associates', quals:'LL.B (Hons), LL.M',
      bname:'মোঃ কামরুল হাসান', brole:'অ্যাডভোকেট, বাংলাদেশ সুপ্রীম কোর্ট', bcompany:'হাসান অ্যান্ড অ্যাসোসিয়েটস',
      p1:'01819-223344', p2:'', email:'kamrul@hasanlaw.bd', web:'',
      addr:'Room 214, Bar Council Bhaban, Ramna, Dhaka-1000' } },
{ k:'Tutor / coaching', why:'Very short content — the opposite stress test. Layouts must not look empty.',
  c:{ name:'Nusrat Jahan', role:'Physics Tutor', company:'', quals:'',
      bname:'নুসরাত জাহান', brole:'পদার্থবিজ্ঞান শিক্ষক', bcompany:'',
      p1:'01677-112233', p2:'', email:'', web:'', addr:'Mirpur-10, Dhaka' } },
{ k:'Stress test — very long name', why:'Deliberately unreasonable. Proves elimination works instead of overflow.',
  c:{ name:'Mohammad Shafiqur Rahman Chowdhury Bhuiyan', role:'Deputy General Manager, Corporate Affairs',
      company:'Bangladesh Petrochemical & Allied Industries Limited', quals:'MBA (IBA), FCMA',
      bname:'মোহাম্মদ শফিকুর রহমান চৌধুরী ভূঁইয়া', brole:'উপ-মহাব্যবস্থাপক, কর্পোরেট বিষয়াবলী',
      bcompany:'বাংলাদেশ পেট্রোকেমিক্যাল অ্যান্ড অ্যালাইড ইন্ডাস্ট্রিজ লিমিটেড',
      p1:'01711-987654', p2:'01911-876543', email:'shafiqur.rahman@bpail.com.bd', web:'bpail.com.bd',
      addr:'Level 8, BTI Landmark, 12 Gulshan Avenue, Dhaka-1212' } }
];

/* ═══════════════════════════════════════════════════════════════════════
   PART II — THE GENERATOR
   -----------------------------------------------------------------------
   Everything above turns a chosen design into correct geometry. Everything
   below decides WHICH design, and explains why.

   This is the layer the prototype faked: `fit: 91` was a literal, and
   `tf(c,i)` reassigned palettes by array index. Here the score is computed,
   the ranking is deterministic, and the explanation is generated from the
   decision trace — so it cannot say something the engine did not do.

   No LLM. Per the blueprint (§7), the LLM's only jobs are parsing free text
   and phrasing; the ranking itself must be arithmetic or it is neither
   reproducible nor debuggable. This is the rules resolver that ships in MVP
   and remains the permanent fallback when the model is unavailable.
   ═══════════════════════════════════════════════════════════════════════ */

const AXES = ['premium','minimal','corporate','friendly','bold','traditional','technical'];
const vec = o => AXES.map(a => o[a] || 0);

/* Component personality weights. Weights, not tags — so ranking is
   arithmetic rather than string matching (see blueprint §5). */
const LAYOUT_AXES = {
  'lay.rule':      {minimal:.90, corporate:.60, premium:.50, technical:.30},
  'lay.centered':  {premium:.90, traditional:.80, minimal:.55},
  'lay.split':     {corporate:.90, minimal:.45, technical:.40},
  'lay.bleed':     {bold:.95, friendly:.60, premium:.20},
  'lay.editorial': {premium:.80, traditional:.70, minimal:.60},
  'lay.grid':      {technical:.95, minimal:.60, corporate:.50},
  'lay.band':      {corporate:.70, bold:.60, friendly:.55},
  'lay.corner':    {premium:.70, bold:.70, traditional:.35},
  'lay.stack':     {minimal:.80, corporate:.60, technical:.50}
};
const PALETTE_AXES = {
  'pal.ink':    {minimal:.90, corporate:.60, premium:.40},
  'pal.gold':   {premium:.95, traditional:.60, bold:.30},
  'pal.green':  {traditional:.70, friendly:.55, premium:.50},
  'pal.navy':   {corporate:.90, premium:.70, traditional:.50},
  'pal.maroon': {traditional:.90, premium:.60},
  'pal.teal':   {friendly:.70, corporate:.55, minimal:.50},
  'pal.slate':  {technical:.90, bold:.50, minimal:.50},
  'pal.red':    {bold:.90, friendly:.60}
};
const TYPE_AXES = {
  'typ.siliguri': {minimal:.70, corporate:.70, friendly:.50},
  'typ.noto':     {corporate:.70, friendly:.60, minimal:.55},
  'typ.tiro':     {traditional:.95, premium:.80},
  'typ.baloo':    {bold:.90, friendly:.80},
  'typ.mono':     {technical:.95, minimal:.60}
};

/* Industry priors for the Bangladeshi verticals in blueprint §0.5.3.
   `avoid` is a hard exclusion, not a low weight — a bold full-bleed card is
   not a slightly worse advocate's card, it is the wrong artefact. */
const INDUSTRIES = {
  doctor:     { label:'Doctor / chamber',    prior:{traditional:.80, minimal:.70, premium:.55, corporate:.50}, avoid:['bold'] },
  rmg:        { label:'RMG / buying house',  prior:{corporate:.90, premium:.50, technical:.35}, avoid:[] },
  advocate:   { label:'Advocate / notary',   prior:{traditional:.90, premium:.70, corporate:.60}, avoid:['bold','friendly'] },
  realestate: { label:'Real estate / land',  prior:{premium:.80, corporate:.60, bold:.50}, avoid:[] },
  tutor:      { label:'Tutor / coaching',    prior:{friendly:.80, minimal:.55, corporate:.40}, avoid:[] },
  shop:       { label:'Shop / restaurant',   prior:{friendly:.80, bold:.70}, avoid:[] },
  tech:       { label:'IT / engineering',    prior:{technical:.90, minimal:.70, corporate:.50}, avoid:[] },
  travel:     { label:'Travel / Hajj–Umrah', prior:{friendly:.70, premium:.55, traditional:.55}, avoid:[] }
};

/* ── Intent resolution, rules only ──────────────────────────────────────
   Industry prior, then explicit personality selections at double weight
   (the user's stated intent must be able to override the prior), then
   normalised. An LLM, when present, replaces ONLY this function and returns
   the same shape — which is why the product still works when it is down. */
function resolveIntent(brief){
  const ind = INDUSTRIES[brief.industry] || { prior:{}, avoid:[] };
  const v = {};
  for (const a of AXES) v[a] = (ind.prior[a] || 0) * 0.5;
  for (const p of brief.personality || []) v[p] = (v[p] || 0) + 1.0;
  const max = Math.max(...AXES.map(a => v[a]), 0.001);
  for (const a of AXES) v[a] = +(v[a] / max).toFixed(3);
  const stated = (brief.personality || []).slice();
  return { vector:v, avoid:ind.avoid, source:'rules', stated,
           inferredFrom: stated.length ? null : (ind.label || null),
           note: stated.length
             ? `${ind.label || 'General'} prior, overridden by ${stated.join(' · ')}`
             : `${ind.label || 'General'} prior only — nothing stated, so this is inferred` };
}

const cosine = (a,b) => {
  const dot = a.reduce((s,x,i)=>s+x*b[i],0);
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  return (na && nb) ? dot/(na*nb) : 0;
};

/* ── Candidate scoring ──────────────────────────────────────────────────
   Four weighted dimensions. Every one is derived from something the engine
   actually computed, so every one can be shown to the user and defended. */
const W = { personality:.45, industry:.20, printSafety:.20, legibility:.15 };

function scoreCandidate(cand, intent){
  const bv = vec(intent.vector);
  const la = vec(LAYOUT_AXES[cand.layout] || {});
  const pa = vec(PALETTE_AXES[cand.palette] || {});
  const ta = vec(TYPE_AXES[cand.type] || {});
  const blend = la.map((x,i) => (x*0.45 + pa[i]*0.35 + ta[i]*0.20));

  const personality = Math.max(0, cosine(bv, blend));

  // industry: a hard avoid on the dominant axis of any component kills it
  let industry = 1;
  for (const ax of intent.avoid){
    const i = AXES.indexOf(ax);
    if (i < 0) continue;
    if (blend[i] > 0.55) industry = 0;             // disqualifying
    else if (blend[i] > 0.30) industry -= 0.35;    // discouraged
  }
  industry = Math.max(0, industry);

  const blocking = cand.findings.filter(f=>f.s==='fail').length;
  const advisory = cand.findings.filter(f=>f.s==='review').length;
  const printSafety = blocking ? 0 : Math.max(0, 1 - advisory*0.18);

  /* Legibility. Note what this must NOT measure: minimum type size across
     all slots. Micro-labels are authored at the floor deliberately and the
     composer clamps them there, so that minimum is ~always 0 and the whole
     dimension would score zero for every candidate — 15% of the weighting
     doing no work. What actually differentiates candidates is (a) how much
     room the PRIMARY read has above the floor, and (b) how hard the ladder
     had to compress the content to make this layout hold it. */
  const texts = cand.composed.elements.filter(e=>e.fit);
  const nameEl = texts.find(e=>e.ref==='name');
  const head = nameEl ? nameEl.fit.sizePt - nameEl.fit.minPt : 0;
  const headScore = Math.max(0, Math.min(1, head/4));

  const stepped = cand.composed.trace.filter(t=>t.applied.some(a=>a.startsWith('step'))).length;
  const compression = texts.length ? Math.max(0, 1 - stepped/texts.length) : 1;

  const legibility = 0.6*headScore + 0.4*compression;

  const parts = { personality, industry, printSafety, legibility };
  const total = Object.keys(W).reduce((s,k)=>s+W[k]*parts[k], 0);
  return { total:+total.toFixed(4), parts, blocking, advisory,
           headroomPt:+head.toFixed(2), compression:+compression.toFixed(2), stepped };
}

/* ── Explanation, generated from the trace ──────────────────────────────
   Every clause is backed by a number the engine produced. This is the
   prototype's best copy ("restraint reads as seniority…") made truthful:
   it can no longer claim a reason the ranking did not use. */
const AXIS_WORD = { premium:'premium', minimal:'restrained', corporate:'corporate',
  friendly:'approachable', bold:'bold', traditional:'traditional', technical:'technical' };

function explain(cand, intent){
  const bv = intent.vector;
  const s = cand.score, out = [];

  /* Honesty rule: only say "you asked for" about axes the user actually
     selected. An industry prior is something the system INFERRED, and
     claiming the user asked for it is the same class of lie as the
     prototype's hardcoded 91/100 — smaller, but the same kind. */
  const stated = (intent.stated || []).filter(a => AXES.includes(a));
  if (stated.length){
    out.push(`You asked for ${stated.map(a=>AXIS_WORD[a]).join(' and ')}. This composition scores ${(s.parts.personality*100).toFixed(0)}/100 against that brief`);
  } else if (intent.inferredFrom){
    const top = AXES.filter(a=>bv[a] > 0.3).sort((a,b)=>bv[b]-bv[a]).slice(0,2).map(a=>AXIS_WORD[a]);
    out.push(`You did not state a personality, so this is ranked on what a ${intent.inferredFrom.toLowerCase()} card usually needs — ${top.join(' and ')} — scoring ${(s.parts.personality*100).toFixed(0)}/100. Say what you want and this will change`);
  } else {
    out.push(`Nothing was stated and no industry was set, so this is ranked on print safety and legibility alone`);
  }

  const lay = LAYOUTS.find(l=>l.id===cand.layout);
  const layTop = Object.entries(LAYOUT_AXES[cand.layout]||{}).sort((a,b)=>b[1]-a[1])[0];
  if (layTop) out.push(`${lay.name} was chosen because it reads ${AXIS_WORD[layTop[0]]} before it reads anything else`);

  const drops = cand.composed.dropped;
  const routes = cand.composed.trace.find(t=>t.applied.some(a=>a.startsWith('routes')));
  if (routes) out.push(`Your contact routes did not all fit the front at a legible size, so ${routes.applied.find(a=>a.startsWith('routes'))}`);
  else if (drops.length) out.push(`${drops.join(' and ')} was dropped rather than set below the ${cand.composed.elements.find(e=>e.fit)?.fit.minPt ?? 6} pt floor`);

  if (s.headroomPt < 1.0)
    out.push(`The name sits ${s.headroomPt.toFixed(1)} pt above the print floor in this layout — legible, but a longer name would not fit`);
  else if (s.stepped >= 2)
    out.push(`${s.stepped} fields had to be stepped down to hold your content, which is why this ranks below the concepts above it`);
  if (s.advisory) out.push(`${s.advisory} advisory preflight finding${s.advisory>1?'s':''} to review before printing`);

  return out.join('. ') + '.';
}

/* ── Generation ─────────────────────────────────────────────────────────
   Enumerate → compose (real fit) → preflight → score → enforce diversity →
   take six. This is the prototype's fake progress bar, made real: the
   candidate counts it prints are counted, not invented. */
function generate(brief, content, opts={}){
  const t0 = performance.now();
  const intent = resolveIntent(brief);
  const script = brief.script === 'bangla' ? 'bangla' : null;
  const stages = { enumerated:0, composed:0, printSafe:0, selected:0 };
  const cands = [];

  for (const L of LAYOUTS.filter(l=>l.face==='front')){
    /* The fit ladder is run once per type system, not once per type system
       per palette. Geometry does not depend on colour — `composeGeometry` has
       no palette in scope to depend on it with — so the eight palettes of a
       given layout and type share one composition, and generation does 45
       fit-ladder passes where it used to do 360 for the same 360 candidates.

       The eight siblings share their `elements`, `trace` and `dropped`
       arrays. That is safe rather than merely usually safe, because the
       diversity rule below admits at most one concept per layout: no two
       candidates that survive into the returned six can be siblings, so
       nothing a caller holds aliases anything else it holds. The 354 that
       do not survive are unreachable the moment this function returns.

       The library cannot move underneath this. Everything hoisted is
       recomputed on the next call, and there is no call in between — which
       is the difference between hoisting inside one pure function and a
       cache that outlives it. */
    const saved = LAYOUTS.indexOf(L);
    if (script) LAYOUTS[saved] = { ...L, forceScript:script };
    const geomOf = T => composeGeometry({ format:brief.format, type:T.id,
                                          density:brief.density, layout:L.id, content });
    const geomFor = new Map();
    if (PERF.caches) for (const T of TYPE_SYSTEMS) geomFor.set(T.id, geomOf(T));

    for (const P of PALETTES){
      for (const T of TYPE_SYSTEMS){
        stages.enumerated++;
        const spec = { format:brief.format, type:T.id, palette:P.id,
                       density:brief.density, layout:L.id, content };
        const g = geomFor.get(T.id) || geomOf(T);
        if (g.eliminated) continue;
        stages.composed++;
        const composed = { spec, fmt:g.fmt, pal:resolvePalette(P.id), type:g.type, face:g.face,
                           elements:g.elements, trace:g.trace, dropped:g.dropped, eliminated:g.eliminated };
        const findings = preflight(composed);
        if (findings.some(f=>f.s==='fail')) continue;
        stages.printSafe++;
        const cand = { layout:L.id, palette:P.id, type:T.id, composed, findings };
        cand.score = scoreCandidate(cand, intent);
        cands.push(cand);
      }
    }
    /* The forced-script clone stays in place for the whole of this layout's
       enumeration and comes out at the end of it. Nothing between those two
       points reads the library by index — scoring reads `LAYOUT_AXES` by id
       and preflight reads only the composition it was handed. */
    LAYOUTS[saved] = L;
  }

  cands.sort((a,b)=>b.score.total-a.score.total);

  /* Diversity: no two selected concepts may share a layout, and a palette
     may repeat at most once. Without this the top six are the same idea
     six times, which is the failure mode of every naive ranker. */
  const picked = [], usedLayout = new Set(), palCount = {};
  for (const c of cands){
    if (picked.length >= (opts.n || 6)) break;
    if (usedLayout.has(c.layout)) continue;
    if ((palCount[c.palette]||0) >= 2) continue;
    usedLayout.add(c.layout); palCount[c.palette] = (palCount[c.palette]||0)+1;
    picked.push(c);
  }
  for (const c of picked) c.why = explain(c, intent);
  stages.selected = picked.length;

  return { intent, picked, stages, ms:+(performance.now()-t0).toFixed(1),
           considered:cands.length };
}

/* ═════════════════════ LOGO — the gate is at UPLOAD ═════════════════════
   Blueprint F11 and §20: reject a bad logo when the user can still do
   something about it, never at export. Discovering at checkout that the file
   they have used for six years is unusable is the moment trust dies.

   The grader is a pure function of the asset's measured properties and the
   size it will be placed at, so it is testable without a DOM and gives the
   same answer on the server.                                              */
function gradeLogo(a, placedMm){
  const F = [], mmToIn = 25.4;
  if (a.vector){
    F.push({ s:'pass', label:`Vector artwork${a.kind ? ` (${a.kind.toUpperCase()})` : ''}`,
             note:'scales to any size; can be foiled, embossed or letterpressed' });

    /* A PDF or EPS whose whole content is one placed photograph is a raster in
       a vector wrapper. It survives every check that asks "is this vector"
       and fails at the press exactly like a JPEG, so it is called out here
       rather than at export — which §5.2 is explicit is the moment trust
       dies. */
    if (a.rasterInside)
      F.push({ s:'review', label:'This vector file contains a placed image',
               note:'the artwork inside is a photograph, so it will print at whatever resolution that image has and cannot be foiled or embossed. A drawn version would fix it.' });

    if (a.colors === null)
      F.push({ s:'review', label:'Colour count not measured in this format',
               note:'a PDF or EPS needs opening to count its colours. If you want foil or letterpress, confirm the logo is one colour.' });
    else if (a.colors > 4)
      F.push({ s:'review', label:`${a.colors} colours in the artwork`,
               note:'foil and letterpress need one colour — a single-colour version will be required for those finishes' });
  } else {
    const dpi = a.wpx / (placedMm / mmToIn);
    F.push(dpi >= 300
      ? { s:'pass', label:`Raster at ${Math.round(dpi)} dpi when placed at ${placedMm.toFixed(0)} mm`, note:'' }
      : dpi >= 150
        ? { s:'review', label:`Raster at ${Math.round(dpi)} dpi when placed at ${placedMm.toFixed(0)} mm`,
            note:'below the 300 dpi print standard — edges will look soft. Supply vector artwork if you have it.' }
        : { s:'fail', label:`Raster at ${Math.round(dpi)} dpi when placed at ${placedMm.toFixed(0)} mm`,
            note:`too low to print. This file is ${a.wpx}×${a.hpx} px; it needs at least ${Math.ceil(300*placedMm/mmToIn)} px wide.` });
    F.push({ s:'review', label:'Raster artwork cannot be foiled or embossed',
             note:'those finishes need a vector path. Matte, gloss and spot UV are fine.' });
    if (!a.hasAlpha)
      F.push({ s:'review', label:'No transparency', note:'the logo will sit on a white box — on a dark palette that box will be visible' });
  }
  const blocking = F.filter(f=>f.s==='fail').length;
  return { findings:F, ok: blocking === 0, blocking,
           options: blocking ? ['Upload vector artwork (SVG, PDF or EPS)',
                                'Use a generated monogram instead',
                                'Set the card without a logo'] : [] };
}

/* Browser-side measurement. Kept separate from the grader above so the
   decision logic stays pure and portable. */
/* ── PDF and EPS logos ─────────────────────────────────────────────────────
   Master PRD §5.2 says to accept SVG, PDF and EPS at upload and to reject a
   low-quality raster with a specific reason at that moment rather than at
   export. Only SVG was accepted, which in this market rejects the commonest
   handover there is: a company's logo arrives from whoever designed it as an
   Illustrator or CorelDRAW export, and that is a PDF or an EPS far more often
   than it is an SVG. Telling that customer "we cannot read your logo" sends
   them back to the shop, which is the outcome this product exists to avoid.

   Neither format is rendered here. What the quality gate needs is narrower
   than rendering: is this vector, how large is it, and does it secretly
   contain a raster? All three are answerable from the header and a scan of
   the stream, and answering only what can be answered is the difference
   between a gate and a guess. Placement uses the file as supplied — the print
   writer embeds it, and `gradeLogo` decides whether it is good enough. */
const EPS_BBOX  = /%%(?:HiRes)?BoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/;
const PDF_BOXES = /\/(?:MediaBox|CropBox|TrimBox)\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/;

/* A vector file that is one big embedded photograph is a raster wearing a
   vector extension, and it fails at the press exactly like a raster. EPS
   announces an embedded bitmap with an image operator; PDF with an image
   XObject. Both are cheap to look for and expensive to discover later. */
const EPS_RASTER = /\b(?:colorimage|imagemask|\bimage\b)\s*$|\/DataSource/mi;
const PDF_RASTER = /\/Subtype\s*\/Image/;

function inspectVectorDoc(text, kind){
  const m = kind === 'eps' ? EPS_BBOX.exec(text) : PDF_BOXES.exec(text);
  if (!m) return { ok:false, why: kind === 'eps'
    ? 'that EPS declares no BoundingBox, so there is no way to know what size it prints at'
    : 'that PDF declares no page box, so there is no way to know what size it prints at' };

  /* Both formats measure in points. A logo is a few tens of millimetres; a
     bounding box of zero or one the size of a poster means the file is not
     what it claims, and guessing a scale for it would place it wrongly. */
  const wPt = Math.abs(+m[3] - +m[1]), hPt = Math.abs(+m[4] - +m[2]);
  if (!(wPt > 1 && hPt > 1)) return { ok:false, why:'that file measures effectively zero — it may be empty' };

  const rasterInside = kind === 'eps' ? EPS_RASTER.test(text) : PDF_RASTER.test(text);
  return { ok:true, wPt, hPt, rasterInside };
}

function inspectLogo(file){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('could not read the file'));

    const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
    const isEps = /postscript|eps/i.test(file.type) || /\.(?:eps|ai)$/i.test(file.name);
    if (isPdf || isEps){
      fr.onload = () => {
        /* Read as latin1 text rather than decoded UTF-8: a PDF's streams are
           binary and decoding them as text would corrupt the very bytes the
           raster check looks for. */
        const text = String(fr.result);
        const head = isPdf ? '%PDF-' : '%!PS';
        if (text.slice(0, 1024).indexOf(head) < 0)
          return reject(new Error(isPdf ? 'that file is not a PDF' : 'that file is not an EPS'));

        const r = inspectVectorDoc(text, isPdf ? 'pdf' : 'eps');
        if (!r.ok) return reject(new Error(r.why));

        const PT = 0.352778;
        resolve({ vector:true, kind: isPdf ? 'pdf' : 'eps',
                  wMm:+(r.wPt * PT).toFixed(2), hMm:+(r.hPt * PT).toFixed(2),
                  /* A colour count needs the graphics state properly walked,
                     which this does not do. Reporting null says "not measured"
                     rather than inventing a number `gradeLogo` would then
                     treat as measured. */
                  colors:null, rasterInside:r.rasterInside, dataUrl:null });
      };
      fr.readAsBinaryString ? fr.readAsBinaryString(file) : fr.readAsText(file, 'latin1');
      return;
    }

    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)){
      fr.onload = () => {
        const text = String(fr.result);
        if (!/<svg[\s>]/i.test(text)) return reject(new Error('not a valid SVG'));
        const cols = new Set((text.match(/(?:fill|stroke)\s*[:=]\s*["']?\s*(#[0-9a-f]{3,8}|rgb[^)"';]*\)|[a-z]+)/gi) || [])
          .map(x=>x.toLowerCase()).filter(x=>!/none|currentcolor/.test(x)));
        resolve({ vector:true, colors:cols.size || 1, svg:text,
                  dataUrl:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(text) });
      };
      fr.readAsText(file);
    } else {
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('could not decode the image'));
        img.onload = () => {
          const cv = document.createElement('canvas');
          const w = cv.width = Math.min(img.naturalWidth, 128);
          const h = cv.height = Math.min(img.naturalHeight, 128);
          const cx = cv.getContext('2d');
          cx.drawImage(img, 0, 0, w, h);
          let hasAlpha = false; const seen = new Set();
          try {
            const d = cx.getImageData(0,0,w,h).data;
            for (let i = 0; i < d.length; i += 4){
              if (d[i+3] < 250) hasAlpha = true;
              if (seen.size < 64) seen.add((d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4));
            }
          } catch(e){ /* tainted canvas — treat as unknown */ }
          resolve({ vector:false, wpx:img.naturalWidth, hpx:img.naturalHeight,
                    colors:seen.size, hasAlpha, dataUrl:String(fr.result) });
        };
        img.src = String(fr.result);
      };
      fr.readAsDataURL(file);
    }
  });
}

/* ══════════════════ SPEC IDENTITY — content addressing ══════════════════
   Blueprint §2/§12: a design's identity IS its content. Same spec → same
   hash → same render → a cache hit. This is what makes previews free and
   makes "show me what the customer saw" answerable months later.
   FNV-1a here; sha256 in production — the property that matters is that it
   is a pure function of the spec with keys in a stable order.            */
function stableStringify(v){
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+stableStringify(v[k])).join(',') + '}';
}
function specHash(spec){
  const s = stableStringify(spec);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x9e3779b9;
  for (let i = s.length - 1; i >= 0; i--){ h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x85ebca6b) >>> 0; }
  return (h.toString(16).padStart(8,'0') + h2.toString(16).padStart(8,'0'));
}

/* ═══════════════════ BULK — the enterprise wedge ════════════════════════
   Blueprint §9/§15: one approved design + a row per employee → N specs →
   one order. Mechanically trivial once DesignSpec exists, and the thing
   Canva handles worst. Every row is composed and preflighted individually,
   because row 340 is the one with the 44-character name.                 */
function parseCSV(text){
  const rows = [];
  let row = [], cell = '', q = false;
  const src = String(text||'').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++){
    const ch = src[i];
    if (q){
      if (ch === '"' && src[i+1] === '"'){ cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ','){ row.push(cell); cell = ''; }
    else if (ch === '\n'){ row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length){ row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(c => c.trim()));
  if (!nonEmpty.length) return { header:[], rows:[] };
  const header = nonEmpty[0].map(h => h.trim().toLowerCase());
  return { header, rows: nonEmpty.slice(1).map(r => {
    const o = {}; header.forEach((h,i) => o[h] = (r[i]||'').trim()); return o; }) };
}

function bulkGenerate(design, csvRows, base, composeFn){
  const out = [];
  for (let i = 0; i < csvRows.length; i++){
    const r = csvRows[i];
    const content = Object.assign({}, base, {
      name: r.name || base.name, role: r.role || r.title || '',
      company: r.company || base.company, quals: r.quals || r.qualifications || '',
      bname: r.bname || r['নাম'] || '', brole: r.brole || r['পদবি'] || '',
      bcompany: r.bcompany || base.bcompany,
      p1: r.phone || r.mobile || r.p1 || '', p2: r.phone2 || r.p2 || '',
      email: r.email || '', web: r.web || r.website || base.web, addr: r.address || base.addr
    });
    const c = composeFn(design, content);
    out.push({ index:i+1, name:content.name, content, composed:c,
               ok: !c.eliminated, eliminated:c.eliminated || null });
  }
  return { total: out.length, ok: out.filter(r=>r.ok).length, rows: out };
}

/* ═══════════════════════════ THE EDIT GRAMMAR ═══════════════════════════
   The prototype states the correct principle in its own copy:

     "Every instruction resolves to a change in the component set,
      never a redraw."

   …and then implements four hardcoded chips. This is the principle, built.

   A free-text instruction is classified into operations from a CLOSED SET.
   Nothing else can ever be emitted. "Make my name bigger" does not become
   fontSize += 4 — it becomes promoteSlot('name'), which re-selects a layout
   whose composition can actually carry a larger name inside the safe area,
   and then re-composes. The geometry is always the composer's, never the
   instruction's.

   Unmapped input is a first-class result: the system says what it cannot do
   and offers the nearest things it can. It never guesses.
   ═══════════════════════════════════════════════════════════════════════ */

const nameScaleOf = id => {
  const L = LAYOUTS.find(l=>l.id===id);
  return (L?.slots.find(s=>s.ref==='name')?.scale) || 0;
};
const hasSlot = (id, ref) => !!LAYOUTS.find(l=>l.id===id)?.slots.some(s=>s.ref===ref);
const chroma = hex => { const c=hex.replace('#',''); const n=c.length===3?c.split('').map(x=>x+x).join(''):c;
  const [r,g,b]=[0,2,4].map(i=>parseInt(n.substr(i,2),16));
  return Math.max(Math.abs(r-g),Math.abs(g-b),Math.abs(r-b)); };

/* The closed set. Adding an operation here is the ONLY way to extend what a
   user can ask for — which is what makes the surface auditable. */
const EDIT_OPS = {
  setPalette:      (d,a)=> ({...d, palette:a}),
  shiftPalette:    (d,a)=>{
    const pool = PALETTES.filter(p=>p.id!==d.palette);
    const by = { dark:  p=>lum(p.bg), light: p=>-lum(p.bg),
                 saturated: p=>-chroma(p.accent), muted: p=>chroma(p.accent) }[a];
    if (!by) return d;
    return {...d, palette: pool.slice().sort((x,y)=>by(x)-by(y))[0].id };
  },
  setTypeSystem:   (d,a)=> ({...d, type:a}),
  shiftType:       (d,a)=> ({...d, type: ({ serif:'typ.tiro', traditional:'typ.tiro',
                              sans:'typ.siliguri', mono:'typ.mono', display:'typ.baloo' })[a] || d.type }),
  setLayout:       (d,a)=> ({...d, layout:a}),
  setLayoutFamily: (d,a)=>{
    const pool = LAYOUTS.filter(l=>l.face==='front' && l.family===a && l.id!==d.layout);
    return pool.length ? {...d, layout:pool[0].id} : d;
  },
  setDensity:      (d,a)=> ({...d, density:a}),
  setCorner:       (d,a)=> ({...d, corner:Number(a)||0}),
  /* promoteSlot is the load-bearing one: it re-selects the composition that
     gives this slot the most room, rather than scaling type in place. */
  promoteSlot:     (d,a)=>{
    if (a !== 'name') return d;
    const best = LAYOUTS.filter(l=>l.face==='front')
      .slice().sort((x,y)=>nameScaleOf(y.id)-nameScaleOf(x.id))[0];
    return best ? {...d, layout:best.id} : d;
  },
  demoteSlot:      (d,a)=> a==='name'
    ? {...d, layout: LAYOUTS.filter(l=>l.face==='front').slice()
        .sort((x,y)=>nameScaleOf(x.id)-nameScaleOf(y.id))[0].id } : d,
  moveSlotToBack:  (d,a)=>{
    if (a !== 'contact') return d;
    const clean = LAYOUTS.find(l=>l.face==='front' && !hasSlot(l.id,'contact'));
    return { ...d, back:'back.contact', layout: clean ? clean.id : d.layout };
  },
  setBack:         (d,a)=> ({...d, back:a}),
  setScript:       (d,a)=> ({...d, script:a}),
  setFormat:       (d,a)=> ({...d, format:a}),
  addFinish:       (d,a)=> ({...d, finishes:[...new Set([...(d.finishes||[]), a])]}),
  removeFinish:    (d,a)=> ({...d, finishes:(d.finishes||[]).filter(f=>f!==a)})
};

/* Rules classifier. English and Bangla. An LLM, when available, replaces
   only this table and must return the same {op,arg} shape — so the closed
   set still bounds it, and a hallucinated operation fails validation rather
   than reaching the composer. */
const EDIT_RULES = [
  { re:/premium|luxur|expensive|rich|প্রিমিয়াম|দামি|রাজকীয়|অভিজাত/i,
    label:'more premium', ops:[['setPalette','pal.gold'],['shiftType','traditional']] },
  { re:/minimal|simpl|clean|less busy|কম|সহজ|সাধারণ|পরিষ্কার/i,
    label:'more minimal', ops:[['setLayoutFamily','minimal'],['setDensity','airy']] },
  { re:/crowded|cluttered|too much|breathing|ভিড়|জায়গা|ফাঁকা/i,
    label:'less crowded', ops:[['setDensity','airy'],['moveSlotToBack','contact']] },
  { re:/(name).*(big|large)|(big|large).*(name)|নাম.*বড়|বড়.*নাম/i,
    label:'bigger name', ops:[['promoteSlot','name']] },
  { re:/(name).*(small)|smaller name|নাম.*ছোট/i,
    label:'smaller name', ops:[['demoteSlot','name']] },
  /* NB: an earlier version of this rule included `it\b`, which matched the
     word "it" in almost every instruction — "make IT more premium" silently
     became a technical card too. Patterns in a classifier must be specific
     enough that a common English function word cannot trigger them. */
  { re:/technical|engineer|developer|software|hardware|network|প্রযুক্তি|টেক/i,
    label:'more technical', ops:[['setLayoutFamily','technical'],['setTypeSystem','typ.mono']] },
  { re:/corporate|formal|business|professional|কর্পোরেট|আনুষ্ঠানিক|পেশাদার/i,
    label:'more corporate', ops:[['setLayoutFamily','structured'],['setPalette','pal.navy']] },
  { re:/traditional|classic|old|heritage|ঐতিহ্য|সনাতন|পুরনো/i,
    label:'more traditional', ops:[['setLayoutFamily','traditional'],['setTypeSystem','typ.tiro']] },
  { re:/bold|loud|strong|stand out|striking|সাহসী|জোরালো|নজরকাড়া/i,
    label:'bolder', ops:[['setLayoutFamily','expressive'],['setDensity','tight']] },
  { re:/dark|black|গাঢ়|কালো/i,           label:'darker',  ops:[['shiftPalette','dark']] },
  { re:/light|bright|white|হালকা|সাদা|উজ্জ্বল/i, label:'lighter', ops:[['shiftPalette','light']] },
  { re:/colou?rful|more colou?r|vivid|রঙিন|রঙ/i, label:'more colour', ops:[['shiftPalette','saturated']] },
  { re:/muted|subtle|quiet|নরম|মৃদু/i,    label:'more muted', ops:[['shiftPalette','muted']] },
  { re:/qr/i,                             label:'QR on the back', ops:[['setBack','back.qr']] },
  { re:/foil|gold|সোনালি|ফয়েল/i,          label:'add gold foil', ops:[['addFinish','foil']] },
  { re:/spot ?uv|uv/i,                    label:'add spot UV', ops:[['addFinish','spotuv']] },
  { re:/portrait|vertical|খাড়া|লম্বা/i,    label:'portrait format', ops:[['setFormat','bd-port']] },
  { re:/landscape|horizontal|শোয়ানো/i,     label:'landscape format', ops:[['setFormat','bd-std']] },
  { re:/bangla|bengali|বাংলা/i,            label:'Bangla face', ops:[['setScript','bangla']] },
  { re:/english|latin|ইংরেজি/i,            label:'English face', ops:[['setScript','latin']] },
  { re:/serif/i,                          label:'serif type', ops:[['shiftType','serif']] },
  { re:/mono(space)?/i,                   label:'monospaced type', ops:[['shiftType','mono']] },
  { re:/tight|dense|compact|ঘন/i,          label:'tighter', ops:[['setDensity','tight']] },
  { re:/round(ed)? corner|rounded|গোল কোণ/i, label:'rounded corners', ops:[['setCorner','2']] },
  { re:/square corner|sharp corner/i,      label:'square corners', ops:[['setCorner','0']] },
  { re:/contact.*(back|behind)|(back|behind).*contact|যোগাযোগ.*পিছ/i,
    label:'contact on the back', ops:[['moveSlotToBack','contact']] }
];

function classifyInstruction(text){
  const t = String(text||'').trim();
  if (!t) return { ops:[], matched:[], unmapped:false, empty:true };
  const matched = [], ops = [];
  for (const r of EDIT_RULES){
    if (!r.re.test(t)) continue;
    matched.push(r.label);
    for (const o of r.ops) ops.push({ op:o[0], arg:o[1] });
    if (matched.length >= 3) break;           // bound the blast radius
  }
  if (!ops.length){
    return { ops:[], matched:[], unmapped:true,
      suggestions:['Make it more premium','Make it less crowded','Make my name bigger'],
      note:`"${t}" does not map to anything this system can do. It will not guess.` };
  }
  // Closed-set guarantee, asserted rather than assumed.
  const bad = ops.filter(o => !EDIT_OPS[o.op]);
  if (bad.length) return { ops:[], matched:[], unmapped:true,
      suggestions:[], note:'internal: unknown operation rejected' };
  return { ops, matched, unmapped:false };
}

function applyOps(design, ops){
  let d = { ...design }, changes = [];
  for (const {op,arg} of ops){
    const fn = EDIT_OPS[op];
    if (!fn) continue;                                    // never trust the caller
    const before = d;
    d = fn(d, arg) || d;
    for (const k of Object.keys(d))
      if (JSON.stringify(before[k]) !== JSON.stringify(d[k]))
        changes.push({ key:k, from:before[k], to:d[k], via:`${op}(${arg})` });
  }
  return { design:d, changes };
}

/* ═══════════════════════ COST MODEL — Bangladesh ═══════════════════════
   Replaces the prototype's `{100:'320', 250:'540'…}` lookup with an actual
   model: press cost + finish setup + per-unit finish + delivery + margin.

   ⚠ These are ESTIMATES to validate against real quotes from two or three
   Dhaka presses. The SHAPE is the deliverable; the numbers are placeholders
   that must be replaced before any price is shown to a customer.          */
const PRESS_BASE = { 100:380, 250:620, 500:980, 1000:1600 };   // ৳, 300gsm art card, 4/4
const FINISH_COST = {
  'matte':      { label:'Matte lamination',  setup:0,   per1000:180 },
  'gloss':      { label:'Gloss lamination',  setup:0,   per1000:160 },
  'softtouch':  { label:'Soft-touch',        setup:0,   per1000:520 },
  'spotuv':     { label:'Spot UV',           setup:400, per1000:350 },
  'foil':       { label:'Gold foil',         setup:700, per1000:600 },
  'emboss':     { label:'Embossing',         setup:900, per1000:500 },
  'rounded':    { label:'Rounded corners',   setup:650, per1000:220 }
};
const DELIVERY = { dhaka:80, outside:150 };
const MARGIN = 1.55;

function quote(qty, finishes, zone='dhaka'){
  const base = PRESS_BASE[qty] ?? PRESS_BASE[1000] * qty/1000;
  const lines = [{ label:`Printing — ${qty} cards, 300 gsm art card`, cost:base }];
  let finishCost = 0;
  for (const f of finishes){
    const F = FINISH_COST[f]; if (!F) continue;
    const c = F.setup + F.per1000 * qty/1000;
    finishCost += c;
    lines.push({ label:`${F.label}${F.setup?` (incl. ৳${F.setup} one-off block/plate)`:''}`, cost:Math.round(c) });
  }
  const del = DELIVERY[zone];
  lines.push({ label:`Delivery — ${zone==='dhaka'?'inside Dhaka':'outside Dhaka'}`, cost:del });
  const pressCost = base + finishCost + del;
  const retail = Math.round((pressCost * MARGIN) / 10) * 10;
  return { lines, pressCost:Math.round(pressCost), retail,
           gross:Math.round(retail - pressCost),
           marginPct:+(100*(retail-pressCost)/retail).toFixed(1),
           unit:+(retail/qty).toFixed(2),
           note:'Estimate. Validate against live press quotes before display.' };
}

/* ═══════════════════ PRINT OUTPUT — geometry, not pixels ═══════════════
   A PDF/X-4 writer is out of scope here, but the part that decides
   correctness is the DOCUMENT GEOMETRY, and that is fully determined:
   bleed box, trim marks, and a separate 100% K separation per special.
   This produces exactly the geometry a PDF writer would consume.         */
function printDocSVG(c, opts={}){
  if (!c || c.eliminated) return null;
  const { fmt } = c, b = fmt.bleed;
  const W2 = fmt.w + 2*b, H2 = fmt.h + 2*b;
  const art = renderSVG(c).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const M = 2, O = 0.6;           // trim mark length / offset from trim
  const mark = (x1,y1,x2,y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="0.1"/>`;
  let marks = '';
  for (const [cx, sx] of [[b,-1],[b+fmt.w,1]])
    for (const [cy, sy] of [[b,-1],[b+fmt.h,1]]){
      marks += mark(cx + sx*O, cy, cx + sx*(O+M), cy);
      marks += mark(cx, cy + sy*O, cx, cy + sy*(O+M));
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}mm" height="${H2}mm" viewBox="0 0 ${W2} ${H2}">
  <desc>CARDWORKS print document — trim ${fmt.w}×${fmt.h}mm, bleed ${b}mm. Fonts must be outlined before output.</desc>
  <rect width="${W2}" height="${H2}" fill="#fff"/>
  <g transform="translate(${b},${b})">${art}</g>
  ${marks}</svg>`;
}

/* Separation for a special (foil / spot UV): the elements carrying it,
   drawn 100% K on white, at the same document geometry. Overprint off. */
function separationSVG(c, kind){
  if (!c || c.eliminated) return null;
  const { fmt } = c, b = fmt.bleed;
  const W2 = fmt.w + 2*b, H2 = fmt.h + 2*b;
  // The special rides on the mark/monogram — the smallest plate area that
  // still reads, which is what keeps foil affordable (blueprint §10.1).
  const carriers = c.elements.filter(e => ['mark','mono','bigmono','ghost'].includes(e.kind));
  if (!carriers.length) return null;
  let body = '';
  for (const e of carriers){
    const g = e.geom;
    body += `<text x="${g.x+g.w/2}" y="${g.y+g.h*0.78}" font-family="${c.type.latin}" font-weight="700"
             font-size="${g.h*(e.kind==='mark'?0.58:0.9)}" fill="#000" text-anchor="middle">${e.glyph||'N'}</text>`;
  }
  const areaPct = (100 * carriers.reduce((s,e)=>s+e.geom.w*e.geom.h,0) / (fmt.w*fmt.h)).toFixed(1);
  return { svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${W2}mm" height="${H2}mm" viewBox="0 0 ${W2} ${H2}">
  <desc>${kind} separation — 100% K on white, overprint off, plate area ${areaPct}%</desc>
  <rect width="${W2}" height="${H2}" fill="#fff"/>
  <g transform="translate(${b},${b})">${body}</g></svg>`, areaPct:+areaPct };
}

