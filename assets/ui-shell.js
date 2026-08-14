/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — product shell
   --------------------------------------------------------------------------
   Router, state, formatting helpers and the per-screen dispatch table.
   Every ui-*.js file below depends on these; treat this file as a contract.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   PRODUCT SHELL
   --------------------------------------------------------------------------
   The engine above is untouched. This is the surface: the prototype's own
   information architecture — nav, crumb, numbered rail, one screen at a time
   — driving the real composer instead of static data.
   ══════════════════════════════════════════════════════════════════════ */

const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* Authored icons. One library, 1.5px stroke, 16px box — never a unicode
   glyph standing in for an icon. */
const svg = d => `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true">${d}</svg>`;
const ICON = {
  check:  svg('<path d="M2.5 8.2 6.2 12 13.5 4"/>'),
  next:   svg('<path d="M2 8h11M9 4l4 4-4 4"/>'),
  prev:   svg('<path d="M14 8H3M7 4 3 8l4 4"/>'),
  down:   svg('<path d="M8 2v9M4.5 7.5 8 11l3.5-3.5M2.5 13.5h11"/>'),
  pass:   svg('<path d="M3 8.4 6.1 11.5 13 4.5"/>'),
  review: svg('<path d="M8 2.5 14.5 13.5h-13z"/><path d="M8 6.5v3"/><path d="M8 11.6v.4"/>'),
  fail:   svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  dot:    svg('<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>')
};
const STATE_ICON = { pass:'pass', review:'review', fail:'fail' };

const SCREENS = ['start','brief','generating','concepts','detail','customise','validate','export','order',
  'tracking','noresults','library','mockups','bulk','dashboard','profiles','pricing','signin',
  'settings','studio','compedit','layoutbuild'];
const NAV = [['start','Start'],['brief','Brief'],['concepts','Concepts'],['library','Library'],
  ['mockups','Mockups'],['bulk','Bulk'],['dashboard','My designs'],['studio','Studio'],
  ['pricing','Plans'],['signin','Account']];
const STAGES = [
  ['08','Generate',       'generating'],
  ['09','Explore',        'concepts'],
  ['10','Customise',      'customise'],
  ['11','Validate',       'validate'],
  ['12','Export or order','export']
];
const FLOW_SCREENS = ['generating','concepts','detail','customise','validate','export'];
const STEPS = [
  ['01','Who it is for'], ['02','Contact routes'], ['03','Logo'],
  ['04','Personality'],   ['05','Language and size'], ['06','Printing'], ['07','Review']
];

const state = {
  screen:'brief', step:0, side:'front', pick:0,
  format:'bd-std', type:'typ.siliguri', palette:'pal.gold', density:'balanced',
  back:'back.bangla', script:'latin', layout:'lay.centered',
  industry:'doctor', personality:['traditional','premium'], finishes:['matte','foil'],
  qty:500, zone:'dhaka',
  refine:null, instrLog:[], history:[], logo:null, bulk:null, shareCode:null,
  gen:null, genStage:0, seen:0, view:'grid', corner:0,
  press:null, scene:'On a desk', libCat:'Layouts', compId:0, profileIdx:0,
  lbId:null, lbSlot:0, lbView:'slots', compKind:null, compTags:['premium'],
  order:null, dash:null, trackRef:null, orderTotal:0, orderSub:0
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const taka = n => '৳' + Number(n).toLocaleString('en-IN');
const reduced = () => typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

function readForm(){
  return { logo: state.logo, name:$('#i_name').value, role:$('#i_role').value,
    company:$('#i_company').value, quals:$('#i_quals').value,
    bname:$('#i_bname').value, brole:$('#i_brole').value, bcompany:$('#i_bcompany').value,
    p1:$('#i_p1').value, p2:$('#i_p2').value, email:$('#i_email').value,
    web:$('#i_web').value, addr:$('#i_addr').value };
}
function writeForm(c){
  const m = {i_name:'name',i_role:'role',i_company:'company',i_quals:'quals',i_bname:'bname',
    i_brole:'brole',i_bcompany:'bcompany',i_p1:'p1',i_p2:'p2',i_email:'email',i_web:'web',i_addr:'addr'};
  for (const k in m){ const el = $('#'+k); if (el) el.value = c[m[k]] || ''; }
}

function specFor(layoutId, content){
  return { format:state.format, type:state.type, palette:state.palette,
           density:state.density, layout:layoutId, content, corner:state.corner || 0,
           share:{ origin:(typeof location !== 'undefined' && location.origin &&
                           /^https?:/.test(location.origin)) ? location.origin : 'https://cardworks.bd',
                   code: state.shareCode || null } };
}
function composeForced(layoutId, content, forceScript, over){
  const L = LAYOUTS.find(l => l.id === layoutId);
  const i = LAYOUTS.indexOf(L);
  if (forceScript) LAYOUTS[i] = { ...L, forceScript };
  const c = compose(Object.assign(specFor(layoutId, content), over || {}));
  LAYOUTS[i] = L;
  return c;
}

function bindTiles(sel, fn){
  $$(sel).forEach(t => {
    t.onclick = () => fn(t);
    t.onkeydown = e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); fn(t); } };
  });
}

let lastDesign = null;
function go(screen){
  /* A screen cut from MVP (PRD §5.2) is unreachable, not merely unlinked —
     otherwise it comes back the first time someone types the hash. */
  if (typeof screenEnabled === 'function' && !screenEnabled(screen)) screen = 'start';
  state.screen = screen; if (typeof scrollTo === 'function') scrollTo(0,0); draw();
}

/* ── the one authored motion moment ───────────────────────────────────────
   Generation is already finished when this runs; the stages reveal the real
   counts it produced. Short and staggered, so it reads as a composition
   resolving rather than a progress bar pretending to work. */
function runGenerate(){
  const content = readForm();
  const frontScript = (state.script === 'bangla' || state.script === 'bangla-only') ? 'bangla' : null;
  state.gen = generate({ industry:state.industry, personality:state.personality,
    format:state.format, density:state.density, script: frontScript ? 'bangla' : 'latin' }, content);
  state.pick = 0; state.refine = null; state.history = []; state.instrLog = [];
  state.genStage = 0;
  if (!state.gen.picked.length){ go('noresults'); return; }
  go('generating');
  if (reduced()){ state.genStage = 99; go('concepts'); return; }
  const tick = () => {
    state.genStage++;
    if (state.genStage > 6){ go('concepts'); return; }
    draw(); setTimeout(tick, 70);
  };
  setTimeout(tick, 90);
}

function currentDesign(){
  const cand = state.gen && state.gen.picked[state.pick];
  const frontScript = (state.script === 'bangla' || state.script === 'bangla-only') ? 'bangla' : null;
  const baseBack = state.script === 'bangla-only' ? 'back.contact'
                 : state.script === 'latin-only' ? (state.back === 'back.bangla' ? 'back.contact' : state.back)
                 : state.back;
  const base = cand
    ? { layout:cand.layout, palette:cand.palette, type:cand.type }
    : { layout:state.layout, palette:state.palette, type:state.type };
  const d = { ...base, density:state.density, back:baseBack, format:state.format,
              corner:state.corner || 0,
              script: frontScript ? 'bangla' : 'latin', finishes:state.finishes.slice() };
  return state.refine || d;
}

function checkRow(f){
  const k = STATE_ICON[f.s] || 'dot';
  return `<div class="check"><span class="ico i-${f.s}">${ICON[k]}</span><span>${
    f.face ? `<b>${f.face}</b> · ` : ''}${esc(f.label)}${
    f.note ? `<span class="note">${esc(f.note)}</span>` : ''}</span></div>`;
}

function facesFor(design, content){
  const fs = design.script === 'bangla' ? 'bangla' : null;
  const over = { palette:design.palette, type:design.type, density:design.density, format:design.format };
  const front = composeForced(design.layout, content, fs, over);
  const back  = composeForced(design.back, content,
    design.back === 'back.bangla' ? 'bangla' : (fs ? 'latin' : null), over);
  return { front, back };
}

function allFindings(front, back){
  const pf = [...preflight(front).map(f => ({...f, face:'Front'})),
              ...preflight(back).map(f => ({...f, face:'Back'}))];
  const present = new Set([...(front?.elements||[]), ...(back?.elements||[])]
    .filter(e => e.fit).map(e => e.ref));
  for (const ref in SLOTDEFS){
    if (!SLOTDEFS[ref].required) continue;
    pf.unshift(present.has(ref)
      ? { s:'pass', face:'Card', label:`Required field present: ${ref}`, note:'' }
      : { s:'fail', face:'Card', label:`Required field missing from both faces: ${ref}`,
          note:'choose a back that carries it, or a front layout that has the slot' });
  }
  return pf;
}

/* ══════════════════════════ RENDER ══════════════════════════ */
function draw(){
  const content = readForm();
  const design  = currentDesign();
  lastDesign = design;

  $$('[data-screen]').forEach(s => {
    s.style.display = s.dataset.screen === state.screen ? 'block' : 'none';
  });
  /* The component editor writes a live preview record into the library so the
     card can be composed with values as they are typed. It must never survive
     leaving that screen, or an unpublished draft would show up in generation. */
  if (state.screen !== 'compedit'){
    for (const arr of [PALETTES, TYPE_SYSTEMS]){
      const i = arr.findIndex(x => x.id === '__preview');
      if (i >= 0) arr.splice(i, 1);
    }
  }
  $('#crumb').textContent = {
    brief:`Brief · step ${state.step+1} of 7`, generating:'Composing',
    concepts:'Six concepts', detail:'Refining', validate:'Preflight',
    export:'Export or order', library:'Template library', bulk:'Bulk orders',
    start:'Start', order:'Checkout', tracking:'Order ' + (state.trackRef || ''),
    noresults:'Constraint conflict', dashboard:'My designs', profiles:'Brand profiles',
    pricing:'Plans', signin:'Account', settings:'Settings',
    studio:'Design studio — internal', compedit:'New component', layoutbuild:'Layout builder',
    customise:'Customise'
  }[state.screen] || '';
  $('#navlinks').innerHTML = NAV.filter(([s]) => screenEnabled(s)).map(([s,l]) =>
    `<button class="btn btn-ghost" data-go="${s}" aria-current="${state.screen===s}">${l}</button>`).join('');
  $$('#navlinks [data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

  if (state.screen === 'brief')      drawBrief(content);
  if (state.screen === 'generating') drawGenerating();
  if (state.screen === 'concepts')   drawConcepts();
  if (state.screen === 'detail')     drawDetail(design, content);
  if (state.screen === 'validate')   drawValidate(design, content);
  if (state.screen === 'export')     drawExport(design, content);
  if (state.screen === 'library')    drawLibrary(content);
  if (state.screen === 'bulk')       drawBulk(design, content);
  if (state.screen === 'start')      drawStart();
  if (state.screen === 'noresults')  drawNoResults(content);
  if (state.screen === 'order')      drawOrder(design, content);
  if (state.screen === 'tracking')   drawTracking();
  if (state.screen === 'dashboard')  drawDashboard(content);
  if (state.screen === 'profiles')   drawProfiles(design, content);
  if (state.screen === 'mockups')    drawMockups(design, content);
  if (state.screen === 'pricing')    drawPricing();
  if (state.screen === 'signin')     drawSignin();
  if (state.screen === 'settings')   drawSettings();
  if (state.screen === 'studio')     drawStudio();
  if (state.screen === 'compedit')   drawCompEdit();
  if (state.screen === 'layoutbuild')drawLayoutBuild(content);
  if (state.screen === 'customise') drawCustomise(design, content);
  drawStageBar();
}


/* Stages 08–12 of the rail. They are a real journey, not decoration: each
   one is reachable only once the stage before it has produced something. */
function stageState(id){
  if (id === 'generating') return 'ready';
  return state.gen && state.gen.picked.length ? 'ready' : 'locked';
}
function stageForScreen(sc){
  if (sc === 'detail') return 'concepts';
  return sc;
}
function goStage(target){
  if (target === 'generating'){ runGenerate(); return; }
  if (stageState(target) === 'locked'){ runGenerate(); return; }
  go(target);
}
function drawStageBar(){
  const bar = $('#stagebar');
  if (!bar) return;
  const active = stageForScreen(state.screen);
  const show = FLOW_SCREENS.indexOf(state.screen) >= 0;
  bar.style.display = show ? 'flex' : 'none';
  if (!show){ bar.innerHTML = ''; return; }
  const cur = STAGES.findIndex(x => x[2] === active);
  bar.innerHTML = STAGES.map(([n,l,sc],i) => {
    const locked = stageState(sc) === 'locked';
    return `<button data-stage="${sc}" ${locked?'disabled':''}
      aria-current="${sc===active?'step':'false'}">
      <span class="railnum">${n}</span><span>${l}</span>
      ${i < cur ? `<span class="railmark">${ICON.check}</span>` : ''}</button>`;
  }).join('');
  $$('#stagebar [data-stage]').forEach(b => b.onclick = () => goStage(b.dataset.stage));
}

/* ── Brief ─────────────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════
   THE REST OF THE DESIGNED SYSTEM
   --------------------------------------------------------------------------
   Thirteen screens the prototype specified. Each is wired to something real:
   the live component library, the composer, the quote model, or the database.
   Where a capability genuinely does not exist yet (passwords), the screen
   says so rather than miming it.
   ══════════════════════════════════════════════════════════════════════ */

/* Dhaka print market. Capabilities gate which finishes a press can be
   offered for, exactly as blueprint §10.3 describes. */
const PRESSES = [
  { name:'Nilkhet Offset, Dhaka',      can:['matte','gloss','spotuv'],                    lead:'3 days', mult:0.92 },
  { name:'Fakirapool Press, Motijheel',can:['matte','gloss','spotuv','foil'],             lead:'4 days', mult:1.00 },
  { name:'Banglabazar Printers',       can:['matte','gloss','foil','emboss'],             lead:'5 days', mult:1.04 },
  { name:'Arambagh Fine Print',        can:['matte','gloss','softtouch','spotuv','foil','emboss'], lead:'7 days', mult:1.18 }
];

const PLANS = [
  { name:'Free',     price:'৳0',     per:'forever',            who:'One brief, three concepts, watermarked previews.' },
  { name:'File pack',price:'৳199',   per:'one-off, per card',  who:'Print-ready files for the card you designed. Print anywhere.' },
  { name:'Pro',      price:'৳1,200', per:'per year',           who:'Unlimited briefs, full refinement, all print files.' },
  { name:'Shop',     price:'৳900',   per:'per month, per outlet', who:'Counter mode, your own pricing, bulk ordering.' }
];
const PLAN_ROWS = [
  ['Concepts per brief','3','6','6','6'],
  ['Briefs per month','1','Unlimited','Unlimited','Unlimited'],
  ['Refinement and re-composition','—','Yes','Yes','Yes'],
  ['Print-ready files','—','Yes','Yes','Yes'],
  ['Foil and spot-UV separations','—','Yes','Yes','Yes'],
  ['Bangla + English bilingual','Yes','Yes','Yes','Yes'],
  ['Brand profiles','1','1','8','Unlimited'],
  ['Bulk from CSV','—','—','Yes','Yes'],
  ['Counter mode for walk-ins','—','—','—','Yes']
];
const SCENES = [
  { k:'On a desk',        ground:'#cfc7bd', arrange:'single' },
  { k:'Stack of cards',   ground:'#b9b2aa', arrange:'stack'  },
  { k:'Front and back',   ground:'#d5d0c8', arrange:'pair'   },
  { k:'Under office light',ground:'#e6e4e0',arrange:'flat'   },
  { k:'Dark desk',        ground:'#2c2a28', arrange:'single' }
];
const NOTIFS = [
  ['Proof delivered and awaiting approval', true],
  ['Order shipped', true],
  ['New templates in my industry', false],
  ['Product news', false]
];

/* ── Local identity. Not an account: a per-browser key so saved work can be
   listed back. It grants nothing and is stated plainly on the sign-in screen. */
function ownerKey(){
  try {
    let k = localStorage.getItem('cardworks.owner');
    if (!k || !/^[A-Za-z0-9_-]{8,64}$/.test(k)){
      k = 'br' + specHash({ t:String(Date.now?Date.now():0), n:navigator.userAgent||'x' }) + 'k';
      localStorage.setItem('cardworks.owner', k);
    }
    return k;
  } catch(e){ return null; }
}
const lsGet = (k,d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch(e){ return d; } };
const lsSet = (k,v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

/* ── START — one sentence to a starting brief, by rules ──────────────────
   The same discipline as the edit grammar: keywords map to library values,
   and anything not matched is reported as low confidence and asked about
   rather than guessed. */
const SENTENCE_RULES = {
  industry: [
    [/doctor|chamber|medicine|physician|surgeon|dental|ডাক্তার|চেম্বার/i, 'doctor'],
    [/garment|rmg|buying house|merchandis|textile|knit|woven|গার্মেন্ট/i, 'rmg'],
    [/advocate|lawyer|court|legal|notary|আইনজীবী|অ্যাডভোকেট/i, 'advocate'],
    [/real estate|property|land|flat|developer.*housing|রিয়েল এস্টেট|জমি/i, 'realestate'],
    [/tutor|coaching|teacher|lecturer|academy|শিক্ষক|কোচিং/i, 'tutor'],
    [/shop|store|restaurant|hotel|electronic|grocery|boutique|দোকান|রেস্টুরেন্ট/i, 'shop'],
    [/software|\bit\b services|developer|engineer|tech|data|network|প্রযুক্তি/i, 'tech'],
    [/travel|hajj|umrah|tour|ticket|ট্রাভেল|হজ|ওমরাহ/i, 'travel']
  ],
  personality: [
    [/premium|luxur|high[- ]end|exclusive|expensive|প্রিমিয়াম|অভিজাত/i, 'premium'],
    [/simple|minimal|clean|plain|সাধারণ|সহজ/i, 'minimal'],
    [/corporate|formal|professional|enterprise|কর্পোরেট|পেশাদার/i, 'corporate'],
    [/friendly|warm|approachable|local|বন্ধুত্বপূর্ণ/i, 'friendly'],
    [/bold|strong|loud|stand out|সাহসী/i, 'bold'],
    [/traditional|classic|heritage|old|ঐতিহ্য/i, 'traditional'],
    [/technical|engineering|precise|প্রযুক্তিগত/i, 'technical']
  ]
};
function readSentence(text){
  const t = String(text || '');
  const out = { industry:null, personality:[], script:null, hits:0 };
  for (const [re, v] of SENTENCE_RULES.industry) if (re.test(t)){ out.industry = v; out.hits++; break; }
  for (const [re, v] of SENTENCE_RULES.personality)
    if (re.test(t) && out.personality.length < 3){ out.personality.push(v); out.hits++; }
  if (/[ঀ-৿]/.test(t)){ out.script = 'bangla'; out.hits++; }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   SHELL CONTRACT
   --------------------------------------------------------------------------
   Everything below is depended on by every ui-*.js file. It exists so that
   the four things the Wireframing Document asks for on every screen — a
   thumb-reachable action bar, an honest pending state, an honest failure
   state, and a real answer when the network is gone — are written once and
   look the same everywhere, rather than reinvented per screen.
   ══════════════════════════════════════════════════════════════════════ */

/* ── Feature flags ────────────────────────────────────────────────────────
   Master PRD §5.2 cuts four things from MVP that were built anyway: bulk
   generation, the component studio, photoreal mockups, and a four-tier
   pricing table. Deleting working code to re-add it in V2 is waste; hiding
   it behind a flag that defaults off is the same outcome and reversible.
   Flip one in the console (`FLAGS.set('bulk', true)`) to demo it. */
const FLAG_DEFAULTS = {
  bulk:     false,   // PRD §5.2 — V2, gated on a corporate buyer asking
  studio:   false,   // PRD §5.2 — author components in git until the library settles
  mockups:  false,   // PRD §5.2 — render-cost sink that sells nothing yet
  profiles: false,   // multi-tenant adjacent; PRD §5.2 defers orgs entirely
  tiers4:   false    // PRD §5.2 — the pricing table collapses to two lines
};
const FLAGS = {
  get(k){
    const o = lsGet('cardworks.flags', {});
    return k in o ? !!o[k] : !!FLAG_DEFAULTS[k];
  },
  set(k, v){ const o = lsGet('cardworks.flags', {}); o[k] = !!v; lsSet('cardworks.flags', o); draw(); },
  all(){ const o = lsGet('cardworks.flags', {}); return { ...FLAG_DEFAULTS, ...o }; }
};

/* ── Language. The Wireframing Document §5.1 puts this on the Start screen
   rather than inside the brief: defaulting to English before asking is
   itself an English-first bias in a market that is majority Bangla. */
const UI_STRINGS = {
  en: {
    continue:'Continue', back:'Back', skip:'Skip', start:'Start my brief',
    retry:'Try again', offline:'You are offline', saving:'Saving…', loading:'Working…'
  },
  bn: {
    continue:'পরবর্তী', back:'আগে', skip:'বাদ দিন', start:'ব্রিফ শুরু করুন',
    retry:'আবার চেষ্টা করুন', offline:'আপনি অফলাইনে আছেন', saving:'সংরক্ষণ হচ্ছে…', loading:'কাজ চলছে…'
  }
};
function uiLang(){ return lsGet('cardworks.lang', null) || 'en'; }
function setUiLang(l){
  lsSet('cardworks.lang', l === 'bn' ? 'bn' : 'en');
  document.documentElement.setAttribute('lang', l === 'bn' ? 'bn' : 'en');
  draw();
}
const t = k => (UI_STRINGS[uiLang()] || UI_STRINGS.en)[k] || UI_STRINGS.en[k] || k;

/* ── The thumb zone. Wireframe §4: the primary action is bottom-anchored and
   never scrolls out of reach on a phone. Screens call this instead of
   putting a button at the end of their own content. */
function bottomBar(inner){
  return `<div class="actionbar" role="group" aria-label="Primary actions">${inner}</div>`;
}

/* ── Async state. Every network call in this product goes through `api()`,
   which is what makes "loading", "failed" and "offline" a property of the
   shell instead of four different half-implementations. */
const net = { pending:new Set(), lastError:null };

function isOffline(){ return typeof navigator !== 'undefined' && navigator.onLine === false; }

/** Fetch against our own API, returning the parsed body or throwing an
 *  Error carrying `{ code, message, remediation }` from the envelope in
 *  lib/http.mjs. Mutating calls carry an Idempotency-Key so a retry after a
 *  dropped reply cannot become a second order. */
async function api(path, opts = {}){
  const key = 'net:' + path + ':' + (opts.method || 'GET');
  net.pending.add(key); net.lastError = null;
  if (typeof draw === 'function' && opts.quiet !== true) drawPendingOnly();
  try {
    if (isOffline()) {
      const e = new Error('You are offline. Briefing and preview still work; this step needs a connection.');
      e.code = 'offline'; e.remediation = 'Reconnect and try again.'; throw e;
    }
    const headers = { 'content-type':'application/json' };
    const method = opts.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      headers['idempotency-key'] = opts.idempotencyKey ||
        ('idem-' + specHash({ p:path, b:opts.body || null, o:ownerKey(), n:idemNonce() }));
    }
    const res = await fetch(path, {
      method, headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const env = body.error || {};
      const e = new Error(env.message || 'That did not work.');
      e.code = env.code || ('http_' + res.status);
      e.field = env.field; e.remediation = env.remediation;
      throw e;
    }
    return body;
  } catch (err) {
    net.lastError = { code: err.code || 'network', message: err.message,
                      remediation: err.remediation || 'Check your connection and try again.' };
    throw err;
  } finally {
    net.pending.delete(key);
    if (opts.quiet !== true) draw();
  }
}
/* A retry of the same call is the same key; a genuinely new attempt after a
   failure is a new one. The nonce advances only when the user asks again. */
let _idemNonce = 0;
const idemNonce = () => _idemNonce;
const newAttempt = () => { _idemNonce++; };

const isPending = () => net.pending.size > 0;

/** Repaint only the parts that show pending state, so a click feels
    immediate without re-running the composer for every keystroke. */
function drawPendingOnly(){
  $$('[data-pending-when]').forEach(el => {
    const on = isPending();
    el.setAttribute('aria-busy', String(on));
    el.toggleAttribute?.('disabled', on);
  });
}

/** The one loading block. Wireframing §7 lists "Loading" as present only on
    the generating screen; anything async now has one. */
const pendingBlock = (what) =>
  `<div class="state state-pending" role="status" aria-live="polite">
     <span class="spin" aria-hidden="true"></span> ${esc(what || t('loading'))}</div>`;

/** The one failure block. It always names a next step, because the API
    envelope always carries one (Technical Design §8). */
function errorBlock(err, retryLabel){
  const e = err || net.lastError; if (!e) return '';
  return `<div class="state state-error" role="alert">
    <b>${esc(e.message)}</b>
    ${e.remediation ? `<span class="note">${esc(e.remediation)}</span>` : ''}
    ${retryLabel ? `<button class="btn" data-retry="1">${esc(retryLabel)}</button>` : ''}
  </div>`;
}
function bindRetry(fn){
  $$('[data-retry]').forEach(b => b.onclick = () => { newAttempt(); net.lastError = null; fn(); });
}

/** Offline is a first-class state here, not an error: Technical Design §9
    says briefing and preview must keep working with no network at all. */
const offlineBanner = () => isOffline()
  ? `<div class="state state-offline" role="status">${esc(t('offline'))} — briefing and preview still work. Export and ordering need a connection.</div>`
  : '';

/* ── Unsaved work. Wireframing §7 flags this as unhandled: a user who
   refines a design and closes the tab loses it silently. */
const work = { dirty:false, savedHash:null };
function markDirty(){ work.dirty = true; }
function markSaved(hash){ work.dirty = false; work.savedHash = hash || null; }
function beforeUnloadGuard(e){
  if (!work.dirty) return undefined;
  e.preventDefault(); e.returnValue = '';
  return '';
}

/* ── Screen visibility. A flagged-off screen must not be reachable from nav,
   from the stage rail, or by setting the hash by hand. */
const SCREEN_FLAG = { bulk:'bulk', studio:'studio', compedit:'studio',
                      layoutbuild:'studio', mockups:'mockups', profiles:'profiles' };
const screenEnabled = (sc) => !SCREEN_FLAG[sc] || FLAGS.get(SCREEN_FLAG[sc]);
