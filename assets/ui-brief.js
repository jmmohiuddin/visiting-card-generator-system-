/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — brief funnel
   --------------------------------------------------------------------------
   Start screen, the seven-step brief, and the generating screen.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

function drawBrief(content){
  $$('[data-step]').forEach(p => {
    p.style.display = Number(p.dataset.step) === state.step ? 'flex' : 'none';
  });
  $('#rail').innerHTML = STEPS.map(([n,l],i) =>
    `<button class="railitem" data-step-go="${i}" aria-current="${i===state.step?'step':'false'}">
      <span class="railnum">${n}</span><span>${l}</span>
      ${i < state.step ? `<span class="railmark">${ICON.check}</span>` : ''}
    </button>`).join('')
    + STAGES.map(([n,l,sc]) => {
      const locked = stageState(sc) === 'locked';
      return `<button class="railitem" data-stage-go="${sc}" ${locked?'disabled':''}
        style="${locked?'color:var(--faint)':''}">
        <span class="railnum">${n}</span><span>${l}</span></button>`;
    }).join('');
  $$('#rail [data-step-go]').forEach(b =>
    b.onclick = () => { state.step = Number(b.dataset.stepGo); draw(); });
  $$('#rail [data-stage-go]').forEach(b => b.onclick = () => goStage(b.dataset.stageGo));

  const last = state.step === 6;
  $('#b_next').innerHTML = last
    ? `Compose six concepts ${ICON.next}` : `Continue ${ICON.next}`;
  $('#b_prev').innerHTML = `${ICON.prev} Back`;
  $('#b_prev').disabled = state.step === 0;
  $('#stepHint').textContent = last ? 'About a second' : 'You can come back to any step';

  const sel = state.personality;
  $('#persNote').textContent = sel.length
    ? `${sel.length} of 3 — ${sel.map(a => AXIS_WORD[a]).join(', ')}`
    : 'Nothing selected. The system will infer from the industry instead, and say so.';

  const intent = resolveIntent({ industry:state.industry, personality:state.personality });
  const lux = state.personality.includes('premium') || state.personality.includes('traditional');
  $('#implies').innerHTML = [
    ['Reading', intent.note],
    ['Script', { latin:'English front, বাংলা back', bangla:'বাংলা front, English back',
                 'latin-only':'English only', 'bangla-only':'বাংলা only' }[state.script]],
    ['Type floor', (state.script === 'latin-only') ? '6.0 pt' : '7.5 pt — Bangla conjuncts'],
    ['Palette', lux ? 'Dark ground, one metal' : 'High contrast, restrained'],
    ['Finishes', state.finishes.map(f => FINISH_COST[f].label).join(' · ') || 'None yet'],
    ['Run', `${state.qty} cards`]
  ].map(([k,v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');

  if (last){
    $('#reviewKv').innerHTML = [
      ['Name', content.name || '—'], ['Role', content.role || '—'],
      ['Company', content.company || '—'],
      ['বাংলা', content.bname || '—'],
      ['Routes', [content.p1, content.p2, content.email, content.web].filter(Boolean).length + ' collected'],
      ['Industry', INDUSTRIES[state.industry].label],
      ['Personality', state.personality.map(a => AXIS_WORD[a]).join(' · ') || 'inferred'],
      ['Size', FORMATS.find(f => f.id === state.format).name],
      ['Logo', state.logo ? 'Accepted' : 'Monogram from the company name']
    ].map(([k,v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  }
}

/* ── Generating ────────────────────────────────────────────────────────── */
function drawGenerating(){
  const g = state.gen; if (!g) return;
  const rows = [
    ['Reading the brief', Object.keys(g.intent.vector).filter(k => g.intent.vector[k] > 0).length + ' signals'],
    ['Enumerating layout × palette × type', g.stages.enumerated + ' candidates'],
    ['Composing with your real text', g.stages.composed + ' survived the fit ladder'],
    ['Preflighting geometry', g.stages.printSafe + ' with no blocking finding'],
    ['Scoring against the brief', g.considered + ' ranked'],
    ['Enforcing diversity', g.stages.selected + ' selected']
  ];
  $('#pipeline').innerHTML = rows.map(([a,b],i) => {
    const done = state.genStage > i, now = state.genStage === i;
    return `<div class="check ${done?'stage':''}" style="${done?'':'opacity:.32'}">
      <span class="ico ${done?'i-pass':''} ${now?'ticking':''}">${done?ICON.pass:ICON.dot}</span>
      <span>${a}<span class="note mono">${done?b:''}</span></span></div>`;
  }).join('');
}

/* ── Concepts ──────────────────────────────────────────────────────────── */
function drawStart(){
  const r = readSentence($('#i_sentence').value);
  $('#startExamples').innerHTML = [
    'I am a medicine consultant with a chamber in Dhanmondi',
    'I run a knitwear buying house in Uttara dealing with European buyers',
    'আমি নিউ মার্কেটে একটি ইলেকট্রনিক্সের দোকান চালাই',
    'I am an advocate practising at the Supreme Court'
  ].map(x => `<button class="chip chip-sm" data-ex="${esc(x)}">${esc(x)}</button>`).join('');
  $$('#startExamples .chip').forEach(b => b.onclick = () => { $('#i_sentence').value = b.dataset.ex; draw(); });

  const conf = v => v ? 'High' : 'Low';
  const rows = [
    ['Industry', r.industry ? INDUSTRIES[r.industry].label : 'not stated — step 01 asks', conf(r.industry)],
    ['Personality', r.personality.length ? r.personality.map(a => AXIS_WORD[a]).join(' · ') : 'not stated — step 04 asks', conf(r.personality.length)],
    ['Script', r.script ? 'বাংলা detected' : 'English assumed — step 05 asks', conf(r.script)],
    ['Card size', FORMATS.find(f => f.id === state.format).name, 'High'],
    ['Budget', 'not stated — step 06 asks', 'Low']
  ];
  $('#inferred').innerHTML = rows.map(([k,v,c]) =>
    `<div class="check"><span style="flex:1">${k}<span class="note">${esc(v)}</span></span>
     <span class="pill ${c==='High'?'pill-ok':'pill-warn'}">${c}</span></div>`).join('');
}

/* ── NO RESULTS — a real diagnosis, by re-running with each constraint out ── */
