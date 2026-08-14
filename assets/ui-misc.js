/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — secondary surfaces
   --------------------------------------------------------------------------
   Library, bulk, mockups, pricing, sign-in, settings and the component studio.
   Master PRD §5.2 cuts several of these from MVP; they live behind flags.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

function drawLibrary(content){
  const fs = (state.script === 'bangla' || state.script === 'bangla-only') ? 'bangla' : null;
  const fronts = LAYOUTS.filter(l => l.face === 'front');
  let live = 0;
  $('#libTiles').innerHTML = fronts.map(L => {
    const c = composeForced(L.id, content, fs);
    const s = renderSVG(c); if (s) live++;
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
  bindTiles('#libTiles .tile', t => {
    if (!t.dataset.lay) return;
    state.layout = t.dataset.lay; state.refine = null; go('detail');
  });
}

/* ── Bulk ──────────────────────────────────────────────────────────────── */
function drawBulk(design, content){
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
  const profs = lsGet('cardworks.profiles', []);
  $('#profileList').innerHTML = profs.length ? profs.map((p,i) =>
    `<button class="check" style="width:100%;text-align:left;border:0;border-bottom:1px solid var(--hair);cursor:pointer;background:${
      i===state.profileIdx?'var(--color-accent-100)':'transparent'};font:inherit" data-prof="${i}">
      <span style="flex:1"><b>${esc(p.name)}</b><span class="note">${esc(p.role||'')} ${p.company?'· '+esc(p.company):''}</span></span>
      <span style="display:flex;gap:3px">${(p.pal||[]).map(c =>
        `<span style="width:15px;height:15px;background:${esc(c)};border:1px solid var(--hair);display:block"></span>`).join('')}</span>
    </button>`).join('') : '<p class="lede">No profiles yet. Fill in a brief and save it as one.</p>';
  $$('#profileList [data-prof]').forEach(b => b.onclick = () => { state.profileIdx = Number(b.dataset.prof); draw(); });

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

/* ── PRICING ─────────────────────────────────────────────────────────────── */
function drawPricing(){
  $('#plans').innerHTML = PLANS.map((p,i) => `<div class="tile" style="cursor:default">
    <span class="tiletitle" style="color:${i===2?'var(--color-accent)':'inherit'}">${esc(p.name)}</span>
    <h3 style="margin:0">${esc(p.price)}</h3>
    <span class="tilemeta">${esc(p.per)}</span>
    <span class="tilemeta" style="flex:1">${esc(p.who)}</span>
    <span class="btn ${i===2?'btn-primary':''}" style="pointer-events:none;align-self:flex-start">Choose</span></div>`).join('');
  $('#planRows').innerHTML = PLAN_ROWS.map(r =>
    `<div class="check"><span style="flex:1">${esc(r[0])}</span>${
      r.slice(1).map(v => `<span class="scorenum" style="width:88px;text-align:center">${esc(v)}</span>`).join('')}</div>`).join('');
}

/* ── SIGN IN — an honest local profile ───────────────────────────────────── */
function drawSignin(){
  const acct = lsGet('cardworks.account', {});
  if ($('#i_acctname') && !$('#i_acctname').value) $('#i_acctname').value = acct.name || '';
  if ($('#i_acctemail') && !$('#i_acctemail').value) $('#i_acctemail').value = acct.email || '';
  const n = LAYOUTS.filter(l=>l.face==='front').length * PALETTES.length * TYPE_SYSTEMS.length;
  $('#signinStat').textContent =
    `${n.toLocaleString('en-IN')} compositions from ${LAYOUTS.length} layouts, ${PALETTES.length} palettes and ${TYPE_SYSTEMS.length} type systems — composed against your brief, not guessed at by an image model.`;
  $('#signinOut').innerHTML = acct.name
    ? checkRow({ s:'pass', label:`Signed in locally as ${acct.name}`, note:'Your saved designs and orders on this browser are labelled with it.' })
    : '';
}

/* ── SETTINGS ────────────────────────────────────────────────────────────── */
function drawSettings(){
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

