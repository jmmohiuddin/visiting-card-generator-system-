/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — export, order, tracking and dashboard
   --------------------------------------------------------------------------
   Everything downstream of a passing preflight: files, money and fulfilment.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

function drawExport(design, content){
  const { front, back } = facesFor(design, content);
  const pf = allFindings(front, back);
  const blocking = pf.filter(f => f.s === 'fail').length;
  $('#exportMeta').textContent = blocking
    ? `${blocking} blocking finding — export refused` : 'Preflight clean';

  if (front && !front.eliminated && !blocking){
    const files = [['card_front_print.svg', printDocSVG(front)],
                   ['card_back_print.svg',  printDocSVG(back)]];
    if (state.finishes.includes('foil')){
      const s = separationSVG(front,'Gold foil'); if (s) files.push([`foil_gold.svg — ${s.areaPct}% plate`, s.svg]);
    }
    if (state.finishes.includes('spotuv')){
      const s = separationSVG(front,'Spot UV'); if (s) files.push([`spot_uv.svg — ${s.areaPct}% plate`, s.svg]);
    }
    $('#exports').innerHTML = files.filter(f => f[1]).map(([n,x]) =>
      `<a class="chip" download="${n.split(' ')[0]}"
        href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(x)}">${ICON.down} ${esc(n)}</a>`).join('');
  } else {
    $('#exports').innerHTML = `<span class="pill pill-warn">${ICON.review} Export blocked — ${
      blocking} blocking finding${blocking===1?'':'s'}</span>`;
  }

  const q = quote(Number(state.qty), state.finishes, state.zone);
  $('#quote').innerHTML = q.lines.map(l =>
    `<div class="check"><span style="flex:1">${esc(l.label)}</span>
     <span class="scorenum">${taka(l.cost)}</span></div>`).join('')
    + `<div class="check" style="border-bottom:0"><span style="flex:1"><b>Customer price</b>
        <span class="note">${taka(q.unit)} per card · ${q.marginPct}% gross</span></span>
       <span class="scorenum" style="font-size:14px"><b>${taka(q.retail)}</b></span></div>
       <p class="lede" style="font-size:12px;color:var(--warn)">${esc(q.note)}</p>`;

  if (front && !front.eliminated){
    const h = specHash({ format:design.format, layoutFront:design.layout, layoutBack:design.back,
      typeSystem:design.type, palette:design.palette, density:design.density,
      script:design.script, content });
    $('#identity').innerHTML = [['specHash', h], ['Versions', String(state.history.length+1)],
      ['Renders', `cacheable at renders/${h.slice(0,8)}/…`]]
      .map(([k,v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  }
}

/* ── Library ───────────────────────────────────────────────────────────── */
function pressesFor(finishes){
  return PRESSES.map(p => ({ ...p, ok: finishes.every(f => p.can.includes(f)) }));
}
function drawOrder(design, content){
  const list = pressesFor(state.finishes);
  if (!list.some(p => p.ok && p.name === state.press)) state.press = (list.find(p => p.ok) || list[0]).name;
  $('#presses').innerHTML = list.map(p => `
    <button class="check" style="width:100%;text-align:left;background:${
      p.name===state.press?'var(--color-accent-100)':'transparent'};border:0;border-bottom:1px solid var(--hair);cursor:${p.ok?'pointer':'not-allowed'};font:inherit"
      data-press="${esc(p.name)}" ${p.ok?'':'disabled'}>
      <span class="ico ${p.ok?'i-pass':'i-fail'}">${p.ok?ICON.pass:ICON.fail}</span>
      <span style="flex:1"><b>${esc(p.name)}</b>
        <span class="note">${p.ok ? 'Can produce ' + state.finishes.map(f=>FINISH_COST[f].label).join(', ') || 'plain stock'
          : 'Cannot produce ' + state.finishes.filter(f=>!p.can.includes(f)).map(f=>FINISH_COST[f].label).join(', ')}
          · lead time ${p.lead}</span></span>
      <span class="scorenum">${p.ok ? taka(Math.round(quote(Number(state.qty), state.finishes, state.zone).retail * p.mult)) : '—'}</span>
    </button>`).join('');
  $$('#presses [data-press]').forEach(b => b.onclick = () => { state.press = b.dataset.press; draw(); });

  const p = list.find(x => x.name === state.press) || list[0];
  const q = quote(Number(state.qty), state.finishes, state.zone);
  const total = Math.round(q.retail * p.mult);
  state.orderTotal = total; state.orderSub = q.pressCost;
  $('#orderSummary').innerHTML = `<dl class="kv">
    <dt>Design</dt><dd>${esc((LAYOUTS.find(l=>l.id===design.layout)||{}).name || '—')}</dd>
    <dt>Quantity</dt><dd>${state.qty} cards</dd>
    <dt>Stock</dt><dd>300 gsm art card</dd>
    <dt>Finish</dt><dd>${esc(state.finishes.map(f=>FINISH_COST[f].label).join(', ') || 'none')}</dd>
    <dt>Press</dt><dd>${esc(p.name)}</dd>
    <dt>Lead time</dt><dd>${p.lead} after approval</dd>
    <dt>Total</dt><dd><b>${taka(total)}</b></dd></dl>`;

  $('#orderSteps').innerHTML = [
    ['01','Files locked','Preflight passed with no blocking finding'],
    ['02','Printed proof','One card, same stock and finish'],
    ['03','You approve','Charged at this point, not before'],
    ['04','Run and delivery', p.lead + ' after approval']
  ].map(([n,t,d]) => `<div class="check"><span class="railnum">${n}</span>
    <span style="flex:1">${t}<span class="note">${d}</span></span></div>`).join('');
  $('#b_placeorder').disabled = !state.shareCode;
  if (!state.shareCode)
    $('#orderOut').innerHTML = checkRow({ s:'review', label:'Save the design first',
      note:'An order points at a saved design, so the press and the customer are looking at the same file.' });
}

/* ── TRACKING ────────────────────────────────────────────────────────────── */
async function loadOrder(ref){
  try {
    const r = await fetch('/api/orders?ref=' + encodeURIComponent(ref));
    if (!r.ok) throw new Error('not found');
    state.order = await r.json(); draw();
  } catch(e){ state.order = null; $('#trackTimeline').innerHTML = checkRow({ s:'fail', label:'Could not load that order' }); }
}
function drawTracking(){
  const o = state.order;
  if (!o){ $('#trackTimeline').innerHTML = '<p class="lede">Loading…</p>'; return; }
  const cur = o.order.status;
  const idx = o.flow.findIndex(f => f[0] === cur);
  $('#trackRef').textContent = o.order.ref;
  $('#trackStatus').textContent = { files_locked:'Files locked', at_press:'At press',
    proof_printed:'Proof printed', proof_delivered:'Proof delivered',
    awaiting_approval:'Proof with you', printing:'Printing', delivered:'Delivered',
    cancelled:'Cancelled' }[cur] || cur;
  $('#trackTimeline').innerHTML = o.flow.map(([k,t,n],i) => {
    const done = i < idx, now = i === idx;
    return `<div class="check" style="${i>idx?'opacity:.45':''}">
      <span class="ico ${done||now?'i-pass':''} ${now?'ticking':''}">${done?ICON.pass:ICON.dot}</span>
      <span style="flex:1">${t}<span class="note">${esc(n)}</span></span>
      <span class="scorenum">${done?'done':now?'now':''}</span></div>`;
  }).join('');
  $('#trackKv').innerHTML = [
    ['Reference', o.order.ref], ['Design', '/c/' + o.order.short_code],
    ['Quantity', o.order.qty + ' cards'], ['Press', o.order.press],
    ['Total', taka(o.order.total)], ['Placed', String(o.order.created_at).slice(0,10)]
  ].map(([k,v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  const closed = cur === 'printing' || cur === 'delivered' || cur === 'cancelled';
  $('#b_approve').disabled = closed; $('#b_reproof').disabled = closed;
}

/* ── DASHBOARD ───────────────────────────────────────────────────────────── */
async function loadDash(){
  try {
    const r = await fetch('/api/orders?list=1&owner=' + encodeURIComponent(ownerKey() || ''));
    state.dash = r.ok ? await r.json() : { designs:[], orders:[] };
  } catch(e){ state.dash = { designs:[], orders:[] }; }
  draw();
}
function drawDashboard(content){
  const d = state.dash;
  if (!d){ $('#savedTiles').innerHTML = '<div class="empty">Loading…</div>'; return; }
  $('#dashMeta').textContent = `${d.designs.length} saved · ${d.orders.length} orders`;
  $('#savedTiles').innerHTML = d.designs.length ? d.designs.map(x => {
    const L = LAYOUTS.find(l => l.id === x.layout);
    const c = L ? composeForced(x.layout, content, null, { palette:x.palette }) : null;
    return `<button class="tile" role="button" tabindex="0" aria-pressed="false" data-code="${esc(x.short_code)}">
      ${(c && renderSVG(c)) || '<div class="deadbox"><span class="tilemeta">preview unavailable</span></div>'}
      <span class="tiletitle">${esc(x.name || x.label || 'Untitled')}</span>
      <span class="tilemeta">/c/${esc(x.short_code)} · ${String(x.created_at).slice(0,10)}</span></button>`;
  }).join('') : `<div class="empty">Nothing saved from this browser yet. Design a card and press
      <b>Save and get a link</b> on the export screen.</div>`;
  bindTiles('#savedTiles .tile', t => { location.href = '/?c=' + t.dataset.code; });

  $('#ordersList').innerHTML = d.orders.length ? d.orders.map(o =>
    `<button class="check" style="width:100%;text-align:left;border:0;border-bottom:1px solid var(--hair);background:transparent;cursor:pointer;font:inherit"
      data-ref="${esc(o.ref)}">
      <span style="flex:1"><b>${esc(o.ref)}</b><span class="note">${o.qty} cards · ${esc(o.press)}</span></span>
      <span class="scorenum">${taka(o.total)}</span>
      <span class="pill ${o.status==='delivered'?'pill-ok':'pill-accent'}">${esc(String(o.status).replace(/_/g,' '))}</span>
    </button>`).join('') : '<p class="lede">No print orders yet.</p>';
  $$('#ordersList [data-ref]').forEach(b => b.onclick = () => {
    state.trackRef = b.dataset.ref; state.order = null; go('tracking'); loadOrder(b.dataset.ref);
  });
}

/* ── PROFILES ────────────────────────────────────────────────────────────── */
