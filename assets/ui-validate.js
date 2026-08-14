/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — preflight and constraint conflict
   --------------------------------------------------------------------------
   The validate screen and the no-results screen — the two places the print
   guarantee is enforced in the interface.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

function drawValidate(design, content){
  const { front, back } = facesFor(design, content);
  const pf = allFindings(front, back);
  const n = s => pf.filter(f => f.s === s).length;
  $('#pfTally').innerHTML =
    `<span class="tally"><span><b>${n('fail')}</b> blocking</span>
     <span><b>${n('review')}</b> advisory</span><span><b>${n('pass')}</b> pass</span></span>`;
  $('#preflight').innerHTML = pf.map(checkRow).join('');

  const tr = [...(front?.trace||[]).map(t => ({...t,f:'front'})),
              ...(back?.trace||[]).map(t => ({...t,f:'back'}))];
  $('#trace').innerHTML = tr.length
    ? tr.map(t => `<div class="mono">${t.f}/${t.slot} → ${esc(t.applied.join(' → '))}${
        t.note ? ` <span class="note">${esc(t.note)}</span>` : ''}</div>`).join('')
    : '<p class="lede" style="font-size:12.5px">Nothing needed adjusting — the content fits every slot as authored.</p>';

  if (front && !front.eliminated){
    $('#spec').textContent = JSON.stringify({
      format:front.fmt.id, layoutFront:front.face.id, layoutBack:design.back,
      typeSystem:front.type.id, palette:front.pal.id, density:design.density,
      composed_front: front.elements.filter(e => e.fit).map(e => ({
        slot:e.ref, script:e.fit.script,
        box:{x:+e.geom.x.toFixed(2),y:+e.geom.y.toFixed(2),w:+e.geom.w.toFixed(2),h:+e.geom.h.toFixed(2)},
        type:{size_pt:+e.fit.sizePt.toFixed(2), lines:e.fit.lines.length},
        ladder:e.fit.applied }))
    }, null, 1);
  } else $('#spec').textContent = '// eliminated — no spec produced';
}

/* ── Export ────────────────────────────────────────────────────────────── */
function diagnose(content){
  const base = { industry:state.industry, personality:state.personality,
                 format:state.format, density:state.density,
                 script:(state.script==='bangla'||state.script==='bangla-only')?'bangla':'latin' };
  const trials = [
    { label:'Use a larger card', note:`${FORMATS.find(f=>f.id===state.format).name} cannot hold this much content at a legible size.`,
      cta:'Switch to 89 × 51 mm', apply:() => { state.format='bd-std'; $('#i_format').value='bd-std'; },
      test:{ ...base, format:'bd-std' } },
    { label:'Shorten the role or qualifications', note:'The longest field is what eliminates most layouts.',
      cta:'Drop the qualifications', apply:() => { $('#i_quals').value=''; },
      test:base, mutate:c => ({ ...c, quals:'' }) },
    { label:'Move the contact routes to the back', note:'Four routes on the front leaves no room for the name.',
      cta:'Use a contact back', apply:() => { state.back='back.contact'; $('#i_back').value='back.contact'; },
      test:base, mutate:c => ({ ...c, p2:'', web:'', addr:'' }) }
  ];
  return trials.map(t => {
    const c = t.mutate ? t.mutate(content) : content;
    let n = 0;
    try { n = generate(t.test, c, { n:6 }).picked.length; } catch(e){ n = 0; }
    return { ...t, restores:n };
  }).sort((a,b) => b.restores - a.restores);
}
function drawNoResults(content){
  const fmt = FORMATS.find(f => f.id === state.format);
  $('#conflict').innerHTML = [
    ['Constraint A', `${fmt.name}`, 'Chosen in step 05. Every slot must sit inside the 4 mm safe area at this trim.'],
    ['Constraint B', 'The content you entered', `The longest field is ${
      [content.name, content.role + (content.quals?' · '+content.quals:''), content.company]
        .sort((a,b)=>String(b).length-String(a).length)[0]?.slice(0,58) || '—'}.`]
  ].map(([k,t,n]) => `<div class="stack" style="gap:6px"><h6 style="color:var(--color-accent)">${k}</h6>
      <b>${esc(t)}</b><span class="lede" style="font-size:13px;margin:0">${esc(n)}</span></div>`).join('');

  const opts = diagnose(content);
  $('#resolutions').innerHTML = opts.map((o,i) =>
    `<button class="tile" role="button" tabindex="0" aria-pressed="false" data-fix="${i}">
      <span class="tiletitle">${esc(o.label)}</span>
      <span class="tilemeta">${esc(o.note)}</span>
      <span class="pill ${o.restores?'pill-ok':'pill-warn'}">${
        o.restores ? o.restores + ' concepts return' : 'still nothing'}</span>
      <span class="btn" style="pointer-events:none;align-self:flex-start">${esc(o.cta)}</span>
    </button>`).join('');
  bindTiles('#resolutions .tile', t => { opts[Number(t.dataset.fix)].apply(); runGenerate(); });
}

/* ── ORDER ───────────────────────────────────────────────────────────────── */
