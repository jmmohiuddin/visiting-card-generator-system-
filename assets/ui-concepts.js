/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — concepts, detail and typed refinement
   --------------------------------------------------------------------------
   The six results, one concept in detail, and the typed-instruction surface.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

function drawConcepts(){
  const g = state.gen;
  if (!g || !g.picked.length){
    $('#conceptTiles').innerHTML = `<div class="empty">Nothing survived the constraints.
      Loosen a finish, shorten a field, or choose a larger card.</div>`;
    return;
  }
  $('#conceptsMeta').textContent =
    `${g.stages.enumerated} candidates · ${g.stages.composed} composed · ${g.stages.selected} selected · ${g.ms < 1 ? 'under 1' : g.ms} ms`;
  $('#conceptTiles').innerHTML = g.picked.map((c,i) => {
    const L = LAYOUTS.find(l => l.id === c.layout);
    return `<button class="tile ${state.seen ? '' : 'resolve'}" role="button" tabindex="0"
      aria-pressed="${i===state.pick}" data-pick="${i}" style="animation-delay:${i*55}ms">
      ${renderSVG(c.composed)}
      <span class="tiletitle">${String(i+1).padStart(2,'0')} · ${esc(L.name)}</span>
      <span class="tilemeta">${esc(PALETTES.find(p=>p.id===c.palette).name)} · ${
        esc(TYPE_SYSTEMS.find(t=>t.id===c.type).name.split(' + ')[0])}</span>
      <span class="score"><span class="bar"><span style="width:${(c.score.total*100).toFixed(0)}%"></span></span>
      <span class="scorenum">${(c.score.total*100).toFixed(0)}</span></span>
    </button>`;
  }).join('');
  state.seen = 1;
  bindTiles('#conceptTiles .tile', t => { state.pick = Number(t.dataset.pick); go('detail'); });

  /* Compare puts the six side by side with what actually separates them:
     the score dimensions, and what the fit ladder had to do to each. */
  const grid = state.view === 'grid';
  $('#conceptTiles').style.display = grid ? 'grid' : 'none';
  $('#compareView').style.display  = grid ? 'none' : 'block';
  $$('[data-view]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    b.onclick = () => { state.view = b.dataset.view; draw(); };
  });
  if (!grid){
    $('#compareView').innerHTML = '<div class="cmp">' + g.picked.map((c,i) => {
      const L = LAYOUTS.find(l => l.id === c.layout);
      const adj = c.composed.trace.length;
      return `<div>
        ${renderSVG(c.composed)}
        <h5 style="margin-top:var(--space-4)">${String(i+1).padStart(2,'0')} · ${esc(L.name)}</h5>
        <dl class="kv" style="margin-top:var(--space-3)">
          <dt>Score</dt><dd>${(c.score.total*100).toFixed(1)}</dd>
          ${Object.keys(W).map(k => `<dt>${k.replace(/([A-Z])/g,' $1').toLowerCase()}</dt>
            <dd>${(c.score.parts[k]*100).toFixed(0)}</dd>`).join('')}
          <dt>Palette</dt><dd>${esc(PALETTES.find(p=>p.id===c.palette).name)}</dd>
          <dt>Type</dt><dd>${esc(TYPE_SYSTEMS.find(t=>t.id===c.type).name)}</dd>
          <dt>Smallest</dt><dd>${Math.min(...c.composed.elements.filter(e=>e.fit).map(e=>e.fit.sizePt)).toFixed(1)} pt</dd>
          <dt>Fit ladder</dt><dd>${adj ? adj + ' adjustment' + (adj>1?'s':'') : 'untouched'}</dd>
        </dl>
        <button class="btn btn-primary" data-cmp="${i}" style="margin-top:var(--space-4)">Take this one</button>
      </div>`;
    }).join('') + '</div>';
    $$('#compareView [data-cmp]').forEach(b =>
      b.onclick = () => { state.pick = Number(b.dataset.cmp); go('detail'); });
  }
}

/* ── Detail ────────────────────────────────────────────────────────────── */
function drawDetail(design, content){
  const cand = state.gen && state.gen.picked[state.pick];
  const { front, back } = facesFor(design, content);
  const L = LAYOUTS.find(l => l.id === design.layout);

  $('#detailName').textContent = L ? L.name : 'Concept';
  $('#detailMeta').textContent = [
    PALETTES.find(p => p.id === design.palette)?.name,
    TYPE_SYSTEMS.find(t => t.id === design.type)?.name,
    state.refine ? 'refined' : null
  ].filter(Boolean).join(' · ');

  const show = state.side === 'back' ? [back] : state.side === 'both' ? [front, back] : [front];
  $('#detailCard').innerHTML = show.map(c =>
    renderSVG(c, { guides:true }) ||
    `<div class="deadbox"><span class="pill pill-warn">Eliminated</span>
      <span class="tilemeta">${esc(c?.eliminated || '')}</span></div>`).join('');
  $$('[data-side]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.side === state.side));
    b.onclick = () => { state.side = b.dataset.side; draw(); };
  });

  if (front && !front.eliminated){
    $('#detailKv').innerHTML = [
      ['Trim', `${front.fmt.w} × ${front.fmt.h} mm`],
      ['Document', `${front.fmt.w+2*front.fmt.bleed} × ${front.fmt.h+2*front.fmt.bleed} mm with bleed`],
      ['Type', front.type.name], ['Palette', front.pal.name],
      ['Guides', 'blue = 4 mm safe area · red = resolved slots']
    ].map(([k,v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  } else $('#detailKv').innerHTML = '';

  $('#why').textContent = cand ? cand.why
    : 'Chosen by hand from the library rather than ranked, so there is no scoring trace to explain.';
  $('#score').innerHTML = cand ? Object.keys(W).map(k => `
    <div class="check" style="padding:6px 0">
      <span style="flex:1">${k.replace(/([A-Z])/g,' $1').toLowerCase()}
        <span class="note">weighted ${W[k]}</span></span>
      <span class="bar" style="width:78px;margin-top:6px"><span style="width:${(cand.score.parts[k]*100).toFixed(0)}%"></span></span>
      <span class="scorenum" style="width:26px;text-align:right">${(cand.score.parts[k]*100).toFixed(0)}</span>
    </div>`).join('') + `<div class="tally" style="margin-top:10px"><span>Total <b>${
      (cand.score.total*100).toFixed(1)}</b> / 100</span></div>`
    : '<p class="lede" style="font-size:12.5px">No score for a hand-picked template.</p>';

  const log = state.instrLog[state.instrLog.length-1];
  $('#instr').innerHTML = !log ? ''
    : log.unmapped
      ? checkRow({ s:'review', label:log.note, note:'Closest it can do: ' + log.suggestions.join(' · ') })
      : checkRow({ s:'pass', label:'Understood as ' + log.matched.join(' + '),
                   note:log.ops.map(o => `${o.op}(${o.arg})`).join(' · ') })
        + (log.changes.length
            ? log.changes.map(c => `<div class="check" style="padding:5px 0"><span class="ico"></span>
                <span class="mono">${c.key}: ${esc(c.from)} → <b>${esc(c.to)}</b></span></div>`).join('')
            : '<p class="lede" style="font-size:12px">Already in that state — nothing changed.</p>');
  $('#b_undo').disabled = !state.history.length;
}


/* ── 10 · Customise — every picker emits an operation from the closed set,
   the same one the text box uses. Nothing here writes geometry. ───────── */
function drawCustomise(design, content){
  const { front } = facesFor(design, content);
  $('#custCard').innerHTML = renderSVG(front, { guides:false }) ||
    `<div class="deadbox"><span class="pill pill-warn">Eliminated</span>
      <span class="tilemeta">${esc(front?.eliminated||'')}</span></div>`;
  $('#custMeta').textContent = state.refine
    ? `${state.history.length} change${state.history.length===1?'':'s'} from the ranked concept`
    : 'Unchanged from the ranked concept';

  const apply = (op, arg) => {
    const { design:nd, changes } = applyOps(lastDesign, [{ op, arg }]);
    state.history.push({ ...lastDesign });
    state.refine = nd;
    state.instrLog.push({ ops:[{op,arg}], matched:[op], changes, unmapped:false });
    draw();
  };
  const bank = (sel, items, isOn, op) => {
    $(sel).innerHTML = items.map(([label, arg, extra]) =>
      `<button class="chip chip-sm" data-arg="${esc(arg)}" aria-pressed="${isOn(arg)}">${
        extra||''}${esc(label)}</button>`).join('');
    $$(sel + ' .chip').forEach(b => b.onclick = () => apply(op, b.dataset.arg));
  };

  bank('#altType', TYPE_SYSTEMS.filter(t=>t.id!=='__preview').map(t => [t.name.split(' + ')[1] || t.name, t.id]),
       a => design.type === a, 'setTypeSystem');
  bank('#altColour', PALETTES.filter(p=>p.id!=='__preview').map(p => [p.name, p.id,
        `<span style="display:inline-block;width:26px;height:11px;margin-right:7px;vertical-align:-1px;
          background:linear-gradient(90deg,${p.bg} 50%,${p.accent} 50%);border:1px solid var(--hair)"></span>`]),
       a => design.palette === a, 'setPalette');
  bank('#altLayout', LAYOUTS.filter(l => l.face === 'front').map(l => [l.name, l.id]),
       a => design.layout === a, 'setLayout');
  bank('#altDensity', [['Airy','airy'],['Balanced','balanced'],['Tight','tight']],
       a => design.density === a, 'setDensity');
  bank('#altCorner', [['Square','0'],['2 mm radius','2'],['4 mm radius','4']],
       a => String(design.corner || 0) === a, 'setCorner');
  bank('#altBack', LAYOUTS.filter(l => l.face === 'back').map(l => [l.name, l.id]),
       a => design.back === a, 'setBack');

  const log = state.instrLog[state.instrLog.length-1];
  $('#instr').innerHTML = !log ? ''
    : log.unmapped
      ? checkRow({ s:'review', label:log.note, note:'Closest it can do: ' + log.suggestions.join(' · ') })
      : checkRow({ s:'pass', label:'Applied ' + log.ops.map(o=>`${o.op}(${o.arg})`).join(' · '),
          note: log.changes.length ? log.changes.map(c=>`${c.key}: ${c.from} → ${c.to}`).join(' · ')
                                   : 'Already in that state' });
  $('#b_undo').disabled = !state.history.length;
}

/* ── Validate ──────────────────────────────────────────────────────────── */
