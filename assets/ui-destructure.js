/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — take a card apart
   --------------------------------------------------------------------------
   Upload a card, see it as its pieces, and restyle any piece.

   What this screen offers is deliberately bounded: colour, family, size,
   weight, case, alignment, which slot a part belongs to, and whether it
   appears. What it does not offer is a position control, and that absence is
   the feature rather than a gap. Master PRD Decision 1 keeps geometry as the
   composer's output so the card cannot come out wrong; every edit here
   re-selects a value and re-composes, and the finding count on screen is the
   finding count for exactly what you are looking at.

   A refused edit always says why and what to do instead. "7.5 pt is the
   smallest size Bangla conjuncts survive on 300 gsm" teaches the thing this
   product exists to know; a greyed-out button teaches nothing.
   ══════════════════════════════════════════════════════════════════════ */

const dst = {
  parts: null,
  preview: null,
  options: null,      // colours / families / size range for the selected part
  selected: null,
  history: [],        // previous parts states, for undo
  err: null,
  refusal: null,      // the last bounded-edit refusal, shown in place
  busy: false,
  filename: ''
};

function dstRead(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('That file could not be read off the device.'));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.readAsDataURL(file);
  });
}

async function dstUpload(file){
  dst.err = null; dst.refusal = null; dst.busy = true;
  dst.parts = null; dst.preview = null; dst.options = null; dst.selected = null; dst.history = [];
  dst.filename = file.name || '';
  draw();
  try {
    const b64 = await dstRead(file);
    const j = await api('/api/destructure', { method:'POST', quiet:true,
      body:{ file:b64, filename:file.name, mime:file.type } });
    dst.parts = j.parts; dst.preview = j.preview;
    const firstText = j.parts.parts.find(p => p.kind === 'text');
    if (firstText) await dstSelect(firstText.id);
  } catch (err){
    dst.err = { code:err.code, message:err.message, remediation:err.remediation,
                remediationText:err.remediationText };
  } finally { dst.busy = false; draw(); }
}

async function dstSelect(partId){
  dst.selected = partId; dst.options = null; dst.refusal = null;
  if (!dst.parts) return;
  try {
    dst.options = await api('/api/destructure', { method:'POST', quiet:true,
      body:{ parts:dst.parts, optionsFor:partId } });
  } catch (err){
    /* Not fatal: without the option lists the part is still selectable and its
       properties still readable, so the screen degrades to read-only rather
       than to nothing. */
    dst.options = null;
    dst.err = { code:err.code, message:err.message, remediation:err.remediation,
                remediationText:err.remediationText };
  }
  draw();
}

async function dstOp(type, value){
  if (!dst.parts || !dst.selected) return;
  dst.refusal = null; dst.busy = true; draw();
  const before = dst.parts;
  try {
    const j = await api('/api/destructure', { method:'POST', quiet:true,
      body:{ parts:dst.parts, ops:[{ type, partId:dst.selected, value }] } });
    dst.history.push(before);
    dst.parts = j.parts; dst.preview = j.preview;
    markDirty();
    dst.busy = false;
    await dstSelect(dst.selected);
    return;
  } catch (err){
    /* A bounded refusal is not an error state — it is the editor telling the
       customer something true about print. It renders beside the control that
       was refused, and the card is untouched. */
    if (err.code === 'unprocessable' || err.alternatives) {
      dst.refusal = { message:err.message, alternatives:err.alternatives || [] };
    } else {
      dst.err = { code:err.code, message:err.message, remediation:err.remediation,
                  remediationText:err.remediationText };
    }
  } finally { dst.busy = false; draw(); }
}

function dstUndo(){
  if (!dst.history.length) return;
  dst.parts = dst.history.pop();
  dst.refusal = null;
  dstSelect(dst.selected);
}

const dstPart = () => dst.parts && dst.parts.parts.find(p => p.id === dst.selected);

function dstPartList(){
  return `
    <div class="stack" style="gap:0">
      ${dst.parts.parts.map(p => {
        const label = p.kind === 'text' ? (p.text.slice(0, 34) || '(empty)')
                    : p.kind === 'panel' ? 'Panel' : p.kind === 'rule' ? 'Rule'
                    : p.kind === 'image' ? 'Image' : p.kind;
        const unsure = p.confidence < 0.75;
        return `<div class="tile parttile" role="button" tabindex="0" data-part="${esc(p.id)}"
            aria-pressed="${p.id === dst.selected}"
            style="${p.dropped ? 'opacity:.5' : ''}">
            <span class="micro">${esc(p.slot || 'unassigned')}${unsure ? ' · guess' : ''}</span>
            <b>${esc(label)}</b>
            <span class="note">${p.kind}${p.style.sizePt ? ` · ${p.style.sizePt} pt` : ''}${
              p.style.color ? ` · ${p.style.color}` : ''}${p.dropped ? ' · removed' : ''}</span>
          </div>`;
      }).join('')}
    </div>`;
}

function dstInspector(){
  const p = dstPart();
  if (!p) return '<p class="lede">Choose a part of the card to change it.</p>';
  const o = dst.options;
  const isText = p.kind === 'text';

  const colours = o && o.colours ? o.colours.slice(0, 18) : [];
  const families = o && o.families ? o.families : [];

  return `
    <div class="stack">
      <div>
        <span class="micro">Selected</span>
        <b>${esc(isText ? (p.text.slice(0, 44) || '(empty)') : p.kind)}</b>
        ${p.confidence < 0.75 ? `<p class="lede" style="font-size:12px">
          We guessed this is the <b>${esc(p.slot || 'unassigned')}</b>. Correct it below if that is wrong —
          a wrong slot changes how the composer treats it.</p>` : ''}
      </div>

      ${dst.refusal ? `<div class="state state-error" role="alert">
        <b>${esc(dst.refusal.message)}</b>
        ${dst.refusal.alternatives.length
          ? `<span class="note">Instead: ${dst.refusal.alternatives.map(esc).join(' · ')}</span>` : ''}
      </div>` : ''}

      <hr class="hair">
      <span class="lbl" id="lbl_dstslot">Which part of the card is this?</span>
      <div class="chips" role="group" aria-labelledby="lbl_dstslot">
        ${['name','role','company','contact','mark','qr'].map(s =>
          `<button class="chip" data-slot="${s}" aria-pressed="${p.slot === s}">${s}</button>`).join('')}
      </div>

      ${isText ? `
        <hr class="hair">
        <span class="lbl" id="lbl_dstsize">Size${o && o.size ? ` — floor ${o.size.floorPt} pt` : ''}</span>
        <div class="row" role="group" aria-labelledby="lbl_dstsize" style="gap:var(--space-3)">
          <button class="btn" data-size="-1">Smaller</button>
          <span class="mono">${p.style.sizePt ? p.style.sizePt + ' pt' : '—'}</span>
          <button class="btn" data-size="1">Bigger</button>
        </div>

        <hr class="hair">
        <span class="lbl" id="lbl_dstweight">Weight</span>
        <div class="chips" role="group" aria-labelledby="lbl_dstweight">
          ${[400,500,600,700,800].map(w =>
            `<button class="chip" data-weight="${w}" aria-pressed="${p.style.weight === w}">${w}</button>`).join('')}
        </div>

        <hr class="hair">
        <span class="lbl" id="lbl_dstcase">Case</span>
        <div class="chips" role="group" aria-labelledby="lbl_dstcase">
          ${['as-is','upper','lower','title'].map(c =>
            `<button class="chip" data-case="${c}" aria-pressed="${p.style.case === c}">${c}</button>`).join('')}
        </div>

        <hr class="hair">
        <span class="lbl" id="lbl_dstalign">Alignment in its own slot</span>
        <div class="chips" role="group" aria-labelledby="lbl_dstalign">
          ${['left','centre','right'].map(a =>
            `<button class="chip" data-align="${a}" aria-pressed="${p.style.align === a}">${a}</button>`).join('')}
        </div>

        <hr class="hair">
        <span class="lbl" id="lbl_dstfamily">Type</span>
        <div class="chips" role="group" aria-labelledby="lbl_dstfamily">
          ${families.map(f => `<button class="chip" data-family="${esc(f.id)}"
             ${f.available ? '' : 'disabled'} title="${esc(f.why || f.name)}"
             aria-pressed="false">${esc(f.name)}</button>`).join('')}
        </div>
        ${families.some(f => !f.available) ? `<p class="lede" style="font-size:12px">
          Greyed pairings have no Bangla family that has been checked for conjuncts, so they are not
          offered for this part.</p>` : ''}
      ` : ''}

      <hr class="hair">
      <span class="lbl" id="lbl_dstcolour">Colour</span>
      <div class="chips" role="group" aria-labelledby="lbl_dstcolour">
        ${colours.map(c => `<button class="chip" data-colour="${esc(c.hex)}"
           ${c.available ? '' : 'disabled'} aria-pressed="${p.style.color === c.hex}"
           title="${esc(c.available ? c.hex + ' — ' + c.ratio + ':1' : c.why)}"
           style="border-left:14px solid ${esc(c.hex)}">${c.ratio}:1</button>`).join('')}
      </div>
      ${colours.some(c => !c.available) ? `<p class="lede" style="font-size:12px">
        Greyed colours do not reach 4.5:1 against this ground, which is legible on a screen and
        marginal on paper. The number on each is its measured contrast.</p>` : ''}

      <hr class="hair">
      <div class="row" style="gap:var(--space-3)">
        <button class="btn" data-toggle>${p.dropped ? 'Put it back' : 'Remove this part'}</button>
      </div>
    </div>`;
}

function drawDestructure(content){
  const root = $('#destructureRoot');
  if (!root) return;

  const head = `
    <div class="sectionhd">
      <div>
        <h1>Take a card apart</h1>
        <p class="lede">Upload a card and it comes back as its pieces. Change any piece's colour, type,
          size, weight, case or alignment — and the card is recomposed and re-checked after every change,
          so it cannot end up unprintable. What you cannot do is drag things around: where each part sits
          is the composer's job, and that is exactly why the result stays correct.</p>
      </div>
    </div>`;

  const upload = `
    <div class="pad">
      ${offlineBanner()}
      <div class="field" style="max-width:520px">
        <label for="i_dstfile">A card to take apart — SVG, PDF, PNG or JPG</label>
        <input type="file" class="input" id="i_dstfile"
          accept=".svg,.pdf,.png,.jpg,.jpeg,image/svg+xml,application/pdf,image/png,image/jpeg">
      </div>
      <p class="lede" style="font-size:12.5px;max-width:60ch">
        SVG reads best and PDF next. An image gives its colours and its size but <b>not its words</b> —
        there is no OCR here, and a guessed name would not be caught until the cards were printed.
      </p>
      ${dst.filename ? `<p class="mono">${esc(dst.filename)}</p>` : ''}
    </div>`;

  let body = '';
  if (dst.busy && !dst.parts) body = `<div class="pad">${pendingBlock('Taking the card apart…')}</div>`;
  else if (dst.err && !dst.parts) body = `<div class="pad">${errorBlock(dst.err, 'Try another file')}</div>`;
  else if (dst.parts) {
    const pv = dst.preview;
    body = `
      <div class="cols">
        <div class="rail">
          <div class="railhd"><h6>The parts</h6>
            <p class="lede" style="font-size:12.5px;margin-top:6px">${dst.parts.parts.length} pieces read
              out of your card.</p></div>
          ${dstPartList()}
        </div>

        <div class="pane">
          ${pv && pv.ok ? `
            <div class="cardwrap" style="max-width:420px">${pv.svg}</div>
            <div class="row" style="gap:var(--space-4);margin-top:var(--space-4);flex-wrap:wrap">
              <span class="pill ${pv.blocking ? 'pill-warn' : 'pill-ok'}">${pv.blocking} blocking</span>
              <span class="pill">${pv.advisory} advisory</span>
              <span class="pill">${pv.passed} passed</span>
              ${dst.busy ? '<span class="note">recomposing…</span>' : ''}
            </div>
            <div class="stack" style="gap:0;margin-top:var(--space-4)">
              ${(pv.findings || []).map(checkRow).join('')}
            </div>
          ` : `<div class="state state-error" role="alert">
              <b>${esc((pv && pv.reason) || 'This card cannot be composed yet.')}</b>
              ${pv && pv.alternatives && pv.alternatives.length
                ? `<span class="note">Try: ${pv.alternatives.map(esc).join(' · ')}</span>` : ''}
            </div>`}
        </div>

        <div class="pane pane-r">${dstInspector()}</div>
      </div>`;
  }

  const actions = dst.parts
    ? bottomBar(`
        <button class="btn" data-dst-undo ${dst.history.length ? '' : 'disabled'}>Undo</button>
        <button class="btn" data-dst-reset>Start over</button>
        ${dst.preview && dst.preview.ok && !dst.preview.blocking
          ? '<button class="btn btn-primary btn-lg" data-dst-tovalidate>Preflight and export</button>'
          : '<button class="btn btn-lg" disabled>Fix the blocking finding first</button>'}`)
    : '';

  root.innerHTML = head + upload + body + actions;

  const input = $('#i_dstfile');
  if (input) input.onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) dstUpload(f);
  };
  bindTiles('#destructureRoot [data-part]', (t) => dstSelect(t.dataset.part));
  $$('#destructureRoot [data-slot]').forEach(b => b.onclick = () => dstOp('assignSlot', b.dataset.slot));
  $$('#destructureRoot [data-size]').forEach(b => b.onclick = () => dstOp('stepSize', Number(b.dataset.size)));
  $$('#destructureRoot [data-weight]').forEach(b => b.onclick = () => dstOp('setWeight', Number(b.dataset.weight)));
  $$('#destructureRoot [data-case]').forEach(b => b.onclick = () => dstOp('setCase', b.dataset.case));
  $$('#destructureRoot [data-align]').forEach(b => b.onclick = () => dstOp('setAlign', b.dataset.align));
  $$('#destructureRoot [data-family]').forEach(b => b.onclick = () => dstOp('setFamily', b.dataset.family));
  $$('#destructureRoot [data-colour]').forEach(b => b.onclick = () => dstOp('setColor', b.dataset.colour));
  const tog = $('#destructureRoot [data-toggle]');
  if (tog) tog.onclick = () => dstOp('toggle', true);
  const undo = $('#destructureRoot [data-dst-undo]');
  if (undo) undo.onclick = dstUndo;
  const reset = $('#destructureRoot [data-dst-reset]');
  if (reset) reset.onclick = () => {
    dst.parts = null; dst.preview = null; dst.options = null; dst.selected = null;
    dst.history = []; dst.err = null; dst.refusal = null; dst.filename = ''; draw();
  };
  const onward = $('#destructureRoot [data-dst-tovalidate]');
  if (onward) onward.onclick = () => {
    const pv = dst.preview;
    if (pv && pv.ok && pv.design && pv.content){
      writeForm(pv.content);
      state.format = pv.design.format; state.palette = pv.design.palette;
      state.type = pv.design.type;     state.layout = pv.design.layout;
      state.back = pv.design.back;     state.script = pv.design.script;
      state.refine = { ...pv.design };
      go('validate');
    }
  };
  bindRetry(() => { dst.err = null; draw(); });
}
