/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — secondary surfaces
   --------------------------------------------------------------------------
   Library, bulk, mockups, pricing, sign-in, settings and the component studio.
   Master PRD §5.2 cuts several of these from MVP; they live behind flags.
   This file also owns the global half of the states checklist in Wireframing
   §7 — the window-level offline and unsaved-work listeners — because the file
   that renders those banners should be the file that turns them on.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   INSERTED BLOCKS
   --------------------------------------------------------------------------
   The two blocks below are appended into a screen's section rather than
   authored in the markup, because index.html belongs to subgroup B1 and both
   have to appear on screens whose markup was written before the states
   checklist existed. Every DOM call is guarded: the headless test harness
   stubs the document down to a handful of methods, and a missing one must
   make a screen render less, never throw.
   ══════════════════════════════════════════════════════════════════════ */

function sectionOf(screen){
  const sec = (typeof document !== 'undefined' && typeof document.querySelector === 'function')
    ? document.querySelector(`[data-screen="${screen}"]`) : null;
  return (sec && typeof sec.querySelector === 'function' &&
          typeof sec.querySelectorAll === 'function') ? sec : null;
}

/* One reusable node per section per purpose, found by attribute so the same
   node is reused on every draw instead of the section growing on each pass. */
function slotIn(sec, attr, atTop){
  let node = sec.querySelector(`[${attr}]`);
  if (node) return node;
  if (typeof document.createElement !== 'function') return null;
  node = document.createElement('div');
  if (typeof node.setAttribute === 'function') node.setAttribute(attr, '1');
  if (atTop && typeof sec.prepend === 'function') sec.prepend(node);
  else if (typeof sec.appendChild === 'function') sec.appendChild(node);
  else return null;
  return node;
}

/* The per-screen banner slot. Offline is the only thing that uses it today,
   but it is the place a screen-wide status goes so that screens stop each
   inventing their own corner for one. */
function screenNotice(screen, html){
  const sec = sectionOf(screen); if (!sec) return;
  const node = slotIn(sec, 'data-notice', true); if (!node) return;
  node.innerHTML = html || '';
  node.style.display = html ? '' : 'none';
}

/* ── The cuts ─────────────────────────────────────────────────────────────
   Master PRD §5.2 cuts four things that were built anyway, and ui-shell.js
   already keeps them behind flags that default off and refuses to route to
   them. What is left is the case routing cannot catch: a restored session, a
   shared link, or a flag switched off while the screen is open. That has to
   read as a decision rather than a broken page, so the authored markup is
   hidden and one line takes its place naming the document that cut it and
   why. Hidden, not removed — turning the flag back on for a demo must show
   the real screen again, which is the whole argument for flagging over
   deleting. */
const CUT_SCREENS = {
  bulk: { title:'Bulk employee cards are V2 scope',
    why:'Master PRD §5.2 sequences CSV-to-N-cards behind one corporate buyer actually asking to pay for it. The engine already composes and preflights every row on its own; what is missing is the customer, not the code.' },
  mockups: { title:'Photoreal mockups are cut',
    why:'Master PRD §5.2 calls them a render-cost sink that sells nothing at this stage. The composed card is already the accurate preview, and the ordered proof is the only thing that tells the truth about a foil or a soft-touch laminate.' },
  profiles: { title:'Brand profiles wait for accounts',
    why:'Several identities per person is multi-tenant-adjacent, and Master PRD §5.2 defers organisations entirely. Profiles kept in one browser would be lost on the device change that Epic G exists to survive.' },
  studio: { title:'The component studio is an internal V2 tool',
    why:'Master PRD §5.2 is explicit: author components in git until the library stops changing weekly. A UI that publishes a palette into the live library is a customer-facing edit surface for a product whose promise is that there is no edit surface.' },
  compedit: { title:'Authoring components is an internal V2 tool',
    why:'Master PRD §5.2 keeps new palettes and type systems in git while the library is still changing weekly, so that every composition in the suite is reproducible from the repository alone.' },
  layoutbuild: { title:'The layout builder is an internal V2 tool',
    why:'Master PRD §5.2 keeps layouts in git. A layout edited in the browser would not be covered by the preflight suite that makes the print-correct guarantee mean anything.' }
};

/** Hide a cut screen's body behind one honest line. Returns true when the
 *  screen is gated, so the caller stops before touching elements that are no
 *  longer on screen. */
function flagGate(screen){
  const flag = SCREEN_FLAG[screen];
  const on = !flag || FLAGS.get(flag);
  const sec = sectionOf(screen); if (!sec) return !on;
  const cut = CUT_SCREENS[screen] || { title:'This screen is not in MVP scope', why:'Master PRD §5.2 cuts it.' };

  sec.querySelectorAll(':scope > *:not([data-gate])').forEach(n => {
    if (n.style) n.style.display = on ? '' : 'none';
  });
  const node = slotIn(sec, 'data-gate', false); if (!node) return !on;
  node.style.display = on ? 'none' : '';
  if (on){ node.innerHTML = ''; return false; }

  node.innerHTML = `<div class="empty state state-gate" role="status">
    <h6 style="margin:0 0 var(--space-3)">${esc(cut.title)}</h6>
    <p class="lede" style="margin:0">${esc(cut.why)}</p>
    <p class="lede" style="font-size:12px;margin-top:var(--space-3)">It is built and it still works — it is switched off, not deleted. Settings has the switch, and turning it on shows the screen without making it ready.</p>
    <div class="row" style="margin-top:var(--space-4)">
      <button class="btn btn-primary" data-gateback="start">Back to the brief</button>
      <button class="btn" data-gateback="settings">Open settings</button>
    </div></div>`;
  sec.querySelectorAll('[data-gateback]').forEach(b => b.onclick = () => go(b.dataset.gateback));
  return true;
}

/* ── Unsaved work ─────────────────────────────────────────────────────────
   Wireframing §7 lists this as unhandled, and getting the definition right
   matters more than getting a dialog to appear. A warning that fires when
   nothing is at risk is trained away within a day, and then it is not there
   for the one time it was needed.

   A generation is not at risk. The engine is deterministic — the same brief
   returns the same six concepts — and the session round-trips through
   localStorage and the URL hash anyway, so closing the tab costs a keystroke
   to get back. A refinement is different: it is a sequence of typed
   instructions that the brief alone will not reproduce, and only a saved
   design has a copy anywhere but this browser. So dirty means refinement work
   whose current spec is not the one that was last saved. Comparing spec
   hashes makes that a fact rather than a guess, and none of it costs anything
   until the user actually tries to leave. */
let _reconciledCode = null;
function workHash(){
  try { return specHash({ d: currentDesign(), c: readForm() }); }
  catch (e){ return null; }
}
const hasRealWork = () =>
  !!(state.refine || (state.history && state.history.length) ||
     (state.instrLog && state.instrLog.length));

function reconcileDirty(){
  const h = workHash();
  if (state.shareCode && state.shareCode !== _reconciledCode){
    _reconciledCode = state.shareCode; markSaved(h); return work.dirty;
  }
  if (!hasRealWork() || h === null){ work.dirty = false; return false; }
  if (work.savedHash !== h) markDirty(); else work.dirty = false;
  return work.dirty;
}

/* Offline and unsaved-work are window events rather than screen bindings, so
   they are attached here at load time instead of in ui-init.js, which owns
   the DOM wiring. If that turns out to be the wrong home, moving these four
   lines is the whole migration. */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function'){
  const repaint = () => { if (typeof draw === 'function') draw(); };
  window.addEventListener('online',  repaint);
  window.addEventListener('offline', repaint);
  window.addEventListener('beforeunload', e => { reconcileDirty(); return beforeUnloadGuard(e); });
}

/* The library is pure composition, so it is one of the two screens Technical
   Design §9 requires to keep working with no network at all. The banner says
   so rather than leaving the user to guess, and nothing here is disabled. */
/* The cause is read back off the eliminations the composer produced rather
   than guessed at from the content, for the same reason the "why" on a
   concept is derived from the decision trace: a plausible explanation that
   happens to name the wrong field is worse than none. An empty required
   field and a field that will not fit are different problems with different
   fixes, and the engine already knows which one it hit. */
function libraryEmptyHTML(fronts, content, reasons){
  const fmt = FORMATS.find(f => f.id === state.format) || FORMATS[0];
  const tally = {};
  for (const r of (reasons || [])) if (r) tally[r] = (tally[r] || 0) + 1;
  const top = Object.entries(tally).sort((a,b) => b[1] - a[1])[0];
  const required = top && / is required and empty$/.test(top[0]);
  const longest = Object.entries(content || {})
    .filter(([k,v]) => k !== 'logo' && typeof v === 'string')
    .sort((a,b) => (b[1]||'').length - (a[1]||'').length)[0];
  const fix = required
    ? `Every one of them stopped at the same place: <b>${esc(top[0])}</b>. A card without it is not a card, so filling that field in is the whole fix.`
    : longest && longest[1].length > 24
      ? `The longest field is <b>${esc(longest[1].slice(0,42))}${longest[1].length > 42 ? '…' : ''}</b> at ${longest[1].length} characters${
          top ? `, and the first layout to give up said <b>${esc(top[0])}</b>` : ''}. Shortening it, or choosing a larger format, is usually enough.`
      : 'Try a larger format, or move a field to the back of the card.';
  return `<div class="empty state state-empty" style="grid-column:1/-1" role="status">
    <h6 style="margin:0 0 var(--space-3)">Nothing in the library can hold this content</h6>
    <p class="lede" style="margin:0">All ${fronts.length} front layouts were eliminated at ${esc(fmt.name)}. That is the engine refusing to print something that would not survive the press, not an error — but it leaves you with nothing to choose from, so here is what changes it.</p>
    <p class="lede" style="font-size:12.5px;margin-top:var(--space-3)">${fix}</p>
    <div class="row" style="margin-top:var(--space-4)">
      <button class="btn btn-primary" data-libfix="brief">Change the brief</button>
      <button class="btn" data-libfix="noresults">See the costed options</button>
    </div></div>`;
}

function drawLibrary(content){
  screenNotice('library', offlineBanner());
  const fs = (state.script === 'bangla' || state.script === 'bangla-only') ? 'bangla' : null;
  const fronts = LAYOUTS.filter(l => l.face === 'front');
  let live = 0; const cut = [];
  $('#libTiles').innerHTML = fronts.map(L => {
    const c = composeForced(L.id, content, fs);
    const s = renderSVG(c); if (s) live++; else cut.push(c.eliminated || '');
    return `<button class="tile ${s?'':'dead'}" role="button" tabindex="0"
      aria-pressed="${L.id===state.layout}" data-lay="${L.id}" ${s?'':'disabled'}>
      ${s || `<div class="deadbox"><span class="pill pill-warn">Eliminated</span>
        <span class="tilemeta">${esc(c.eliminated||'')}</span></div>`}
      <span class="tiletitle">${esc(L.name)}</span>
      <span class="tilemeta">${esc(L.family)} · ${
        s ? (c.trace.length ? c.trace.length + ' fit adjustment(s)' : 'fits as authored') : 'cannot hold this content'}</span>
    </button>`;
  }).join('');
  $('#libMeta').textContent = `${live} of ${fronts.length} can hold this content at ${
    FORMATS.find(f=>f.id===state.format).name}`;
  if (!live){
    $('#libTiles').innerHTML = libraryEmptyHTML(fronts, content, cut);
    $$('#libTiles [data-libfix]').forEach(b => b.onclick = () =>
      go(b.dataset.libfix === 'brief' ? 'brief' : 'noresults'));
    return;
  }
  bindTiles('#libTiles .tile', t => {
    if (!t.dataset.lay) return;
    state.layout = t.dataset.lay; state.refine = null; go('detail');
  });
}

/* ── Bulk ──────────────────────────────────────────────────────────────── */
function drawBulk(design, content){
  if (flagGate('bulk')) return;
  const { front } = facesFor(design, content);
  $('#bulkTemplate').innerHTML = renderSVG(front) || '<div class="deadbox"><span class="pill pill-warn">Eliminated</span></div>';
  const B = state.bulk;
  if (!B){ $('#bulkOut').innerHTML = ''; $('#bulkTiles').innerHTML = ''; $('#bulkMeta').textContent = ''; return; }
  const bad = B.rows.filter(r => !r.ok).length;
  $('#bulkMeta').textContent = `${B.ok} of ${B.total} rows composed`;
  $('#bulkOut').innerHTML = `<div class="tally" style="margin-top:14px">
    <span><b>${B.ok}</b> composed</span><span><b>${bad}</b> eliminated</span></div>
    ${bad ? `<p class="lede" style="font-size:12.5px">Those people need a different layout, and the system says so rather than printing them wrong.</p>` : ''}`;
  $('#bulkTiles').innerHTML = B.rows.slice(0,24).map(r => {
    const s = r.ok ? renderSVG(r.composed) : null;
    const pf = r.ok ? preflight(r.composed) : [];
    return `<div class="tile" style="cursor:default">
      ${s || `<div class="deadbox"><span class="pill pill-warn">Eliminated</span>
        <span class="tilemeta">${esc(r.eliminated||'')}</span></div>`}
      <span class="tiletitle">${String(r.index).padStart(3,'0')} · ${esc(r.name||'(no name)')}</span>
      <span class="tilemeta">${r.ok
        ? `${pf.filter(f=>f.s==='fail').length} blocking · ${pf.filter(f=>f.s==='review').length} advisory`
        : 'not printable in this layout'}</span></div>`;
  }).join('') + (B.total > 24 ? '' : '');
}

function drawProfiles(design, content){
  if (flagGate('profiles')) return;
  screenNotice('profiles', offlineBanner());
  const profs = lsGet('cardworks.profiles', []);
  $('#profileList').innerHTML = profs.length ? profs.map((p,i) =>
    `<button class="check" style="width:100%;text-align:left;border:0;border-bottom:1px solid var(--hair);cursor:pointer;background:${
      i===state.profileIdx?'var(--color-accent-100)':'transparent'};font:inherit" data-prof="${i}">
      <span style="flex:1"><b>${esc(p.name)}</b><span class="note">${esc(p.role||'')} ${p.company?'· '+esc(p.company):''}</span></span>
      <span style="display:flex;gap:3px">${(p.pal||[]).map(c =>
        `<span style="width:15px;height:15px;background:${esc(c)};border:1px solid var(--hair);display:block"></span>`).join('')}</span>
    </button>`).join('') : `<div class="empty state state-empty" role="status">
      <h6 style="margin:0 0 var(--space-3)">No profiles yet</h6>
      <p class="lede" style="margin:0">A profile is a saved brief — one person's contact set, palette and card history — so a board card never inherits the freelance palette. There is nothing to show until you save one.</p>
      <p class="lede" style="font-size:12px;margin-top:var(--space-3)">They are held in this browser only, which is why Master PRD §5.2 defers them until accounts exist.</p>
      <div class="row" style="margin-top:var(--space-4)">
        <button class="btn btn-primary" data-proffix="brief">Fill in a brief first</button></div></div>`;
  $$('#profileList [data-prof]').forEach(b => b.onclick = () => { state.profileIdx = Number(b.dataset.prof); draw(); });
  $$('#profileList [data-proffix]').forEach(b => b.onclick = () => { state.step = 0; go('brief'); });

  const p = profs[state.profileIdx];
  $('#profileDetail').innerHTML = p ? `<dl class="kv">
      <dt>Name</dt><dd>${esc(p.name)}</dd><dt>Role</dt><dd>${esc(p.role||'—')}</dd>
      <dt>Company</dt><dd>${esc(p.company||'—')}</dd><dt>বাংলা</dt><dd>${esc(p.bname||'—')}</dd>
      <dt>Palette</dt><dd>${esc((PALETTES.find(x=>x.id===p.palette)||{}).name || p.palette || '—')}</dd>
      <dt>Cards</dt><dd>${p.cards||0}</dd></dl>
    <div class="row" style="margin-top:var(--space-4)">
      <button class="btn btn-primary" id="b_useprofile">New card from this</button>
      <button class="btn" id="b_delprofile">Delete</button></div>`
    : '<p class="lede">Select a profile.</p>';
  if (p){
    $('#b_useprofile').onclick = () => {
      writeForm(p); state.palette = p.palette || state.palette; state.step = 0; go('brief');
    };
    $('#b_delprofile').onclick = () => {
      const n = lsGet('cardworks.profiles', []); n.splice(state.profileIdx,1);
      lsSet('cardworks.profiles', n); state.profileIdx = 0; draw();
    };
  }
}

/* ── MOCKUPS — the real card, composited. Not a grey rectangle. ──────────── */
function sceneHTML(scene, front, back, big){
  const card = renderSVG(front) || '';
  const bk = renderSVG(back) || '';
  const h = big ? 'min(46vh,340px)' : '150px';
  const shadow = '0 14px 30px rgba(0,0,0,.34), 0 3px 8px rgba(0,0,0,.22)';
  // A rotated card needs more room than its unrotated width, or the corners
  // clip against the scene edge. Padding scales with the hero size.
  const wrap = inner => `<div style="background:${scene.ground};height:${h};display:flex;
    align-items:center;justify-content:center;gap:${big?'28px':'14px'};overflow:hidden;
    padding:${big?'42px':'20px'}">${inner}</div>`;
  const one = (svgStr, rot, w) => `<div style="width:${w};transform:rotate(${rot}deg);box-shadow:${shadow}">${svgStr}</div>`;
  if (scene.arrange === 'stack')
    return wrap(`<div style="position:relative;width:${big?'54%':'62%'}">
      <div style="position:absolute;inset:0;transform:translate(14px,14px) rotate(4deg);box-shadow:${shadow};opacity:.85">${card}</div>
      <div style="position:absolute;inset:0;transform:translate(7px,7px) rotate(2deg);box-shadow:${shadow};opacity:.93">${card}</div>
      <div style="position:relative;box-shadow:${shadow}">${card}</div></div>`);
  if (scene.arrange === 'pair')
    return wrap(one(card, -4, big?'36%':'42%') + one(bk, 4, big?'36%':'42%'));
  if (scene.arrange === 'flat')  return wrap(one(card, 0, big?'46%':'60%'));
  return wrap(one(card, -7, big?'44%':'58%'));
}
function drawMockups(design, content){
  if (flagGate('mockups')) return;
  const { front, back } = facesFor(design, content);
  $('#scenes').innerHTML = SCENES.map(s =>
    `<button class="chip" data-scene="${esc(s.k)}" aria-pressed="${s.k===state.scene}">${esc(s.k)}</button>`).join('');
  $$('#scenes .chip').forEach(b => b.onclick = () => { state.scene = b.dataset.scene; draw(); });
  const sc = SCENES.find(s => s.k === state.scene) || SCENES[0];
  $('#mockHero').innerHTML = sceneHTML(sc, front, back, true);
  $('#mockGrid').innerHTML = SCENES.map(s => `<div class="tile" style="cursor:default;padding:0">
    ${sceneHTML(s, front, back, false)}
    <span class="tiletitle" style="padding:0 var(--space-6) var(--space-4)">${esc(s.k)}</span></div>`).join('');
}

/* ── PRICING ───────────────────────────────────────────────────────────────
   Master PRD §5.2 collapses four tiers to two, and §9 says why: an individual
   buys visiting cards about once every eighteen months, so monthly billing
   guarantees churn immediately after the single moment of value — and it
   would have to collect that money over rails that do not exist here, because
   bKash and Nagad are built for one-off pushes rather than silent monthly
   pulls. A subscription-first product fails at the payment layer before it
   ever gets to fail at the value layer.

   So the two lines below are not two tiers of access. They are the two
   moments where something real is handed over: the file, and the printed
   card. §9's pricing principle is that we charge then and never for reaching
   the tool, which is what makes the free tier a permanent state of the
   product rather than a trial with a clock on it. The old table is kept
   whole behind the `tiers4` flag so the argument stays checkable. */
const PRICE_LINES = [
  { name:'File pack', price:'৳199', per:'one-off, for this design',
    who:'The print-ready PDF/X-4 and the print-geometry SVGs, plus a separation plate for every foil and spot-UV finish you chose. Take it to any press in the country, including one of ours. It also takes the watermark off the preview.',
    when:'Charged when you unlock the file — after you have seen the exact card it makes, and never for reaching the tool.' },
  { name:'Printed and delivered', price:'৳1,300', per:'per 500 cards',
    who:'The same file, routed to a partner press we have quoted, printed and delivered. ৳600 per 100 · ৳1,300 per 500 · ৳2,400 per 1,000. The file pack is credited against it, so you never pay for the design twice.',
    when:'Charged when you approve the proof — not at checkout, and never before you have seen what will be printed.' }
];
/* Free is a column here rather than a line above, because it is not something
   anyone buys. §9 defines it exactly: unlimited briefs, six concepts,
   watermarked previews, no export and no order.

   Every cell in the free column is now a claim the code keeps rather than a
   description of one. `lib/entitlements.mjs` refuses export and order without
   a grant, `assets/ui-misc.js` marks the preview, and nothing anywhere asks
   for a signup to reach a concept — which is why "Account needed to get here"
   is a row at all. A pricing table that describes a tier the product does not
   enforce is a worse document than no table, and this one was that until the
   gate existed. */
const PRICE_COLS = ['Free', 'File pack', 'Printed'];
const PRICE_ROWS = [
  ['Briefs',                            'Unlimited','Unlimited','Unlimited'],
  ['Concepts per brief',                '6','6','6'],
  ['Typed refinement and re-composition','Yes','Yes','Yes'],
  ['Bangla and English, bilingual',     'Yes','Yes','Yes'],
  ['Full preflight report',             'Yes','Yes','Yes'],
  ['Account needed to get here',        'No','No','No'],
  ['Preview',                           'Watermarked','Clean','Clean'],
  ['Print-ready PDF/X-4',               '—','Yes','Yes'],
  ['Print-geometry SVG documents',      '—','Yes','Yes'],
  ['Foil and spot-UV separations',      '—','Yes','Yes'],
  ['Printing and delivery',             '—','—','Yes'],
  ['Proof before anything is charged',  '—','—','Yes']
];

function drawPricing(){
  screenNotice('pricing', offlineBanner());
  const four = FLAGS.get('tiers4');
  const lines = four ? PLANS : PRICE_LINES;
  const rows  = four ? PLAN_ROWS : PRICE_ROWS;
  const plans = $('#plans');
  /* The markup sizes this grid for four tiers. Two of them in four columns
     reads as two things missing rather than two things offered. */
  if (plans.style) plans.style.gridTemplateColumns =
    four ? 'repeat(4,1fr)' : 'repeat(auto-fit,minmax(240px,1fr))';
  plans.innerHTML = lines.map((p,i) => `<div class="tile" style="cursor:default">
    <span class="tiletitle" style="color:${i===(four?2:1)?'var(--color-accent)':'inherit'}">${esc(p.name)}</span>
    <h3 style="margin:0">${esc(p.price)}</h3>
    <span class="tilemeta">${esc(p.per)}</span>
    <span class="tilemeta" style="flex:1">${esc(p.who)}</span>
    ${p.when ? `<span class="tilemeta" style="color:var(--color-accent)">${esc(p.when)}</span>` : ''}
    <span class="btn ${i===(four?2:1)?'btn-primary':''}" style="pointer-events:none;align-self:flex-start">${four?'Choose':'Design first'}</span></div>`).join('');

  const head = four ? '' : `<div class="check"><span style="flex:1"><b>What you get</b></span>${
    PRICE_COLS.map(c => `<span class="scorenum" style="width:88px;text-align:center">${esc(c)}</span>`).join('')}</div>`;
  $('#planRows').innerHTML = head + rows.map(r =>
    `<div class="check"><span style="flex:1">${esc(r[0])}</span>${
      r.slice(1).map(v => `<span class="scorenum" style="width:88px;text-align:center">${esc(v)}</span>`).join('')}</div>`).join('')
    + (four ? '' : `<p class="lede" style="font-size:12.5px;margin-top:var(--space-4)">The free column is not a trial and has no clock on it. Briefing, generating six concepts and refining them cost us close to nothing, because nothing here calls a language model — so we charge at the moment something real is handed over, and not for reaching the tool.</p>
    <p class="lede" style="font-size:12.5px;margin-top:var(--space-3)">What the free column withholds is one thing, said plainly: the file. A free preview carries a CARDWORKS mark in the corner and a faint one across the card, and it is yours to screenshot, post and send to anyone — that is what it is for. What it is not is a press file, and no press should be sent one.</p>
    <p class="lede" style="font-size:12px;margin-top:var(--space-3);color:var(--color-accent)">Both prices are estimates. Master PRD §8.1 requires real quotes from Dhaka presses before this becomes a public price list, and those visits have not happened yet. Payment for a file pack is not wired up on this build either: bKash and Nagad capture against an order reference and this line has none yet, so the price above is what it will cost rather than something you can pay today.</p>`);
}

/* ── SIGN IN — an honest local profile, and the seam for a real one ────────
   Subgroup A5 is building phone-OTP accounts in netlify/functions/auth.mjs.
   Until that endpoint answers there is no session to show, and the screen
   says so instead of miming a password field it cannot honour. Everything
   below is arranged so that adopting A5's session is a small change: one
   reader for the stored user, one submit function whose async branch is
   already written with its pending, failure, offline and permission-denied
   states, and a flag that turns it on.

   The flag is deliberately not in ui-shell.js's FLAG_DEFAULTS, which is
   frozen — FLAGS.get returns false for a key it has never seen, so `accounts`
   defaults off for free and FLAGS.set turns it on. */
const authState = { busy:false, err:null, sent:false, phone:'', claim:null };

/** The one place that knows the shape of a session. netlify/functions/auth.mjs
 *  answers a verify with `{ token, expiresAt, user:{ id, phone, name } }`; if
 *  that shape changes, this reader and submitSignin() are the only two things
 *  that move. An expired token is not a session, and saying so here means no
 *  screen has to remember to check. */
function sessionUser(){
  if (!FLAGS.get('accounts')) return null;
  const s = lsGet('cardworks.session.user', null);
  if (!s || typeof s !== 'object' || !s.user || !s.user.id) return null;
  if (s.expiresAt && Date.parse(s.expiresAt) <= Date.now()) return null;
  return s.user;
}

/* The session travels as a bearer header rather than a cookie, so it has to
   be attached deliberately on every authenticated call. Reading the stored
   record directly rather than through sessionUser() is intentional: an
   expired token is still worth sending, because the server's 401 with
   `remediation: 'sign_in'` is a better answer than this file guessing. */
function authHeaders(){
  const s = lsGet('cardworks.session.user', null);
  return (s && s.token) ? { authorization: 'Bearer ' + s.token } : {};
}

/** Sign out. The local session is cleared whatever the server says, because
 *  a user who asked to be signed out on this device must end up signed out on
 *  this device — a failed round trip is a reason to tell them the other
 *  devices may still be live, not a reason to leave them logged in here. */
async function signOut(){
  authState.busy = true; authState.err = null; draw();
  try {
    await api('/api/auth', { method:'POST', quiet:true,
      headers:authHeaders(), body:{ action:'logout' } });
  } catch (err){
    authState.err = { code: err.code || 'network',
      message:'Signed out on this device, but the server did not confirm it.',
      remediation:'If you were signing out because someone else has your phone, sign in again from a device you trust to end the other sessions.' };
  } finally {
    lsSet('cardworks.session.user', null);
    authState.busy = false; authState.sent = false; authState.claim = null;
    draw();
  }
}

/** Rendered as a string rather than written into the DOM so the states are
 *  assertable without a browser, which is the only reason the checklist in
 *  Wireframing §7 can be checked off rather than claimed. */
function signinStateHTML(){
  /* The state block sits above the form rather than in place of it. An error
     that says "enter a mobile number" while removing the field to enter it in
     is worse than no message at all, and that is exactly what an early return
     produces here. */
  let head = '';
  if (authState.busy) head = pendingBlock('Checking that number…');
  else if (authState.err){
    /* Branch on remediation, never on code. A mistyped digit and a dead
       session both come back 401 `unauthorized`, and telling them apart by
       status would throw someone who fat-fingered one number out to the
       sign-in screen they are already looking at. `remediation` is the field
       that carries the difference, which is what Technical Design §8 has it
       for. This is also where Wireframing §7's permission-denied row stops
       being N/A: `sign_in` is the real one.

       The message itself is rendered as the server wrote it. Wrong, expired,
       already spent and never issued are four causes behind one sentence on
       purpose, and a more specific message inferred here would hand a
       stranger the half of the problem they had not worked out yet. */
    const rem = authState.err.remediation || '';
    /* errorBlock turns the token into a sentence through remedyText, so the
       error is passed through whole rather than rewritten on the way in. */
    head = errorBlock(authState.err,
      rem === 'request_new_code' ? 'Send a new code'
      : rem === 'sign_in'        ? 'Sign in again'
      : t('retry'));
  }
  if (isOffline())
    head += offlineBanner() + `<p class="lede" style="font-size:12.5px">Signing in needs a connection. Briefing, generating and refining do not, so you can keep working and sign in later.</p>`;
  const u = sessionUser();
  if (u) return head + checkRow({ s:'pass', label:`Signed in as ${u.name || u.phone}`,
      note:'Your designs and orders follow this number to any device.' })
    + claimHTML()
    + `<div class="row" style="margin-top:var(--space-4)">
         <button class="btn" data-signout="1">Sign out on this device</button></div>`;
  /* The two steps of the OTP flow. The fields are rendered here rather than
     authored in index.html because that file belongs to subgroup B1, who is
     rebuilding the shell; when proper markup exists these two blocks become
     one selector each. */
  if (FLAGS.get('accounts')) return head + (authState.sent
    ? `<div class="field"><label for="i_acctcode">The six-digit code we sent to ${esc(authState.phone)}</label>
         <input class="input" id="i_acctcode" inputmode="numeric" autocomplete="one-time-code"
                maxlength="6" spellcheck="false"></div>
       <p class="lede" style="font-size:12px">It expires in a few minutes. <button class="btn btn-ghost" data-authback="1">Use a different number</button></p>`
    : `<div class="field"><label for="i_acctphone">Mobile number</label>
         <input class="input" id="i_acctphone" inputmode="tel" autocomplete="tel"
                placeholder="01712345678" value="${esc(authState.phone)}"></div>
       <p class="lede" style="font-size:12px">We send a code to this number. No password, and nothing else is asked for.</p>`);
  const acct = lsGet('cardworks.account', {});
  return head + (acct.name
      ? checkRow({ s:'pass', label:`Labelled locally as ${acct.name}`,
          note:'It labels the designs and orders you save from this browser. It is not a login and it grants nothing.' })
      : '')
    + `<div class="state state-empty" role="status"><b>There is no account yet.</b>
       <span class="note">Everything you save is keyed to this browser (${esc((ownerKey()||'—').slice(0,10))}…). Clear this browser's data, or open the product on your phone instead, and it will not be there. Phone-number sign-in is being built; this screen will not pretend to have it in the meantime.</span></div>`;
}

/* Signing in moves the anonymous work on this browser onto the account, and
   the endpoint reports whether it managed to. Saying "nothing moved" is worth
   more than saying nothing: it is the difference between a user who knows to
   go looking and one who assumes their designs are gone. The ordinary repeat
   sign-in on a browser already claimed is the exception — `already_yours`
   means nothing needed to move, and reporting a non-event as an outcome
   teaches people to stop reading the ones that matter. */
function claimHTML(){
  const c = authState.claim; if (!c || !c.attempted) return '';
  if (c.moved) return checkRow({ s:'pass',
    label:`${c.designs || 0} design(s) and ${c.orders || 0} order(s) moved to your account`,
    note:'They are no longer tied to this browser.' });
  if (c.reason === 'already_yours') return '';
  return checkRow({ s:'review', label:'Nothing from this browser moved across',
    note:'Anything saved here before is still reachable from this browser; it is just not on the account.' });
}

/** The submit path. Behind the flag it is the real two-step OTP flow against
 *  netlify/functions/auth.mjs — ask for a code, then prove it — carrying this
 *  browser's owner key so anonymous work comes along. With the flag off it is
 *  the local label, which is all this product can honestly offer. Either way
 *  there is one pending state and one failure state, and no path is silent. */
/* The server normalises 01712345678, 8801712345678 and +880 1712-345678 to
   one canonical form, so this check exists only to stop an unusable number
   spending one of the user's rate-limit buckets — it must accept everything
   the server would. Anything that gets past it is sent exactly as typed;
   pre-formatting here would be this file quietly holding a second opinion
   about what a phone number is. */
const looksLikeBdMobile = (s) => {
  /* Deliberately the same two lines as `normalisePhone` in lib/http.mjs —
     strip everything that is not a digit, then allow an optional 88 in front
     of the trunk-zero form. Approximating it here rather than copying it is
     how a client check ends up rejecting a number the server would have
     taken, which is worse than having no check at all. */
  const d = String(s || '').replace(/[^\d]/g, '');
  return /^(?:88)?01[3-9]\d{8}$/.test(d);
};

async function submitSignin(force){
  authState.err = null;

  if (!FLAGS.get('accounts')){
    const name = (($('#i_acctname') || {}).value || '').trim();
    const email = (($('#i_acctemail') || {}).value || '').trim();
    if (!name){
      authState.err = { code:'bad_request', field:'name',
        message:'A name is needed to label your work.', remediation:'fix_name' };
      draw(); return;
    }
    lsSet('cardworks.account', { name, email });
    draw(); return;
  }

  /* `force` is the resend: ask for a new code without sending the user back
     to the number they have already typed correctly once. */
  const step = force || (authState.sent ? 'verify' : 'request');
  if (step === 'request'){
    const typed = (($('#i_acctphone') || {}).value || '').trim() || authState.phone;
    if (!looksLikeBdMobile(typed)){
      authState.err = { code:'bad_request', field:'phone',
        message:'Enter a Bangladeshi mobile number, like 01712345678.',
        remediation:'fix_phone' };
      draw(); return;
    }
    authState.phone = typed;
  } else if (!/^\d{6}$/.test((($('#i_acctcode') || {}).value || '').trim())){
    authState.err = { code:'bad_request', field:'code',
      message:'The code is six digits.', remediation:'fix_code' };
    draw(); return;
  }

  authState.busy = true; draw();
  try {
    /* quiet: this screen paints its own pending and failure blocks, so api()
       must not repaint underneath it mid-request. */
    const r = await api('/api/auth', { method:'POST', quiet:true, body:
      step === 'request'
        ? { action:'request', phone:authState.phone, locale:uiLang() }
        : { action:'verify', phone:authState.phone, locale:uiLang(),
            code:$('#i_acctcode').value.trim(),
            name:(($('#i_acctname') || {}).value || '').trim() || undefined,
            ownerKey:ownerKey() } });
    authState.busy = false;
    if (step === 'request'){ authState.sent = true; }
    else {
      /* The token is stored beside the user because it is the session, and
         every authenticated call has to present it through authHeaders(). */
      lsSet('cardworks.session.user', { user:r.user, token:r.token, expiresAt:r.expiresAt });
      authState.sent = false; authState.claim = r.claim || null;
      if (r.user && r.user.name) lsSet('cardworks.account', { name:r.user.name, email:'' });
    }
    draw();
  } catch (err){
    authState.busy = false;
    authState.err = net.lastError || { code: err.code || 'network', message: err.message,
      remediation:'Check your connection and try again. Nothing you have designed is lost.' };
    draw();
  }
}

function drawSignin(){
  screenNotice('signin', '');
  const acct = lsGet('cardworks.account', {});
  if ($('#i_acctname') && !$('#i_acctname').value) $('#i_acctname').value = acct.name || '';
  if ($('#i_acctemail') && !$('#i_acctemail').value) $('#i_acctemail').value = acct.email || '';
  const n = LAYOUTS.filter(l=>l.face==='front').length * PALETTES.length * TYPE_SYSTEMS.length;
  $('#signinStat').textContent =
    `${n.toLocaleString('en-IN')} compositions from ${LAYOUTS.length} layouts, ${PALETTES.length} palettes and ${TYPE_SYSTEMS.length} type systems — composed against your brief, not guessed at by an image model.`;
  $('#signinOut').innerHTML = signinStateHTML();
  /* The shell's bindRetry() searches the whole document, which would hand
     this screen's handler to a retry button another screen had rendered and
     not yet repainted. Same contract, one section wide. A refused code sends
     the user back to step one, because the only fix for it is a new code. */
  $$('#signinOut [data-retry]').forEach(b => b.onclick = () => {
    newAttempt(); net.lastError = null;
    const rem = (authState.err && authState.err.remediation) || '';
    authState.err = null;
    /* A rejected code needs a new code, not a new number — the field stays
       where it is and the request goes out again for the same phone. A dead
       session is the other 401 and does mean starting over, which is why
       these two branches read remediation instead of status. */
    if (rem === 'request_new_code'){ submitSignin('request'); return; }
    if (rem === 'sign_in'){
      lsSet('cardworks.session.user', null);
      authState.sent = false; authState.claim = null; draw(); return;
    }
    submitSignin();
  });
  $$('#signinOut [data-authback]').forEach(b => b.onclick = () => {
    authState.sent = false; authState.err = null; draw();
  });
  $$('#signinOut [data-signout]').forEach(b => b.onclick = signOut);
  /* ui-init.js binds this button at start-up for the local-profile case; the
     screen that owns the states owns the submit, so it is rebound here on
     every draw rather than left split across two files. */
  const btn = $('#b_signin');
  if (btn){
    btn.onclick = submitSignin;
    btn.textContent = !FLAGS.get('accounts') ? t('continue')
      : sessionUser() ? 'Signed in'
      : authState.sent ? 'Sign in' : 'Send me a code';
    btn.setAttribute('aria-busy', String(authState.busy));
    if (typeof btn.toggleAttribute === 'function')
      btn.toggleAttribute('disabled', authState.busy || !!sessionUser());
  }
}

/* ── SETTINGS ──────────────────────────────────────────────────────────────
   Settings is where a cut screen can be switched on for a demo. That is an
   internal act and the panel says so, because a customer reading this list
   would reasonably conclude the four are features they have not paid for
   rather than scope the PRD holds back. */
const FLAG_LABELS = {
  bulk:     ['Bulk employee cards',   'PRD §5.2 — V2, gated on a corporate buyer asking'],
  studio:   ['Component studio',      'PRD §5.2 — components are authored in git for now'],
  mockups:  ['Photoreal mockups',     'PRD §5.2 — render cost that sells nothing yet'],
  profiles: ['Brand profiles',        'PRD §5.2 — waits for real accounts'],
  tiers4:   ['Four pricing tiers',    'PRD §5.2 and §9 — the price list is two lines'],
  accounts: ['Phone sign-in',         'Epic G — turns on /api/auth once A5 has deployed it']
};
function drawFlagPanel(){
  const sec = sectionOf('settings'); if (!sec) return;
  const node = slotIn(sec, 'data-flags', false); if (!node) return;
  const all = { ...FLAGS.all(), accounts: FLAGS.get('accounts') };
  const on = Object.keys(all).filter(k => all[k]).length;
  node.innerHTML = `<div class="sectionhd" style="border-top:var(--rule)">
      <div><h5>Scope switches — internal</h5>
      <span class="micro">${on} of ${Object.keys(all).length} on</span></div></div>
    <div class="pane stack">
      <p class="lede" style="margin-top:0">These are not product settings. Master PRD §5.2 cuts six things from MVP that are built and working, and these are the switches that hold them out of the build. Turning one on shows the screen; it does not make it ready, and nothing behind them has been validated against §8.1.</p>
      <div class="chips" role="group" aria-label="Scope switches" id="flagChips">${
        Object.entries(FLAG_LABELS).map(([k,[label,why]]) =>
          `<button class="chip" data-flag="${k}" aria-pressed="${!!all[k]}" title="${esc(why)}">${esc(label)}</button>`).join('')}</div>
      <dl class="kv">${Object.entries(FLAG_LABELS).map(([k,[label,why]]) =>
        `<dt>${esc(label)}</dt><dd>${esc(why)}</dd>`).join('')}</dl>
    </div>`;
  sec.querySelectorAll('#flagChips [data-flag]').forEach(b => b.onclick = () => {
    const k = b.dataset.flag;
    FLAGS.set(k, !FLAGS.get(k));
  });
}

function drawSettings(){
  screenNotice('settings', offlineBanner());
  drawFlagPanel();
  const set = lsGet('cardworks.settings', { units:'mm', count:6, budget:'standard', notifs:[0,1] });
  if ($('#i_setmarket').innerHTML === '')
    $('#i_setmarket').innerHTML = FORMATS.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
  $('#i_setmarket').value = state.format;
  $('#i_setunits').value = set.units; $('#i_setcount').value = String(set.count);
  $('#i_setbudget').value = set.budget;
  $('#notifs').innerHTML = NOTIFS.map(([l],i) =>
    `<button class="chip" data-notif="${i}" aria-pressed="${set.notifs.includes(i)}">${esc(l)}</button>`).join('');
  $$('#notifs .chip').forEach(b => b.onclick = () => {
    const s = lsGet('cardworks.settings', set); const i = Number(b.dataset.notif);
    const k = s.notifs.indexOf(i); k >= 0 ? s.notifs.splice(k,1) : s.notifs.push(i);
    lsSet('cardworks.settings', s); draw();
  });
  const profs = lsGet('cardworks.profiles', []);
  $('#setKv').innerHTML = [
    ['Local key', (ownerKey()||'—').slice(0,14) + '…'],
    ['Brand profiles', String(profs.length)],
    ['Concepts', String(set.count)],
    ['Units', set.units === 'mm' ? 'Millimetres' : 'Inches']
  ].map(([k,v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

/* ── STUDIO — the real component library ─────────────────────────────────── */
function libraryCats(){
  return [
    { k:'Layouts',            items:LAYOUTS.map(l => ({ id:l.id, name:l.name,
        meta:`${l.face} · ${l.family||'back'} · ${l.slots.length} slots`,
        detail:{ 'Slots':l.slots.map(s=>s.ref).filter(r=>!r.startsWith('_')).join(', '),
                 'Portrait':l.portrait?'authored':'landscape only',
                 'Square':l.square?'authored':'not authored',
                 'Grid':'12 × 8 (8 × 12 portrait)' } })) },
    { k:'Colour systems',     items:PALETTES.map(p => ({ id:p.id, name:p.name,
        meta:`${p.bg} · ${p.accent}`, swatch:[p.bg,p.fg,p.accent,p.panel],
        detail:{ 'Ground':p.bg, 'Ink':p.fg, 'Accent':p.accent, 'Panel':p.panel,
                 'Contrast':contrast(p.fg,p.bg).toFixed(1)+':1' } })) },
    { k:'Typography systems', items:TYPE_SYSTEMS.map(t => ({ id:t.id, name:t.name,
        meta:t.note, detail:{ 'Latin':t.latin, 'Bangla':t.bangla,
          'Bangla coverage':t.banglaOk?'yes':'no', 'Name weight':String(t.weightName) } })) },
    { k:'Finishing systems',  items:Object.entries(FINISH_COST).map(([k,f]) => ({ id:k, name:f.label,
        meta:`setup ${taka(f.setup)} · ${taka(f.per1000)}/1000`,
        detail:{ 'One-off setup':taka(f.setup), 'Per 1000':taka(f.per1000),
                 'Presses':PRESSES.filter(p=>p.can.includes(k)).map(p=>p.name.split(',')[0]).join(', ') || 'none' } })) }
  ];
}
function drawStudio(){
  if (flagGate('studio')) return;
  const cats = libraryCats();
  const total = cats.reduce((s,c) => s + c.items.length, 0);
  $('#studioMeta').textContent = `${total} components across ${cats.length} categories — the live library this build composes from`;
  $('#libCats').innerHTML = cats.map(c =>
    `<button class="chip" data-cat="${esc(c.k)}" aria-pressed="${c.k===state.libCat}">${esc(c.k)} <span class="scorenum">${c.items.length}</span></button>`).join('');
  $$('#libCats .chip').forEach(b => b.onclick = () => { state.libCat = b.dataset.cat; state.compId = 0; draw(); });
  const cat = cats.find(c => c.k === state.libCat) || cats[0];
  $('#componentList').innerHTML = cat.items.map((it,i) =>
    `<button class="check" style="width:100%;text-align:left;border:0;border-bottom:1px solid var(--hair);cursor:pointer;background:${
      i===state.compId?'var(--color-accent-100)':'transparent'};font:inherit" data-comp="${i}">
      <span style="flex:1"><b>${esc(it.name)}</b><span class="note mono">${esc(it.id)} · ${esc(it.meta)}</span></span>
      ${it.swatch ? `<span style="display:flex;gap:3px">${it.swatch.filter(Boolean).map(c=>
        `<span style="width:15px;height:15px;background:${esc(c)};border:1px solid var(--hair);display:block"></span>`).join('')}</span>` : ''}
    </button>`).join('');
  $$('#componentList [data-comp]').forEach(b => b.onclick = () => { state.compId = Number(b.dataset.comp); draw(); });
  const it = cat.items[state.compId] || cat.items[0];
  $('#componentDetail').innerHTML = it
    ? `<b>${esc(it.name)}</b><p class="lede mono" style="font-size:11px;margin-top:4px">${esc(it.id)}</p>
       <dl class="kv" style="margin-top:var(--space-4)">${Object.entries(it.detail)
         .map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    : '<p class="lede">Nothing selected.</p>';
}

/* ── NEW COMPONENT — published into the live library ─────────────────────── */
function drawCompEdit(){
  if (flagGate('compedit')) return;
  const kind = $('#i_ckind').value;
  if (state.compKind !== kind){
    state.compKind = kind;
    $('#compFields').innerHTML = kind === 'palette'
      ? `<div class="grid2">
          <div class="field"><label for="i_cbg">Ground</label><input class="input" id="i_cbg" value="#101c2c"></div>
          <div class="field"><label for="i_cfg">Ink</label><input class="input" id="i_cfg" value="#f2efe9"></div>
          <div class="field"><label for="i_cac">Accent</label><input class="input" id="i_cac" value="#c8a45c"></div>
          <div class="field"><label for="i_cpn">Panel</label><input class="input" id="i_cpn" value="#101c2c"></div>
         </div>`
      : `<div class="grid2">
          <div class="field"><label for="i_clat">Latin family</label><input class="input" id="i_clat" value="'Libre Franklin',sans-serif"></div>
          <div class="field"><label for="i_cbn">Bangla family</label><input class="input" id="i_cbn" value="'Noto Sans Bengali',sans-serif"></div>
         </div>`;
  }
  $('#compTags').innerHTML = AXES.map(a =>
    `<button class="chip chip-sm" data-ctag="${a}" aria-pressed="${(state.compTags||[]).includes(a)}">${AXIS_WORD[a]}</button>`).join('');
  $$('#compTags .chip').forEach(b => b.onclick = () => {
    state.compTags = state.compTags || [];
    const i = state.compTags.indexOf(b.dataset.ctag);
    i >= 0 ? state.compTags.splice(i,1) : state.compTags.push(b.dataset.ctag);
    draw();
  });
  // Live preview using the values as typed
  try {
    const content = readForm();
    const over = kind === 'palette' ? { palette:'__preview' } : { type:'__preview' };
    if (kind === 'palette'){
      const i = PALETTES.findIndex(p => p.id === '__preview');
      const rec = { id:'__preview', name:'Preview', bg:$('#i_cbg').value, fg:$('#i_cfg').value,
        accent:$('#i_cac').value, muted:$('#i_cfg').value, hair:$('#i_cac').value, panel:$('#i_cpn').value };
      i >= 0 ? PALETTES[i] = rec : PALETTES.push(rec);
    } else {
      const i = TYPE_SYSTEMS.findIndex(t => t.id === '__preview');
      const rec = { id:'__preview', name:'Preview', note:'', latin:$('#i_clat').value,
        bangla:$('#i_cbn').value, banglaOk:true, weightName:700 };
      i >= 0 ? TYPE_SYSTEMS[i] = rec : TYPE_SYSTEMS.push(rec);
    }
    const c = composeForced(state.layout || 'lay.centered', content, null, over);
    $('#compPreview').innerHTML = renderSVG(c) || '<div class="deadbox"><span class="tilemeta">cannot compose</span></div>';
  } catch(e){ $('#compPreview').innerHTML = '<p class="lede">Enter valid colours to preview.</p>'; }
}

/* ── LAYOUT BUILDER — real slots, editable, feeding the real composer ────── */
function drawLayoutBuild(content){
  if (flagGate('layoutbuild')) return;
  if ($('#i_lblayout').innerHTML === '')
    $('#i_lblayout').innerHTML = LAYOUTS.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  const L = LAYOUTS.find(l => l.id === (state.lbId || $('#i_lblayout').value || LAYOUTS[0].id)) || LAYOUTS[0];
  state.lbId = L.id; $('#i_lblayout').value = L.id;

  const fmt = FORMATS.find(f => f.id === state.format);
  const grid = gridFor(fmt);
  const slots = slotsFor(L, fmt.orientation);
  $('#lbGridMeta').textContent = slots
    ? `${grid.cols} × ${grid.rows} grid · ${fmt.w} × ${fmt.h} mm · safe area ${fmt.safe} mm · click a slot to inspect its rules`
    : `${L.name} has no ${fmt.orientation} composition`;

  const W = 460, H = W * fmt.h / fmt.w;
  const view = state.lbView || 'slots';
  if (!slots){ $('#lbCanvas').innerHTML = `<div class="deadbox" style="aspect-ratio:${fmt.w}/${fmt.h}">
    <span class="pill pill-warn">No ${fmt.orientation} composition</span></div>`; $('#lbSlots').innerHTML=''; return; }

  const gl = [];
  for (let i=1;i<grid.cols;i++) gl.push(`<span style="position:absolute;left:${i*100/grid.cols}%;top:0;bottom:0;width:1px;background:var(--hair)"></span>`);
  for (let j=1;j<grid.rows;j++) gl.push(`<span style="position:absolute;top:${j*100/grid.rows}%;left:0;right:0;height:1px;background:var(--hair)"></span>`);
  const safeX = fmt.safe / fmt.w * 100, safeY = fmt.safe / fmt.h * 100;
  const boxes = slots.map((s,i) => {
    const on = i === state.lbSlot;
    const x = s.box[0]*100/grid.cols, y = s.box[1]*100/grid.rows,
          w = s.box[2]*100/grid.cols, h = s.box[3]*100/grid.rows;
    return `<button data-slot="${i}" title="${esc(s.ref)}" style="position:absolute;left:${x}%;top:${y}%;
      width:${w}%;height:${h}%;border:1.5px solid ${on?'var(--color-accent)':'color-mix(in srgb,var(--color-text) 45%,transparent)'};
      background:${on?'color-mix(in srgb,var(--color-accent) 16%,transparent)':'color-mix(in srgb,var(--color-text) 5%,transparent)'};
      opacity:${view==='slots'?1:.16};cursor:pointer;display:flex;align-items:flex-start;padding:0">
      <span style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;padding:2px 4px;
        background:${on?'var(--color-accent)':'transparent'};color:${on?'var(--color-bg)':'var(--muted)'}">${esc(s.ref)}</span></button>`;
  }).join('');
  $('#lbCanvas').innerHTML = `<div style="position:relative;width:100%;max-width:${W}px;aspect-ratio:${fmt.w}/${fmt.h};
    background:var(--color-bg);border:1px solid var(--divider);box-shadow:var(--shadow-sm)">
    ${gl.join('')}
    <span style="position:absolute;left:${safeX}%;top:${safeY}%;right:${safeX}%;bottom:${safeY}%;
      border:1px dashed var(--color-accent);opacity:${view==='grid'?.3:1}"></span>
    ${boxes}</div>`;
  $$('#lbCanvas [data-slot]').forEach(b => b.onclick = () => { state.lbSlot = Number(b.dataset.slot); draw(); });
  $$('[data-lbview]').forEach(b => { b.setAttribute('aria-pressed', String((state.lbView||'slots')===b.dataset.lbview));
    b.onclick = () => { state.lbView = b.dataset.lbview; draw(); }; });

  $('#lbSlots').innerHTML = slots.map((s,i) => `
    <button class="check" style="width:100%;text-align:left;border:0;border-bottom:1px solid var(--hair);cursor:pointer;background:${
      i===state.lbSlot?'var(--color-accent-100)':'transparent'};font:inherit" data-slotrow="${i}">
      <span style="flex:1"><b>${esc(s.ref)}</b><span class="note">${esc(s.kind)} · ${
        SLOTDEFS[s.ref] ? (SLOTDEFS[s.ref].minPt ? SLOTDEFS[s.ref].minPt+' pt floor' : SLOTDEFS[s.ref].minMm+' mm min') : 'decorative'}</span></span>
      <span class="scorenum">c${s.box[0]} r${s.box[1]} · ${s.box[2]}×${s.box[3]}</span></button>`).join('');
  $$('#lbSlots [data-slotrow]').forEach(b => b.onclick = () => { state.lbSlot = Number(b.dataset.slotrow); draw(); });

  const s = slots[state.lbSlot] || slots[0];
  const def = SLOTDEFS[s.ref];
  $('#lbSlotDetail').innerHTML = `<b>${esc(s.ref)}</b>
    <dl class="kv" style="margin-top:var(--space-3)">
      <dt>Kind</dt><dd>${esc(s.kind)}</dd>
      <dt>Column</dt><dd>${s.box[0]}</dd><dt>Row</dt><dd>${s.box[1]}</dd>
      <dt>Width</dt><dd>${s.box[2]}</dd><dt>Height</dt><dd>${s.box[3]}</dd>
      <dt>Priority</dt><dd>${s.priority ?? '—'}</dd>
      <dt>Required</dt><dd>${def ? (def.required ? 'yes' : 'no') : 'decorative'}</dd>
      <dt>Minimum</dt><dd>${def ? (def.minPt ? def.minPt + ' pt' : def.minMm + ' mm') : '—'}</dd>
      <dt>Fit ladder</dt><dd>${esc((s.fit||['—']).join(' → '))}</dd>
    </dl>
    <p class="lede" style="font-size:12px;margin-top:var(--space-3)">Overlapping slots are rejected by preflight, which measures rendered glyphs rather than the declared boxes.</p>`;

  const c = composeForced(L.id, content, L.forceScript || null);
  $('#lbRendered').innerHTML = renderSVG(c) ||
    `<div class="deadbox"><span class="pill pill-warn">Eliminated</span><span class="tilemeta">${esc(c.eliminated||'')}</span></div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   THE PREVIEW WATERMARK
   --------------------------------------------------------------------------
   Master PRD §9's free tier is unlimited briefs, six concepts and a
   watermarked preview. This is the watermark, and where it is applied matters
   more than what it draws.

   It is not applied in `renderSVG`. `printDocSVG` builds the press document by
   stripping the outer <svg> off `renderSVG`'s output and re-wrapping the rest,
   so anything the renderer drew inside that body travels straight into the
   print path — a watermark baked into the one renderer is a watermark that
   eventually reaches a plate. Nor is `renderSVG` wrapped, for the same reason:
   `printDocSVG` calls it by name, and a wrapper on the global would be inside
   the print path by the same route.

   So the mark is applied to previews that are already in the document. That is
   a structural guarantee rather than a careful one — a press file is a string
   handed to `encodeURIComponent` for a download or posted to
   `/api/render-print` for bytes, and it is never an element in this page, so
   there is no path by which this code can reach one. `cwWatermarkPreviewSVG`
   then refuses anything that is not `renderSVG`'s output anyway, which is the
   second line of the same defence.

   What it draws is deliberately not destructive. §3.2's Farhana is meant to
   screenshot this and post it to Facebook, so a bar across the card would not
   protect anything — the server's gate does that — it would only make her crop
   it or not post it at all. A pill in the corner says where the card came
   from, and one faint wordmark across it survives a crop of the corner.

   `cwWatermarkPreviewSVG` is a deliberate second copy of `watermarkPreviewSVG`
   in lib/entitlements.mjs, because a classic script cannot import an ES module
   and a build step is not worth one function. §5 of tests/entitlements.test.mjs
   extracts this one and requires the two to produce identical bytes, so the
   copy fails the build the day it drifts rather than the day someone notices a
   different watermark on a shared card.
   ══════════════════════════════════════════════════════════════════════ */

/** Wrap a preview SVG with the CARDWORKS mark. Returns its input unchanged for
 *  anything that is not the preview renderer's output, and for a preview that
 *  already carries one, so calling it twice or calling it on the wrong thing
 *  is safe. Geometry comes from the viewBox, which the renderer writes in
 *  millimetres, so the mark is the same relative size on every format. */
function cwWatermarkPreviewSVG(svg, opts){
  const MARKER = 'data-cardworks-watermark';
  const TEXT = 'CARDWORKS';
  const o = opts || {};
  if (typeof svg !== 'string' || svg.length < 32) return svg;
  const head = svg.slice(0, 400);
  /* Positive identification, not an absence of red flags: `class="card"` is
     the preview renderer's own signature, and the two print producers in
     assets/engine.js both size their page in millimetres and open with a
     <desc> naming what they are. A string that is neither a preview nor a
     press file is left alone, which is what makes a print path that has never
     heard of this function safe by default. */
  if (!/^\s*<svg\b/.test(head)) return svg;
  if (!/\bclass="card"/.test(head)) return svg;
  if (/\b(width|height)="[\d.]+mm"/.test(head)) return svg;
  if (/<desc>[^<]*(print document|separation)/i.test(svg.slice(0, 800))) return svg;
  if (svg.indexOf(MARKER) >= 0) return svg;

  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) return svg;
  const w = Number(vb[1]), h = Number(vb[2]);
  if (!(w > 0) || !(h > 0)) return svg;
  const close = svg.lastIndexOf('</svg>');
  if (close < 0) return svg;

  const text = String(o.text || TEXT);
  const family = String(o.fontFamily || 'ui-sans-serif, system-ui, sans-serif');

  const padY = h * 0.055;
  const pillH = h * 0.105;
  const pillFont = pillH * 0.52;
  const pillW = pillFont * (text.length * 0.66 + 3.4);
  const pillX = w - padY - pillW;
  const pillY = h - padY - pillH;

  const diagFont = h * 0.30;
  const angle = -(Math.atan2(h, w) * 180 / Math.PI).toFixed(2);

  const mark =
    `<g ${MARKER}="1" aria-label="CARDWORKS preview" pointer-events="none">` +
      `<text x="${(w / 2).toFixed(3)}" y="${(h / 2 + diagFont * 0.34).toFixed(3)}"` +
      ` transform="rotate(${angle} ${(w / 2).toFixed(3)} ${(h / 2).toFixed(3)})"` +
      ` font-family="${family}" font-weight="800" font-size="${diagFont.toFixed(3)}"` +
      ` letter-spacing="${(diagFont * 0.06).toFixed(3)}"` +
      ` fill="#808080" fill-opacity="0.16" text-anchor="middle">${text}</text>` +
      `<rect x="${pillX.toFixed(3)}" y="${pillY.toFixed(3)}"` +
      ` width="${pillW.toFixed(3)}" height="${pillH.toFixed(3)}"` +
      ` rx="${(pillH / 2).toFixed(3)}" ry="${(pillH / 2).toFixed(3)}"` +
      ` fill="#ffffff" fill-opacity="0.88" stroke="#808080" stroke-opacity="0.55"` +
      ` stroke-width="${(h * 0.004).toFixed(3)}"/>` +
      `<text x="${(pillX + pillW / 2).toFixed(3)}" y="${(pillY + pillH * 0.68).toFixed(3)}"` +
      ` font-family="${family}" font-weight="700" font-size="${pillFont.toFixed(3)}"` +
      ` letter-spacing="${(pillFont * 0.10).toFixed(3)}"` +
      ` fill="#1a1a1a" text-anchor="middle">${text}</text>` +
    `</g>`;

  return svg.slice(0, close) + mark + svg.slice(close);
}

/** Whether the previews on screen should carry the mark. The free tier is the
 *  default and also the answer whenever the server has not been asked yet:
 *  showing a clean preview to someone who has not bought the file, on the
 *  strength of not having checked, is the one direction this must not fail in.
 *
 *  `entitlementView` lives in ui-order.js, which loads first; the guard is for
 *  a build assembled without it, where free tier is again the right answer. */
function cwPreviewWatermarkWanted(){
  if (typeof entitlementView !== 'function') return true;
  const ent = entitlementView();
  return !(ent && ent.may && ent.may.export);
}

/** Mark every preview in the document. Idempotent by the marker attribute, so
 *  a redraw that left some nodes in place does not stack two marks on them.
 *
 *  Everything is guarded and nothing is allowed to throw: this runs after every
 *  draw, and a decoration that took the whole screen down with it would be a
 *  far worse failure than a missing watermark — the same rule `FULFIL` in
 *  ui-order.js follows for a container that has gone missing. */
function cwMarkPreviews(root){
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.querySelectorAll !== 'function') return 0;
  if (!cwPreviewWatermarkWanted()) return 0;
  let marked = 0;
  try {
    const nodes = Array.prototype.slice.call(doc.querySelectorAll('svg.card'));
    for (const node of nodes){
      const svg = node && node.outerHTML;
      if (typeof svg !== 'string') continue;
      const wrapped = cwWatermarkPreviewSVG(svg);
      if (wrapped === svg) continue;
      node.outerHTML = wrapped;
      marked++;
    }
  } catch (e){ /* a preview without its mark beats a screen that did not render */ }
  return marked;
}

/* The one hook. `draw()` is the single place every screen is rendered from,
   so marking after it covers the concepts grid, the detail view, the customise
   screen and the dashboard tiles without any of those files having to know
   this exists — which matters, because they belong to other subgroups and a
   watermark that only appears on the screens one subgroup remembered is not a
   watermark. */
const _cwDrawBeforeWatermark = draw;
draw = function(){
  const result = _cwDrawBeforeWatermark.apply(this, arguments);
  cwMarkPreviews();
  return result;
};

