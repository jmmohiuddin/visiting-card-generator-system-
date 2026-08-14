/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — wiring
   --------------------------------------------------------------------------
   Binds the DOM, restores session state, and starts the first draw.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════ WIRING ══════════════════════════ */
function init(){
  $('#i_industry').innerHTML = Object.entries(INDUSTRIES).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#i_format').innerHTML   = FORMATS.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
  $('#i_back').innerHTML     = LAYOUTS.filter(l => l.face === 'back').map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  $('#i_personality').innerHTML = AXES.map(a =>
    `<button class="chip" data-ax="${a}" aria-pressed="${state.personality.includes(a)}">${AXIS_WORD[a]}</button>`).join('');
  $('#i_finishes').innerHTML = Object.entries(FINISH_COST).map(([k,v]) =>
    `<button class="chip" data-fin="${k}" aria-pressed="${state.finishes.includes(k)}">${v.label}</button>`).join('');
  $('#presets').innerHTML = PRESETS.map((p,i) =>
    `<button class="chip chip-sm" data-p="${i}" aria-pressed="${i===0}" title="${esc(p.why)}">${esc(p.k)}</button>`).join('');
  $('#i_industry').value = state.industry; $('#i_back').value = state.back;
  $('#logoReport').innerHTML = '<p class="lede">No logo yet. A monogram will be generated from the company name, which is what most cards here use anyway.</p>';
  writeForm(PRESETS[0].c);

  $('#presets').onclick = e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const i = Number(b.dataset.p);
    $$('#presets .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    state.industry = ['doctor','rmg','shop','advocate','tutor','rmg'][i];
    $('#i_industry').value = state.industry;
    writeForm(PRESETS[i].c); draw();
  };
  $('#i_personality').onclick = e => {
    const b = e.target.closest('[data-ax]'); if (!b) return;
    const a = b.dataset.ax, i = state.personality.indexOf(a);
    if (i >= 0) state.personality.splice(i,1);
    else { if (state.personality.length >= 3) state.personality.shift(); state.personality.push(a); }
    $$('#i_personality .chip').forEach(x => x.setAttribute('aria-pressed', String(state.personality.includes(x.dataset.ax))));
    draw();
  };
  $('#i_finishes').onclick = e => {
    const b = e.target.closest('[data-fin]'); if (!b) return;
    const f = b.dataset.fin, i = state.finishes.indexOf(f);
    i >= 0 ? state.finishes.splice(i,1) : state.finishes.push(f);
    $$('#i_finishes .chip').forEach(x => x.setAttribute('aria-pressed', String(state.finishes.includes(x.dataset.fin))));
    draw();
  };

  $('#b_next').onclick = () => { if (state.step === 6) runGenerate(); else { state.step++; draw(); } };
  $('#b_prev').onclick = () => { state.step = Math.max(0, state.step-1); draw(); };
  $('#b_regen').onclick = () => runGenerate();
  $('#b_tolibrary').onclick = () => go('library');
  $('#b_toconcepts').onclick = () => go('concepts');
  $('#b_validate').onclick = () => go('validate');
  $('#b_toexport').onclick = () => go('export');
  $('#b_backdetail').onclick = () => go('detail');
  $('#b_backdetail2').onclick = () => go('detail');

  const MAP = { i_format:'format', i_density:'density', i_back:'back', i_script:'script',
                i_industry:'industry', i_qty:'qty', i_zone:'zone' };
  Object.keys(MAP).forEach(id => { $('#'+id).oninput = e => { state[MAP[id]] = e.target.value; draw(); }; });
  ['i_name','i_role','i_company','i_quals','i_bname','i_brole','i_bcompany',
   'i_p1','i_p2','i_email','i_web','i_addr'].forEach(id => { $('#'+id).oninput = draw; });

  /* Refinement */
  const applyInstr = () => {
    const cls = classifyInstruction($('#i_instr').value);
    if (cls.empty) return;
    if (cls.unmapped){ state.instrLog.push({ ...cls, changes:[] }); draw(); return; }
    const { design:nd, changes } = applyOps(lastDesign, cls.ops);
    state.history.push({ ...lastDesign });
    state.refine = nd; state.instrLog.push({ ...cls, changes });
    draw();
  };
  $('#b_apply').onclick = applyInstr;
  $('#i_instr').onkeydown = e => { if (e.key === 'Enter') applyInstr(); };
  $('#b_undo').onclick = () => { if (!state.history.length) return; state.refine = state.history.pop(); state.instrLog.pop(); draw(); };
  $('#b_reset').onclick = () => { state.refine = null; state.history = []; state.instrLog = []; $('#i_instr').value = ''; draw(); };

  /* Logo — graded at upload */
  $('#i_logo').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    if (!f){ state.logo = null; draw(); return; }
    $('#logoReport').innerHTML = '<p class="lede">Reading…</p>';
    try {
      const a = await inspectLogo(f);
      const placedMm = 1.4 * (FORMATS.find(x => x.id === state.format).w / GRID.cols);
      const g = gradeLogo(a, placedMm);
      state.logo = g.ok ? { ...a, ok:true } : null;
      $('#logoReport').innerHTML = g.findings.map(checkRow).join('')
        + (g.ok ? '<p class="lede" style="font-size:12.5px">Accepted. It will be placed in the mark slot.</p>'
                : `<p class="lede" style="font-size:12.5px;color:var(--color-accent)">Rejected. ${esc(g.options.join(' · '))}</p>`);
    } catch (err){
      state.logo = null;
      $('#logoReport').innerHTML = checkRow({ s:'fail', label:err.message });
    }
    draw();
  };

  /* Bulk */
  const SAMPLE = ['name,role,company,phone,email',
    'Sharmin Akter,Senior Merchandiser,Zenith Sourcing Ltd.,01755-889900,sharmin@zenithsourcing.com',
    'Md. Rakibul Hasan,Merchandiser,Zenith Sourcing Ltd.,01711-224466,rakib@zenithsourcing.com',
    'Farhana Islam,Quality Controller,Zenith Sourcing Ltd.,01911-335577,farhana@zenithsourcing.com',
    'Mohammad Shafiqur Rahman Chowdhury Bhuiyan,Deputy General Manager Corporate Affairs,Zenith Sourcing Ltd.,01611-778899,shafiqur@zenithsourcing.com',
    'Tanvir Ahmed,Sample Coordinator,Zenith Sourcing Ltd.,01511-990011,tanvir@zenithsourcing.com'].join('\n');
  $('#b_bulk_sample').onclick = () => { $('#i_csv').value = SAMPLE; };
  $('#b_bulk').onclick = () => {
    const { rows } = parseCSV($('#i_csv').value);
    if (!rows.length){ $('#bulkOut').innerHTML = checkRow({ s:'fail', label:'No data rows found in that CSV' }); return; }
    state.bulk = bulkGenerate(lastDesign, rows, readForm(), (d, c) =>
      composeForced(d.layout, c, d.script === 'bangla' ? 'bangla' : null,
        { palette:d.palette, type:d.type, density:d.density, format:d.format }));
    draw();
  };

  /* Save and share */
  $('#b_save').onclick = async () => {
    const btn = $('#b_save'); btn.disabled = true;
    $('#saveOut').innerHTML = '<p class="lede">Saving…</p>';
    try {
      const snap = snapshot(); delete snap.pick; delete snap.screen;
      const res = await fetch('/api/designs', { method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ spec:snap, label:(readForm().name||'').slice(0,80) }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
      state.shareCode = j.code;
      $('#saveOut').innerHTML = checkRow({ s:'pass', label:'Saved',
        note:`${j.url} — the QR now resolves to this card.` });
      draw();
    } catch (err){
      $('#saveOut').innerHTML = checkRow({ s:'fail', label:'Could not save',
        note:`${err.message}. The engine works offline; only sharing needs the server.` });
    } finally { btn.disabled = false; }
  };


  /* ── the screens added to complete the designed system ── */
  $('#b_tocustomise').onclick   = () => go('customise');
  $('#b_custvalidate').onclick  = () => go('validate');
  $('#b_startgo').onclick = () => {
    const r = readSentence($('#i_sentence').value);
    if (r.industry){ state.industry = r.industry; $('#i_industry').value = r.industry; }
    if (r.personality.length) state.personality = r.personality.slice(0,3);
    if (r.script === 'bangla'){ state.script = 'bangla'; $('#i_script').value = 'bangla'; }
    $$('#i_personality .chip').forEach(x => x.setAttribute('aria-pressed', String(state.personality.includes(x.dataset.ax))));
    state.step = 0; go('brief');
  };
  $('#b_startlib').onclick = () => go('library');
  $('#i_sentence').oninput = draw;

  $('#b_toorder').onclick     = () => go('order');
  $('#b_backexport').onclick  = () => go('export');
  $('#b_backdetail3').onclick = () => go('detail');
  $('#b_backdash').onclick    = () => { state.dash = null; go('dashboard'); loadDash(); };
  $('#b_toprofiles').onclick  = () => go('profiles');
  $('#b_tosettings').onclick  = () => go('settings');
  $('#b_newcard').onclick     = () => { state.step = 0; go('brief'); };
  $('#b_tolayoutbuild').onclick = () => go('layoutbuild');
  $('#b_tocompedit').onclick  = () => go('compedit');
  $('#b_backstudio').onclick  = () => go('studio');
  $('#b_backstudio2').onclick = () => go('studio');
  $('#i_lblayout').oninput = e => { state.lbId = e.target.value; state.lbSlot = 0; draw(); };
  $('#i_ckind').oninput = draw;

  $('#b_placeorder').onclick = async () => {
    const btn = $('#b_placeorder'); btn.disabled = true;
    $('#orderOut').innerHTML = '<p class="lede">Placing…</p>';
    try {
      const r = await fetch('/api/orders', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ shortCode:state.shareCode, qty:Number(state.qty), press:state.press,
          finishes:state.finishes, zone:state.zone, total:state.orderTotal, subtotal:state.orderSub,
          owner:ownerKey(), recipient:{ name:$('#i_recname').value, phone:$('#i_recphone').value,
            address:$('#i_recaddr').value } }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      state.trackRef = j.ref; state.order = null; go('tracking'); loadOrder(j.ref);
    } catch (err){
      $('#orderOut').innerHTML = checkRow({ s:'fail', label:'Could not place the order', note:err.message });
    } finally { btn.disabled = false; }
  };
  const orderAction = async (action) => {
    if (!state.trackRef) return;
    $('#trackOut').innerHTML = '<p class="lede">Sending…</p>';
    try {
      const r = await fetch('/api/orders', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ ref:state.trackRef, action, note:$('#i_proofnote').value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      $('#trackOut').innerHTML = checkRow({ s:'pass',
        label: action === 'approve' ? 'Approved — the run starts now' : 'A second proof has been requested' });
      loadOrder(state.trackRef);
    } catch (err){ $('#trackOut').innerHTML = checkRow({ s:'fail', label:err.message }); }
  };
  $('#b_approve').onclick = () => orderAction('approve');
  $('#b_reproof').onclick = () => orderAction('reproof');

  $('#b_newprofile').onclick = () => {
    const c = readForm(); delete c.logo;
    const pal = PALETTES.find(x => x.id === (lastDesign||{}).palette);
    const profs = lsGet('cardworks.profiles', []);
    profs.unshift({ ...c, palette:(lastDesign||{}).palette,
      pal: pal ? [pal.bg, pal.accent, pal.fg] : [], cards:1 });
    lsSet('cardworks.profiles', profs.slice(0,12)); state.profileIdx = 0; go('profiles');
  };

  $('#b_signin').onclick = () => {
    const acct = { name:$('#i_acctname').value.trim(), email:$('#i_acctemail').value.trim() };
    if (!acct.name){ $('#signinOut').innerHTML = checkRow({ s:'fail', label:'A name is needed to label your work' }); return; }
    lsSet('cardworks.account', acct); draw();
  };

  ['i_setunits','i_setcount','i_setbudget'].forEach(id => { $('#'+id).oninput = () => {
    const st = lsGet('cardworks.settings', { units:'mm', count:6, budget:'standard', notifs:[0,1] });
    st.units = $('#i_setunits').value; st.count = Number($('#i_setcount').value);
    st.budget = $('#i_setbudget').value; lsSet('cardworks.settings', st); draw();
  };});
  $('#i_setmarket').oninput = e => { state.format = e.target.value; $('#i_format').value = e.target.value; draw(); };
  $('#b_exportdata').onclick = () => {
    const blob = { account:lsGet('cardworks.account',{}), profiles:lsGet('cardworks.profiles',[]),
      settings:lsGet('cardworks.settings',{}), session:lsGet('cardworks.session',{}) };
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(blob, null, 2));
    a.download = 'cardworks-data.json'; a.click();
  };
  $('#b_cleardata').onclick = () => {
    ['cardworks.account','cardworks.profiles','cardworks.settings','cardworks.session','cardworks.owner']
      .forEach(k => { try { localStorage.removeItem(k); } catch(e){} });
    state.profileIdx = 0; draw();
  };

  $('#b_addcomp').onclick = () => {
    const name = ($('#i_cname').value || '').trim();
    if (!name){ $('#compOut').innerHTML = checkRow({ s:'fail', label:'A name is required' }); return; }
    const id = (state.compKind === 'palette' ? 'pal.' : 'typ.') + name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
    if (state.compKind === 'palette'){
      const rec = { id, name, bg:$('#i_cbg').value, fg:$('#i_cfg').value, accent:$('#i_cac').value,
        muted:$('#i_cfg').value, hair:$('#i_cac').value, panel:$('#i_cpn').value };
      PALETTES.push(rec);
      PALETTE_AXES[id] = Object.fromEntries((state.compTags||[]).map(a => [a, 0.85]));
    } else {
      TYPE_SYSTEMS.push({ id, name, note:'Added in the studio', latin:$('#i_clat').value,
        bangla:$('#i_cbn').value, banglaOk:true, weightName:700 });
      TYPE_AXES[id] = Object.fromEntries((state.compTags||[]).map(a => [a, 0.85]));
    }
    $('#compOut').innerHTML = checkRow({ s:'pass', label:`${name} published to the live library`,
      note:`${id} — it will be considered by the next generation.` });
    state.libCat = state.compKind === 'palette' ? 'Colour systems' : 'Typography systems';
  };

  /* Persistence — URL hash for sharing, localStorage to survive a refresh. */
  const SAVE_KEYS = ['screen','step','format','type','palette','density','back','script',
                     'industry','personality','finishes','qty','zone','layout','pick','refine'];
  var snapshot = () => {
    const o = {}; for (const k of SAVE_KEYS) o[k] = state[k];
    o.content = readForm(); delete o.content.logo;
    return o;
  };
  const restore = o => {
    if (!o || typeof o !== 'object') return false;
    for (const k of SAVE_KEYS) if (k in o) state[k] = o[k];
    if (o.content) writeForm(o.content);
    for (const [id,k] of Object.entries({ i_format:'format', i_density:'density', i_back:'back',
        i_script:'script', i_industry:'industry', i_qty:'qty', i_zone:'zone' })){
      const el = $('#'+id); if (el) el.value = state[k];
    }
    $$('#i_personality .chip').forEach(x => x.setAttribute('aria-pressed', String(state.personality.includes(x.dataset.ax))));
    $$('#i_finishes .chip').forEach(x => x.setAttribute('aria-pressed', String(state.finishes.includes(x.dataset.fin))));
    if (state.screen !== 'brief' && !state.gen) state.screen = 'brief';
    return true;
  };
  const persist = () => {
    try {
      const json = JSON.stringify(snapshot());
      localStorage.setItem('cardworks.session', json);
      history.replaceState(null, '', '#d=' + encodeURIComponent(btoa(unescape(encodeURIComponent(json)))));
    } catch(e){ /* private mode or quota — never block the UI */ }
  };
  const _draw = draw;
  draw = function(){ _draw(); persist(); };

  const cparam = new URLSearchParams(location.search || '').get('c');
  if (cparam && /^[0-9a-f]{6,16}$/.test(cparam)){
    fetch('/api/designs?code=' + encodeURIComponent(cparam))
      .then(r => r.ok ? r.json() : Promise.reject(new Error('not found')))
      .then(j => { state.shareCode = j.code; if (restore(j.spec)) draw(); })
      .catch(() => {});
  }
  let loaded = false;
  const hash = /^#d=(.+)$/.exec(location.hash || '');
  if (hash){ try { loaded = restore(JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(hash[1])))))); } catch(e){} }
  if (!loaded){ try { loaded = restore(JSON.parse(localStorage.getItem('cardworks.session'))); } catch(e){} }

  (document.fonts?.ready || Promise.resolve()).then(() => { _mcache.clear(); draw(); });
  draw();
}
init();

