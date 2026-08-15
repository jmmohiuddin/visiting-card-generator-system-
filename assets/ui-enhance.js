/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — enhance a card someone already has
   --------------------------------------------------------------------------
   The customer here is attached to their card. The screen's job is to be
   specific about what is wrong with it, honest about which fixes are facts and
   which are opinions, and never to change the second kind without being asked.
   ══════════════════════════════════════════════════════════════════════ */

const enh = {
  parts: null,          // the decomposed card, held so accepting an improvement
  plan: null,           // does not re-upload and re-parse it
  result: null,
  accepted: new Set(),
  err: null,
  busy: false,
  filename: ''
};

/* Reading the file is the one genuinely async step before the network, and it
   fails on a phone often enough to deserve its own error rather than being
   folded into the request's. */
function enhRead(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('That file could not be read off the device.'));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.readAsDataURL(file);
  });
}

async function enhUpload(file){
  enh.err = null; enh.busy = true; enh.result = null; enh.plan = null; enh.parts = null;
  enh.filename = file.name || '';
  enh.accepted = new Set();
  draw();
  try {
    const b64 = await enhRead(file);
    const j = await api('/api/enhance', { method:'POST', quiet:true,
      body:{ file:b64, filename:file.name, mime:file.type, planOnly:true } });
    enh.parts = j.parts; enh.plan = j.plan;
    /* Improvements start unchecked, deliberately. A tool that pre-selects its
       own opinions and calls the result a recommendation has made the choice
       for someone who was never asked. */
  } catch (err){
    enh.err = { code:err.code, message:err.message, remediation:err.remediation,
                remediationText:err.remediationText };
  } finally { enh.busy = false; draw(); }
}

async function enhApply(){
  if (!enh.parts) return;
  enh.err = null; enh.busy = true; draw();
  try {
    enh.result = await api('/api/enhance', { method:'POST', quiet:true,
      body:{ parts:enh.parts, accept:[...enh.accepted], declineAll:enh.accepted.size === 0 } });
    markDirty();
  } catch (err){
    enh.err = { code:err.code, message:err.message, remediation:err.remediation,
                remediationText:err.remediationText };
  } finally { enh.busy = false; draw(); }
}

const enhBand = (b) => b === 'good' ? 'pass' : b === 'fair' ? 'review' : 'fail';

function enhTierBlock(entries, tier){
  if (!entries.length) return '';
  const optional = tier === 'improve';
  return `
    <h6>${optional ? 'Worth considering' : 'Print repairs'}</h6>
    <p class="lede" style="font-size:12.5px">${optional
      ? 'Judgements, not faults. Your card prints correctly without any of these — turn on the ones you agree with.'
      : 'Not optional, and none of them change how your card looks. They are what stops it being cut wrong or drying badly.'}</p>
    <div class="stack" style="gap:var(--space-3);margin-top:var(--space-3)">
      ${entries.map(e => `
        <div class="check">
          <span class="ico i-${optional ? 'review' : 'pass'}">${ICON[optional ? 'review' : 'pass']}</span>
          <span>
            ${optional
              ? `<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
                   <input type="checkbox" data-improve="${esc(e.id)}"
                     ${enh.accepted.has(e.id) ? 'checked' : ''}>
                   <b>${esc(e.label)}</b></label>`
              : `<b>${esc(e.label)}</b>`}
            <span class="note">${esc(e.why)}</span>
          </span>
        </div>`).join('')}
    </div>`;
}

function drawEnhance(content){
  const root = $('#enhanceRoot');
  if (!root) return;

  const head = `
    <div class="sectionhd">
      <div>
        <h1>Enhance a card you already have</h1>
        <p class="lede">Upload the card you use now. This does not design you a new one — it says
          exactly what would go wrong on press, fixes what is simply wrong, and asks before changing
          anything that is a matter of taste.</p>
      </div>
    </div>`;

  const upload = `
    <div class="pad">
      ${offlineBanner()}
      <div class="field" style="max-width:520px">
        <label for="i_enhfile">Your card — SVG, PDF, PNG or JPG</label>
        <input type="file" class="input" id="i_enhfile"
          accept=".svg,.pdf,.png,.jpg,.jpeg,image/svg+xml,application/pdf,image/png,image/jpeg">
      </div>
      <p class="lede" style="font-size:12.5px;max-width:60ch">
        An SVG or a PDF reads best, because the text is still text. A photograph or a PNG gives us the
        size, the resolution and the colours — <b>not the words</b>. Nothing here guesses at what your
        card says: if it cannot be read, you will be told, and you type it once.
      </p>
      ${enh.filename ? `<p class="mono">${esc(enh.filename)}</p>` : ''}
    </div>`;

  let body = '';
  if (enh.busy) body = `<div class="pad">${pendingBlock('Reading your card…')}</div>`;
  else if (enh.err) body = `<div class="pad">${errorBlock(enh.err, 'Try another file')}</div>`;
  else if (enh.plan) {
    const q = enh.plan.quality;
    const r = enh.result;
    body = `
      <div class="pad">
        <div class="row" style="gap:var(--space-8);flex-wrap:wrap;align-items:flex-start">
          <div>
            <span class="micro">As uploaded</span>
            <div class="row" style="gap:8px;align-items:baseline">
              <span class="ico i-${enhBand(q.band)}">${ICON[STATE_ICON[enhBand(q.band)]]}</span>
              <b style="font-size:22px">${q.score}</b><span class="note">/ 100 · ${esc(q.band)}</span>
            </div>
          </div>
          ${r && r.after ? `
          <div>
            <span class="micro">After the repairs${enh.accepted.size ? ' and your choices' : ''}</span>
            <div class="row" style="gap:8px;align-items:baseline">
              <span class="ico i-${enhBand(r.after.quality.band)}">${ICON[STATE_ICON[enhBand(r.after.quality.band)]]}</span>
              <b style="font-size:22px">${r.after.quality.score}</b><span class="note">/ 100 · ${esc(r.after.quality.band)}</span>
            </div>
          </div>` : ''}
        </div>

        <hr class="hr">
        <h6>What is wrong with it now</h6>
        <div class="stack" style="gap:0;margin-top:var(--space-3)">
          ${enh.plan.findings.map(checkRow).join('')}
        </div>

        <hr class="hr">
        ${enhTierBlock(enh.plan.repairs, 'repair')}
        ${enh.plan.improvements.length ? '<hr class="hair">' : ''}
        ${enhTierBlock(enh.plan.improvements, 'improve')}
      </div>`;

    if (r && r.svg) {
      body += `
        <hr class="hr">
        <div class="pad">
          <h6>The result</h6>
          <p class="lede" style="font-size:12.5px">Composed by the same engine that builds a card from a
            brief, and checked by the same preflight — so this can go straight to export or to a print run.</p>
          <div class="cardwrap" style="max-width:420px;margin-top:var(--space-4)">${r.svg}</div>
          <div class="row" style="gap:var(--space-4);margin-top:var(--space-4);flex-wrap:wrap">
            <span class="pill ${r.blocking ? 'pill-warn' : 'pill-ok'}">${r.blocking} blocking</span>
            <span class="pill">${r.advisory} advisory</span>
            <span class="pill">${r.passed} passed</span>
          </div>
          <div class="stack" style="gap:0;margin-top:var(--space-4)">
            ${(r.findings || []).map(checkRow).join('')}
          </div>
          ${r.declined && r.declined.length ? `
            <hr class="hair">
            <p class="lede" style="font-size:12.5px">Still on offer whenever you want them:
              ${r.declined.map(d => esc(d.label)).join(' · ')}.</p>` : ''}
        </div>`;
    }
  }

  const actions = enh.plan
    ? bottomBar(`
        <button class="btn" data-enh-reset>Start over</button>
        <button class="btn btn-primary btn-lg" data-enh-apply ${enh.busy ? 'disabled' : ''}>
          ${enh.result ? 'Apply again' : (enh.accepted.size ? 'Repair and apply my choices' : 'Repair only')}
        </button>
        ${enh.result && enh.result.svg
          ? '<button class="btn" data-enh-tovalidate>Preflight and export</button>' : ''}`)
    : '';

  root.innerHTML = head + upload + body + actions;

  const input = $('#i_enhfile');
  if (input) input.onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) enhUpload(f);
  };
  $$('#enhanceRoot [data-improve]').forEach(box => box.onchange = () => {
    const id = box.dataset.improve;
    box.checked ? enh.accepted.add(id) : enh.accepted.delete(id);
    /* Redrawn so the primary action's label tracks the choice — "Repair only"
       and "Repair and apply my choices" are different promises, and the button
       should not make the wrong one. */
    draw();
  });
  const apply = $('#enhanceRoot [data-enh-apply]');
  if (apply) apply.onclick = enhApply;
  const reset = $('#enhanceRoot [data-enh-reset]');
  if (reset) reset.onclick = () => {
    enh.parts = null; enh.plan = null; enh.result = null; enh.err = null;
    enh.accepted = new Set(); enh.filename = ''; draw();
  };
  const onward = $('#enhanceRoot [data-enh-tovalidate]');
  if (onward) onward.onclick = () => {
    /* The enhanced card becomes the live design, so validate, export and order
       operate on it exactly as they would on a generated one. Anything less
       would mean a second, weaker path to a print file. */
    const r = enh.result;
    if (r && r.design && r.content){
      writeForm(r.content);
      state.format = r.design.format; state.palette = r.design.palette;
      state.type = r.design.type;     state.layout = r.design.layout;
      state.back = r.design.back;     state.script = r.design.script;
      state.refine = { ...r.design };
      go('validate');
    }
  };
  bindRetry(() => { enh.err = null; draw(); });
}
