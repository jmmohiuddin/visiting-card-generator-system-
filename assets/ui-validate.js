/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — preflight and constraint conflict
   --------------------------------------------------------------------------
   The validate screen and the no-results screen — the two places the print
   guarantee is enforced in the interface.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.
   ══════════════════════════════════════════════════════════════════════ */

/* ── What this file owes the user ────────────────────────────────────────
   Master PRD Epic D asks for three things. Counts that come from the check
   run for this design rather than from a constant. An advisory tier that
   cannot be passed without someone accepting it on the record. A blocking
   tier with no override at all.

   The first two are presentation. The third is not, and it is the reason
   the refusal below sits on the draw path rather than on a button: a screen
   that only hides its Continue control is walked around by the stage rail,
   by a restored session, or by typing a hash. Wrapping `draw` is the same
   idiom `assets/ui-init.js` uses to add persistence, and it puts every
   route into Export and Order — every one, including the ones written by
   other people after this — through the same gate. */

const PF_SEVERITY = { fail:'blocking', review:'advisory', pass:'pass', info:'informational' };

/* The two screens a design has to be printable to reach. Export hands over
   files that go to a press; Order commits money against them. */
const PF_GATED = { export:'Export', order:'Order' };

/* The markup for these two screens belongs to index.html, which is being
   rebuilt mobile-first by other hands at the same time. Rather than depend
   on a node that may move, every container this file writes into is fetched
   through here and created inside its screen if it is not already there. */
function pfMount(id, screen){
  const found = $('#' + id);
  if (found) return found;
  const host = $(`[data-screen="${screen}"]`);
  if (!host || typeof document.createElement !== 'function') return null;
  const el = document.createElement('div');
  el.id = id;
  host.appendChild(el);
  return el;
}

/* ── The subject of a check run ──────────────────────────────────────────
   Everything that changes the verdict and nothing that does not, in exactly
   the shape `subjectOf()` in lib/preflight-gate.mjs hashes on the server.
   Keeping the two identical is what lets an acceptance recorded here be
   found again by the server under the same key, and what lets a design
   checked on screen be recognised as the same design at order time. */
function pfSubject(design, content){
  const share = specFor(design.layout, content).share;
  return {
    design: { layout:design.layout, back:design.back, format:design.format,
              type:design.type, palette:design.palette, density:design.density,
              corner:design.corner || 0, script:design.script },
    content,
    finishes: (design.finishes || state.finishes || []).slice().sort(),
    share: { origin:share.origin, code:share.code || null }
  };
}
const pfKey = (design, content) => specHash(pfSubject(design, content));

/* ── The acceptance ledger ───────────────────────────────────────────────
   Technical Design §6.3: an advisory finding may be printed only with an
   explicit acceptance recorded against a named person and a timestamp,
   because that row is the product's defence if a customer disputes a
   completed run. "We showed a warning" is an assertion; "this person
   accepted this sentence at this time, and the sentence itself is copied
   into the record" is evidence. The authority for that record is the server
   — lib/preflight-gate.mjs writes it into a table that refuses updates and
   deletes — so what is kept here is a cache and an offline queue, never the
   record itself, and the screen says which of the two it is looking at.

   The local id hashes the finding the customer actually read rather than
   the check it came from, so rewording a check correctly invalidates
   consent given to the older sentence. It deliberately does not mirror the
   server's severity-code table: the id sent with an acceptance is always
   the one the server put in its own report, which is what stops the two
   from drifting into a mismatch that would quietly lose a record. */
const PF_LEDGER = 'cardworks.preflight.acceptances';
const pfLocalId = f => specHash({ face:f.face || '', label:f.label, note:f.note || '' }).slice(0,12);

/* Who accepted. Until A5's phone accounts land, the strongest identity
   available is the name typed on the sign-in screen, falling back to the
   per-browser key — weaker evidence, and named as such on screen rather
   than dressed up as an account. */
function pfActor(){
  const acct = lsGet('cardworks.account', {}) || {};
  const named = String(acct.name || acct.email || '').trim();
  return { label: named || ('device ' + (ownerKey() || 'unknown')), named: !!named };
}

const pfLedgerAll = () => lsGet(PF_LEDGER, {}) || {};
const pfLedgerFor = key => pfLedgerAll()[key] || {};
function pfLedgerWrite(key, lid, row){
  const all = pfLedgerAll();
  all[key] = { ...(all[key] || {}), [lid]:row };
  /* Bounded: a browser accumulates one entry per design it ever checked,
     and the useful ones are the recent ones. */
  const keys = Object.keys(all);
  if (keys.length > 24) delete all[keys[0]];
  lsSet(PF_LEDGER, all);
}

/* ── The server check run ────────────────────────────────────────────────
   A2's /api/preflight runs the same engine file on the server and returns
   the report plus the acceptances already on file, so the screen shows the
   verdict that will actually be enforced at order time rather than a second
   opinion. It also computes the two bands the browser cannot — finish
   clearance and lead time — which is why its findings, when present, are
   what gets displayed and counted.

   Offline is not an error here. Technical Design §9 requires briefing and
   preview to work with no network at all, so the on-device run stands on
   its own and an acceptance taken offline is queued and flushed on the next
   successful sync, with the screen saying plainly which state it is in. */
let pfNet = { key:null, report:null, error:null, pending:false };

/* There has to be a server before it is worth asking one. Offline is the
   obvious case; the other is a page that was never served over http at all
   — opened from disk, or loaded into a headless harness — where a relative
   URL resolves to nothing and the only thing the attempt produces is an
   entry in the shell's shared `net.pending`, which another screen then reads
   as its own pending state. `specFor` already tests the origin this way
   before it will put a link in a QR code. */
const pfCanReachServer = () =>
  !isOffline() && typeof fetch === 'function' &&
  typeof location !== 'undefined' && /^https?:/.test(location.origin || '');

async function pfSync(design, content){
  const key = pfKey(design, content);
  if (pfNet.key === key && !pfNet.retry) return;          // one run per design, not per repaint
  pfNet = { key, report:null, error:null, pending:true };
  try {
    const report = await api('/api/preflight', { method:'POST', quiet:true, body:{
      design: pfSubject(design, content).design,
      content, finishes:(design.finishes || state.finishes || []).slice(),
      share: specFor(design.layout, content).share
    }});
    if (pfNet.key !== key) return;
    pfNet = { key, report, error:null, pending:false };
    await pfFlushQueue(design, content, report);
  } catch (err){
    if (pfNet.key !== key) return;
    /* Carried whole, token and any prose fallback together, so whatever
       renders it can put it through `remedyText` rather than guessing. */
    pfNet = { key, report:null, pending:false,
              error:{ message:err.message, remediation:err.remediation,
                      remediationText:err.remediationText } };
  }
  draw();
}

/* Acceptances taken while the server was unreachable. They are replayed in
   the order they were given, and a replay that fails stays queued rather
   than being dropped — losing one silently would leave a design printable
   on this device with no evidence anywhere that anyone accepted anything. */
async function pfFlushQueue(design, content, report){
  const key = pfKey(design, content);
  const rows = pfLedgerFor(key);
  const queued = Object.entries(rows).filter(([, r]) => !r.recorded);
  for (const [lid, row] of queued){
    const f = (report.findings || []).find(x => pfLocalId(x) === lid);
    if (!f) continue;
    try {
      await api('/api/preflight', { method:'POST', quiet:true, body:{
        action:'accept', findingId:f.id, acceptedBy:row.by,
        design: pfSubject(design, content).design,
        content, finishes:(design.finishes || state.finishes || []).slice(),
        share: specFor(design.layout, content).share
      }});
      pfLedgerWrite(key, lid, { ...row, recorded:true });
    } catch (err){ /* stays queued; the screen keeps saying it is not on the record */ }
  }
}

/* ── The findings for this design ────────────────────────────────────────
   Composed once per design and reused by the tally, the list, the trace and
   the spec pane, because the alternative is four compositions per repaint
   and a keystroke that stutters on the mid-range Android this is drawn for. */
let pfLocal = { key:null, list:[], front:null, back:null };

function pfFindings(design, content){
  const key = pfKey(design, content);
  if (pfLocal.key === key) return pfLocal.list;
  const { front, back } = facesFor(design, content);
  const list = allFindings(front, back).map(f =>
    ({ ...f, severity:PF_SEVERITY[f.s] || 'informational', lid:pfLocalId(f) }));
  pfLocal = { key, list, front, back };
  return list;
}

/** The gate. `ok` is the whole print guarantee expressed as one boolean:
 *  no blocking finding, and every advisory finding accepted on the record.
 *  It is exported deliberately — the export and order screens should ask
 *  this rather than re-deriving a second opinion from the same findings. */
function preflightGate(design, content){
  const key = pfKey(design, content);
  let list;
  try {
    list = pfFindings(design, content);
  } catch (err){
    /* A design the library can no longer compose is not printable, and the
       gate says so rather than failing open. Refusing a design we cannot
       check is the only safe direction for a print guarantee. */
    return { key, ok:false, findings:[], blocking:[], advisory:[], pending:[],
             counts:{ pass:0, advisory:0, blocking:0, informational:0 },
             error:{ message:'This design cannot be composed, so it cannot be checked.',
                     remediation:'Regenerate — a component it names may no longer exist.',
                     detail:String(err && err.message) } };
  }

  const srv = (pfNet.key === key && pfNet.report) ? pfNet.report : null;
  if (srv) list = (srv.findings || []).map(f =>
    ({ ...f, severity:f.severity || PF_SEVERITY[f.s] || 'informational', lid:pfLocalId(f), sid:f.id }));

  const ledger = pfLedgerFor(key);
  const rows = (srv && srv.acceptances) || [];
  const accepted = new Map();
  for (const f of list){
    const local = ledger[f.lid];
    const remote = f.sid ? rows.find(a => a.finding_id === f.sid) : null;
    if (!local && !remote) continue;
    accepted.set(f.lid, {
      by: local ? local.by : remote.accepted_by,
      at: local ? local.at : remote.accepted_at,
      recorded: !!remote || !!(local && local.recorded)
    });
  }

  /* One grouping pass, and every count on the screen is the length of one of
     these arrays. Counting the tiers separately from the arrays the screen
     renders is how two numbers describing the same thing end up disagreeing
     — which is the defect Epic D names, whether or not either number was
     hardcoded. A severity the model does not know goes to informational,
     because the one thing it must never do is silently become a pass. */
  const by = { blocking:[], advisory:[], pass:[], informational:[] };
  for (const f of list) (by[f.severity] || by.informational).push(f);
  const pending = by.advisory.filter(f => !accepted.has(f.lid));

  return { key, findings:list, accepted, server:srv, pending,
           blocking:by.blocking, advisory:by.advisory,
           passed:by.pass, informational:by.informational,
           counts:{ pass:by.pass.length, advisory:by.advisory.length,
                    blocking:by.blocking.length, informational:by.informational.length },
           ok: by.blocking.length === 0 && pending.length === 0 };
}

/** Write the consent down. Synchronous and local, so it survives a dropped
 *  connection and so the refusal below is a fact the caller can test rather
 *  than a promise it has to wait on.
 *
 *  Only an advisory can be accepted. A blocking finding has no acceptance
 *  path at all — not here, and not in `recordAcceptance` on the server — so
 *  this returns null rather than quietly doing nothing. */
function pfRecordAcceptance(design, content, lid){
  const g = preflightGate(design, content);
  const f = g.advisory.find(x => x.lid === lid);
  if (!f) return null;
  const who = pfActor();
  pfLedgerWrite(g.key, lid, { by:who.label, at:new Date().toISOString(),
                              label:f.label, face:f.face || '', recorded:false });
  return { key:g.key, finding:f, who };
}

/** Record an acceptance and then put it where it counts. Local first, then
 *  the server, which is where it stops being a note to ourselves. */
async function pfAccept(design, content, lid){
  const rec = pfRecordAcceptance(design, content, lid);
  if (!rec) return false;
  const { finding:f, who } = rec;
  draw();
  /* No server to tell, or no report yet to take the finding's id from: the
     consent is written down either way and the queue carries it the rest of
     the distance, which is the whole reason the local write comes first. */
  if (!pfCanReachServer()) return true;
  if (!f.sid) { pfNet = { ...pfNet, retry:true }; pfSync(design, content); return true; }
  try {
    await api('/api/preflight', { method:'POST', quiet:true, body:{
      action:'accept', findingId:f.sid, acceptedBy:who.label,
      design: pfSubject(design, content).design,
      content, finishes:(design.finishes || state.finishes || []).slice(),
      share: specFor(design.layout, content).share
    }});
    pfLedgerWrite(rec.key, lid, { ...pfLedgerFor(rec.key)[lid], recorded:true });
  } catch (err){ /* queued; pfFlushQueue replays it on the next sync */ }
  draw();
  return true;
}

/* ── The refusal ─────────────────────────────────────────────────────────
   Wrapping `draw` rather than `go` is deliberate: `go` is one of several
   ways a screen changes — a restored session and the stage rail set it
   directly — and only the draw path is common to all of them. A refused
   navigation lands on Validate with the findings that caused it, which is
   the only screen that can do anything about them. */
let pfRefusal = null;

const drawBeforePreflightGate = draw;
draw = function(){
  let gate = null;
  if (state.gen && state.gen.picked && state.gen.picked.length){
    gate = preflightGate(currentDesign(), readForm());
    if (PF_GATED[state.screen] && !gate.ok){
      pfRefusal = { key:gate.key, from:PF_GATED[state.screen] };
      state.screen = 'validate';
    }
    if (gate.ok && pfRefusal && pfRefusal.key === gate.key) pfRefusal = null;
  }
  drawBeforePreflightGate();
  pfLockStages(gate);
};

/* The rail must not offer a step it will refuse. Wireframing §5.8 puts this
   as "disabled while any blocking item is unresolved — no override". */
function pfLockStages(gate){
  const b = $('#stagebar [data-stage="export"]');
  if (!b || !b.setAttribute) return;
  const locked = !!gate && !gate.ok;
  if (locked){
    b.disabled = true;
    b.setAttribute('aria-disabled', 'true');
    b.setAttribute('title', gate.blocking.length
      ? `${gate.blocking.length} blocking finding${gate.blocking.length > 1 ? 's' : ''} — preflight refuses export`
      : `${gate.pending.length} advisory finding${gate.pending.length > 1 ? 's' : ''} not yet accepted`);
  }
}

/* ══════════════════════════ VALIDATE ══════════════════════════ */

const pfWhen = iso => { try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } };

function pfRow(f, inner){
  const k = STATE_ICON[f.s] || 'dot';
  return `<div class="check"><span class="ico i-${f.s}">${ICON[k]}</span><span>${
    f.face ? `<b>${esc(f.face)}</b> · ` : ''}${esc(f.label)}${
    f.note ? `<span class="note">${esc(f.note)}</span>` : ''}${inner || ''}</span></div>`;
}

function drawValidate(design, content){
  const g = preflightGate(design, content);
  if (pfCanReachServer()) pfSync(design, content);

  /* Epic D: the numbers are the length of the arrays the check run just
     produced. There is no constant anywhere on this screen for a fixed pair
     of totals to be baked into and then drift from.

     The three §6.3 tiers Wireframing §5.8 draws are always listed, empty or
     not, and the informational tier joins them whenever the run produced
     one — so the numbers visibly add up to the total beside them. A tally
     that does not reconcile with its own total is the same failure as a
     stale one: the reader cannot tell which number to believe. */
  const tiers = [
    ['passed',          g.passed],
    ['advisory',        g.advisory],
    ['blocking',        g.blocking],
    ['for information', g.informational]
  ].filter(([, rows], i) => i < 3 || rows.length);

  const tally = $('#pfTally');
  if (tally) tally.innerHTML =
    `<span class="tally">${
       tiers.map(([label, rows]) => `<span><b>${rows.length}</b> ${label}</span>`).join('')}
       <span>${g.findings.length} checks run on this design${
         g.server ? ', on the server' : ', on this device'}</span>
     </span>`;

  const out = [];
  out.push(offlineBanner());
  if (pfRefusal && pfRefusal.key === g.key)
    out.push(`<div class="state state-error" role="alert">
      <b>${esc(pfRefusal.from)} is refused while preflight is not clear.</b>
      <span class="note">${g.blocking.length
        ? 'A blocking finding cannot be overridden — fix it below and the step opens by itself.'
        : 'Every advisory finding has to be accepted, on the record, first.'}</span></div>`);
  /* `remediation` is a token a screen branches on, not a sentence a customer
     reads — rendering it directly puts the word `wait` on the screen. The
     shell owns the token-to-sentence table; prose written by hand, like the
     one this file sets when a design will not compose, passes through it
     unchanged. */
  if (g.error){
    const remedy = remedyText(g.error);
    out.push(`<div class="state state-error" role="alert"><b>${esc(g.error.message)}</b>${
      remedy ? `<span class="note">${esc(remedy)}</span>` : ''}</div>`);
  }
  if (pfNet.key === g.key && pfNet.pending) out.push(pendingBlock('Checking on the server…'));
  if (pfNet.key === g.key && pfNet.error)
    out.push(`<div class="state state-offline" role="status">
      <b>The server check did not run.</b>
      <span class="note">${esc(pfNet.error.message)} The on-device run below still holds — it is the same
        checks from the same engine file — but an acceptance cannot be written to the order until it does.</span></div>`);

  const fixes = g.blocking.length ? pfFixes(design, content) : [];
  if (g.blocking.length){
    out.push(`<h6 style="margin:var(--space-4) 0 8px">${g.blocking.length} blocking</h6>`);
    out.push(g.blocking.map(f => pfRow(f)).join(''));
    /* Wireframing §5.8, blocking variant: the only actions offered are ones
       that resolve the finding. Each of these was applied to a copy of the
       design and re-checked before it was offered, so the label is a
       measured claim rather than a hopeful one. */
    out.push(fixes.length
      ? `<p class="lede" style="font-size:12.5px;margin-top:var(--space-4)">There is no way past this.
           Each of these was tried against your content and clears every blocking finding:</p>
         <div class="stack" style="gap:8px;margin-top:10px">${
           fixes.map((fx,i) => `<button class="btn" data-pf-fix="${i}" style="align-self:flex-start">
             ${esc(fx.label)}</button>${fx.note
               ? `<span class="note" style="font-size:12px;color:var(--muted)">${esc(fx.note)}</span>` : ''}`).join('')}
         </div>`
      : `<p class="lede" style="font-size:12.5px;margin-top:var(--space-4)">Nothing in the library clears this
           with the content as it stands. Go back to the brief and shorten the longest field — that is the
           one that eliminates layouts.</p>
         <div class="stack" style="gap:8px;margin-top:10px">
           <button class="btn" data-pf-brief="1" style="align-self:flex-start">Back to the brief</button></div>`);
  }

  /* Wireframing §5.8 draws the acceptance as a checkbox; this is a button,
     deliberately. A checkbox on a phone is a small target next to a label
     that has to be read to know what was ticked, and it leaves the consent
     ambiguous — the box is checked, but did anyone decide? A button carries
     the sentence it commits to, is a full-width tap target, and produces one
     unambiguous act at a known instant, which is what the record written
     against the order is evidence of. */
  if (g.advisory.length){
    out.push(`<h6 style="margin:var(--space-6) 0 8px">${g.advisory.length} advisory</h6>`);
    out.push(g.advisory.map(f => {
      const a = g.accepted.get(f.lid);
      return pfRow(f, a
        ? `<span class="note">Accepted by ${esc(a.by)} · ${esc(pfWhen(a.at))}${
             a.recorded ? ' · recorded against the order' : ' · on this device only, not yet on the order record'}</span>`
        : `<span class="note"><button class="btn" data-pf-accept="${f.lid}"
             style="margin-top:6px">I accept this and want to continue</button></span>`);
    }).join(''));
  }

  /* Informational is its own tier, not the bottom of the passed list. §6.3
     keeps them apart because they are different claims: a passed check is
     evidence the card prints, while a lead-time note is a consequence of
     what was ordered and gates nothing. Folding one into the other put a row
     with no pass mark under a heading that counted it as passed — the two
     numbers on this screen then disagreed about the same thing, which is
     exactly what Epic D forbids however honestly each was derived. */
  if (g.informational.length){
    out.push(`<h6 style="margin:var(--space-6) 0 8px">${g.informational.length} for information</h6>`);
    out.push(g.informational.map(f => pfRow(f)).join(''));
  }

  if (g.passed.length){
    out.push(`<h6 style="margin:var(--space-6) 0 8px">${g.passed.length} passed</h6>`);
    out.push(g.passed.map(f => pfRow(f)).join(''));
  }

  const list = pfMount('preflight', 'validate');
  if (list) list.innerHTML = out.join('');

  /* The action bar. When a blocking finding is present there is no forward
     action in it at all — not a disabled one, not one that warns first. */
  const panel = pfMount('pfPanel', 'validate');
  if (panel) panel.innerHTML = bottomBar(
    `<span class="micro">${g.blocking.length
        ? 'Blocked — export refused'
        : g.pending.length
          ? `${g.pending.length} advisory finding${g.pending.length > 1 ? 's' : ''} to accept`
          : 'Print-safe'}</span>` +
    `<button class="btn" data-pf-back="1">Back to the card</button>` +
    (g.blocking.length ? '' :
      `<button class="btn btn-primary" data-pf-continue="1" ${g.pending.length ? 'disabled' : ''}
        >Continue to export</button>`));

  $$('[data-pf-accept]').forEach(b => b.onclick = () => pfAccept(design, content, b.dataset.pfAccept));
  $$('[data-pf-continue]').forEach(b => b.onclick = () => { if (preflightGate(design, content).ok) go('export'); });
  $$('[data-pf-back]').forEach(b => b.onclick = () => go('detail'));
  $$('[data-pf-brief]').forEach(b => b.onclick = () => { state.step = 0; go('brief'); });
  $$('[data-pf-fix]').forEach(b => b.onclick = () => {
    const fx = fixes[Number(b.dataset.pfFix)];
    if (fx) fx.apply();
  });

  const front = pfLocal.front, back = pfLocal.back;
  const tr = [...(front?.trace||[]).map(t => ({...t,f:'front'})),
              ...(back?.trace||[]).map(t => ({...t,f:'back'}))];
  const trace = $('#trace');
  if (trace) trace.innerHTML = tr.length
    ? tr.map(t => `<div class="mono">${t.f}/${t.slot} → ${esc(t.applied.join(' → '))}${
        t.note ? ` <span class="note">${esc(t.note)}</span>` : ''}</div>`).join('')
    : '<p class="lede" style="font-size:12.5px">Nothing needed adjusting — the content fits every slot as authored.</p>';

  const spec = $('#spec');
  if (!spec) return;
  if (front && !front.eliminated){
    spec.textContent = JSON.stringify({
      format:front.fmt.id, layoutFront:front.face.id, layoutBack:design.back,
      typeSystem:front.type.id, palette:front.pal.id, density:design.density,
      composed_front: front.elements.filter(e => e.fit).map(e => ({
        slot:e.ref, script:e.fit.script,
        box:{x:+e.geom.x.toFixed(2),y:+e.geom.y.toFixed(2),w:+e.geom.w.toFixed(2),h:+e.geom.h.toFixed(2)},
        type:{size_pt:+e.fit.sizePt.toFixed(2), lines:e.fit.lines.length},
        ladder:e.fit.applied }))
    }, null, 1);
  } else spec.textContent = '// eliminated — no spec produced';
}

/* ── Fixes that are fixes ────────────────────────────────────────────────
   The blocking variant of this screen may only offer actions that resolve
   the finding, so nothing reaches the screen on the strength of its name.
   Every candidate below is applied to a copy of the design and content, the
   pair is re-composed and re-checked, and only the ones that come back with
   zero blocking findings are offered — at most one per kind of change, so
   the user is choosing between approaches rather than reading nine variants
   of "try another layout".

   Design changes go through `applyOps` and the closed operation set for the
   same reason a typed instruction does: an operation can only re-select a
   component, never nudge geometry, so a fix cannot quietly break the
   guarantee it was offered to restore. */
let pfFixCache = { key:null, list:[] };

function pfBlockingCount(design, content){
  try {
    const { front, back } = facesFor(design, content);
    return allFindings(front, back).filter(f => f.s === 'fail').length;
  } catch (err){ return Infinity; }
}

function pfFixPool(design, content){
  const pool = [];
  const add = (group, label, o) => pool.push({ group, label, ...o });

  add('layout', 'Try a layout with more room for the name', { ops:[{op:'promoteSlot', arg:'name'}] });
  for (const L of LAYOUTS.filter(l => l.face === 'front' && l.id !== design.layout))
    add('layout', `Try the ${L.name} layout`, { ops:[{op:'setLayout', arg:L.id}] });

  add('back', 'Move the contact routes to the back', { ops:[{op:'moveSlotToBack', arg:'contact'}],
    note:'The front loses its contact block and a contact back carries the routes.' });
  for (const B of LAYOUTS.filter(l => l.face === 'back' && l.id !== design.back))
    add('back', `Use ${B.name} on the back`, { ops:[{op:'setBack', arg:B.id}] });

  add('density', 'Give every line more room', { ops:[{op:'setDensity', arg:'airy'}] });

  for (const P of PALETTES.filter(p => p.id !== design.palette && p.id !== '__preview'))
    add('palette', `Use ${P.name}`, { ops:[{op:'setPalette', arg:P.id}] });
  for (const T of TYPE_SYSTEMS.filter(t => t.id !== design.type && t.id !== '__preview'))
    add('type', `Set it in ${T.name}`, { ops:[{op:'setTypeSystem', arg:T.id}] });

  for (const F of FORMATS.filter(f => f.id !== design.format))
    add('format', `Switch to ${F.name}`, { ops:[{op:'setFormat', arg:F.id}],
      sync:() => { state.format = F.id; const el = $('#i_format'); if (el) el.value = F.id; } });

  /* Content changes last: they are the only ones that cost the customer
     something they typed, so they are offered only when no arrangement of
     the library can carry the content as written. */
  if (content.quals)
    add('content', 'Drop the qualifications from the front',
      { fields:{ i_quals:'' }, mutate:c => ({ ...c, quals:'' }),
        note:'They stop being printed. No back face in the library carries a Latin qualification line.' });

  const words = String(content.role || '').trim().split(/\s+/).filter(Boolean);
  for (let n = words.length - 1; n >= 1; n--){
    const short = words.slice(0, n).join(' ');
    add('content', `Shorten the role text to “${short}”`,
      { fields:{ i_role:short }, mutate:c => ({ ...c, role:short }) });
  }
  return pool;
}

function pfFixes(design, content){
  const key = pfKey(design, content);
  if (pfFixCache.key === key) return pfFixCache.list;
  const chosen = [], seen = new Set();
  for (const fx of pfFixPool(design, content)){
    if (seen.has(fx.group)) continue;
    const d2 = fx.ops ? applyOps(design, fx.ops).design : design;
    const c2 = fx.mutate ? fx.mutate(content) : content;
    if (pfBlockingCount(d2, c2) !== 0) continue;
    seen.add(fx.group);
    chosen.push({ ...fx, apply(){
      if (fx.ops){
        const { design:nd, changes } = applyOps(design, fx.ops);
        state.history.push({ ...design });
        state.instrLog.push({ ops:fx.ops, matched:[fx.label], changes, unmapped:false });
        state.refine = nd;
      }
      if (fx.fields) for (const id in fx.fields){ const el = $('#' + id); if (el) el.value = fx.fields[id]; }
      if (fx.sync) fx.sync();
      markDirty();
      draw();
    }});
    if (chosen.length >= 3) break;
  }
  pfFixCache = { key, list:chosen };
  return chosen;
}

/* ══════════════════════ CONSTRAINT CONFLICT ══════════════════════
   Wireframing §5.10 calls this the empty state that matters most, and it is
   right: it is the only screen a user reaches by doing nothing wrong. It
   has to say why in their words, and every way out of it has to be a fix
   that is applied and re-run, not a sentence describing one. */

/* Wireframing §5.10 prices a bigger trim at ৳80 per 100 cards. Like every
   other cost constant in this codebase it is an estimate: Master PRD §8.1
   lists real press quotes as a Phase 0 test nobody has run yet, so this
   stays marked unvalidated until someone has walked into Nilkhet with the
   test sheet. It is applied only when the trim genuinely grows, because
   charging for a sideways rotation of the same rectangle would be a lie the
   customer can measure. */
const TRIM_UPCHARGE_PER_100 = 80;

const pfBrief = () => ({
  industry:state.industry, personality:state.personality,
  format:state.format, density:state.density,
  script:(state.script === 'bangla' || state.script === 'bangla-only') ? 'bangla' : 'latin'
});

/* Why nothing survived, taken from what the engine actually recorded. The
   composer writes a reason string into `eliminated` for every candidate it
   throws away and preflight names every blocking finding on the ones that
   survive composition — so the enumeration below is generation run again
   with the causes kept instead of discarded. Reading them beats guessing
   from field lengths, which is what this screen used to do: the longest
   field is very often not the one that eliminated anything. */
function eliminationCauses(brief, content){
  const script = brief.script === 'bangla' ? 'bangla' : null;
  const slots = {}, other = {}, blocked = {};
  let tried = 0, composedOk = 0;
  for (const L of LAYOUTS.filter(l => l.face === 'front')){
    for (const T of TYPE_SYSTEMS){
      for (const P of PALETTES){
        tried++;
        let c;
        try {
          c = composeForced(L.id, content, script,
            { format:brief.format, density:brief.density, type:T.id, palette:P.id });
        } catch (err){ continue; }
        if (c.eliminated){
          const m = /^(\w+) (cannot fit|is required and empty)/.exec(c.eliminated);
          if (m){
            const rec = slots[m[1]] || (slots[m[1]] = { n:0, why:c.eliminated });
            rec.n++;
          } else other[c.eliminated] = (other[c.eliminated] || 0) + 1;
          continue;
        }
        composedOk++;
        for (const f of preflight(c)) if (f.s === 'fail')
          blocked[f.label] = (blocked[f.label] || 0) + 1;
      }
    }
  }
  return { tried, composedOk, slots, other, blocked };
}

/* The slot the engine names, in the words the person who typed it uses. */
function pfSlotPhrase(ref, content){
  if (ref === 'role'){
    const q = String(content.quals || '').split(/[,·]/).map(s => s.trim()).filter(Boolean);
    if (q.length === 2) return 'both qualifications';
    if (q.length > 2)   return `all ${q.length} qualifications`;
    if (q.length === 1) return 'your role and qualification';
    return 'your role';
  }
  return { name:'your name', company:'your company name', contact:'your contact routes',
           qr:'the QR code', mark:'your logo' }[ref] || `your ${ref}`;
}

function conflictReason(causes, content){
  const bySlot = Object.entries(causes.slots).sort((a,b) => b[1].n - a[1].n);
  if (bySlot.length){
    const phrases = bySlot.slice(0,2).map(([ref]) => pfSlotPhrase(ref, content));
    const missing = bySlot.filter(([, v]) => /is required and empty/.test(v.why));
    if (missing.length && missing.length === bySlot.length)
      return `${phrases[0][0].toUpperCase()}${phrases[0].slice(1)} is empty, and every layout needs it.`;
    const subject = phrases.join(' and ');
    const verb = phrases.length > 1 ? "don't" : "doesn't";
    return `${subject[0].toUpperCase()}${subject.slice(1)} ${verb} fit any layout at a legible size.`;
  }
  const blocked = Object.entries(causes.blocked).sort((a,b) => b[1] - a[1])[0];
  if (blocked)
    return `Every layout that fits your content fails preflight — ${blocked[0].toLowerCase()} on ${blocked[1]} of the ${causes.tried} combinations tried.`;
  const other = Object.entries(causes.other).sort((a,b) => b[1] - a[1])[0];
  if (other) return other[0][0].toUpperCase() + other[0].slice(1) + '.';
  return 'No combination in the library composed with this brief.';
}

/* ── The ways out ────────────────────────────────────────────────────────
   Each one is a real change to the brief or the content, probed by running
   generation against the change before it is offered, and applied by the
   same mutation that was probed. The two used to differ here — the screen
   measured "drop the routes from the content" and applied "select a contact
   back", which are not the same change — so a count could be shown for a
   fix that had never been tried. */
let pfDiagCache = { key:null, out:null };

function pfCost(fromId, toId, qty){
  const a = FORMATS.find(f => f.id === fromId), b = FORMATS.find(f => f.id === toId);
  if (!a || !b || b.w * b.h <= a.w * a.h) return { taka:0, label:'No cost' };
  const total = Math.round(TRIM_UPCHARGE_PER_100 * (Number(qty) || 100) / 100);
  return { taka:total, label:`+${taka(TRIM_UPCHARGE_PER_100)} per 100 cards — about ${taka(total)} on your ${qty}` };
}

/* Successively shorter versions of a field, longest first: whole words while
   there are words to drop, then hard character cuts, because a Bangladeshi
   name typed as one unbroken token is exactly the case the fit ladder cannot
   wrap its way out of and the case this screen exists for. */
function pfTruncations(text){
  const out = [];
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  for (let n = words.length - 1; n >= 1; n--) out.push(words.slice(0, n).join(' '));
  for (const frac of [0.7, 0.55, 0.4, 0.28]){
    const t = String(text || '').slice(0, Math.max(4, Math.round(String(text || '').length * frac))).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/* The option that comes straight off the cause: the engine named a slot it
   could not fit, so this offers to shorten that slot's field and nothing
   else. Candidates are screened by composing them — one pass over the front
   layouts, which is a fraction of a generation — and the survivor is then
   verified by `diagnose` running real generation against it, so the count on
   the tile is still a counted result rather than a prediction. */
function pfShortenOption(brief, content, causes){
  const top = Object.entries(causes.slots || {}).sort((a,b) => b[1].n - a[1].n)[0];
  if (!top) return null;
  const field = { name:'i_name', role:'i_role', company:'i_company' }[top[0]];
  const key   = { name:'name',   role:'role',   company:'company'   }[top[0]];
  if (!field || !String(content[key] || '').trim()) return null;

  const script = brief.script === 'bangla' ? 'bangla' : null;
  const over = { format:brief.format, density:brief.density };
  const composes = c => LAYOUTS.filter(l => l.face === 'front').some(L => {
    try { return !composeForced(L.id, c, script, over).eliminated; } catch (err){ return false; }
  });
  for (const short of pfTruncations(content[key])){
    const c2 = { ...content, [key]:short };
    if (!composes(c2)) continue;
    return { id:'content.' + key, group:'shorten',
      label:`Shorten ${pfSlotPhrase(top[0], content)}`,
      note:`The engine names this field in every elimination it recorded: ${top[1].why}. Set to “${short}”, it composes.`,
      cta:`Use “${short}”`, cost:{ taka:0, label:'No cost' },
      consequence:'The rest of that field stops being printed.',
      mutate:c => ({ ...c, [key]:short }),
      apply(){ const el = $('#' + field); if (el) el.value = short; } };
  }
  return null;
}

function pfResolutionPool(content, causes){
  const brief = pfBrief();
  const out = [];

  for (const F of FORMATS.filter(f => f.id !== brief.format)){
    const cost = pfCost(brief.format, F.id, state.qty);
    /* A free trim change and a trim change that costs money are two
       different offers to a customer and both belong on the screen; a
       second free trim is the same offer twice, so they share a group. */
    out.push({ id:'format.' + F.id, group:cost.taka ? 'trim.paid' : 'trim.free',
      label:`Switch to ${F.name}`,
      note:F.orientation === 'portrait'
        ? 'A portrait card gives the name a full-width line instead of sharing it with the contact block.'
        : 'A different trim changes every slot box, which is usually enough on its own.',
      cta:`Use ${F.name.split(' — ')[1] || F.name}`,
      cost, consequence:cost.taka ? 'A larger trim is a bigger sheet area.' : 'Nothing else changes.',
      brief:{ format:F.id },
      apply(){ state.format = F.id; const el = $('#i_format'); if (el) el.value = F.id; } });
  }

  if (brief.density !== 'airy')
    out.push({ id:'density.airy', group:'density', label:'Set every line more openly',
      note:'The composer works from a smaller starting size, which gives the fit ladder more room before it hits the floor.',
      cta:'Use the airy density', cost:{ taka:0, label:'No cost' },
      consequence:'Type sits slightly smaller on the card.',
      brief:{ density:'airy' },
      apply(){ state.density = 'airy'; const el = $('#i_density'); if (el) el.value = 'airy'; } });

  /* Script is a real lever in both directions and it costs nothing either
     way: Bangla clusters are wider than Latin at the same point size, but a
     Bangla name is often far shorter in words than its transliteration. */
  if (brief.script === 'bangla')
    out.push({ id:'script.latin', group:'script', label:'Set the front in English',
      note:'Bangla clusters are wider than Latin at the same point size, and the Bangla face on the back still carries the name.',
      cta:'English front, Bangla back', cost:{ taka:0, label:'No cost' },
      consequence:'The front reads in English; nothing is lost from the card.',
      brief:{ script:'latin' },
      apply(){ state.script = 'latin'; const el = $('#i_script'); if (el) el.value = 'latin'; } });
  else if (content.bname)
    out.push({ id:'script.bangla', group:'script', label:'Set the front in Bangla',
      note:'You have already typed the Bangla name, and it is shorter here than the English one the composer cannot fit.',
      cta:'Bangla front', cost:{ taka:0, label:'No cost' },
      consequence:'The front reads in Bangla; the English side moves to the back.',
      brief:{ script:'bangla' },
      apply(){ state.script = 'bangla'; const el = $('#i_script'); if (el) el.value = 'bangla'; } });

  if (content.quals)
    out.push({ id:'content.quals', group:'quals', label:'Take the qualifications off the card',
      note:'Qualifications ride in the role line, so they are what puts that slot over its floor.',
      cta:'Drop the qualifications', cost:{ taka:0, label:'No cost' },
      consequence:'They stop being printed — no back face in the library carries a Latin qualification line.',
      mutate:c => ({ ...c, quals:'' }),
      apply(){ const el = $('#i_quals'); if (el) el.value = ''; } });

  if (content.p2 || content.web || content.addr)
    out.push({ id:'content.routes', group:'routes', label:'Print fewer contact routes',
      note:'Four routes on the front leaves no room for the name.',
      cta:'Keep one number and the email', cost:{ taka:0, label:'No cost' },
      consequence:'The second number, website and address stop being printed on both faces.',
      mutate:c => ({ ...c, p2:'', web:'', addr:'' }),
      apply(){ for (const id of ['i_p2','i_web','i_addr']){ const el = $('#' + id); if (el) el.value = ''; } } });

  const shorten = pfShortenOption(brief, content, causes || { slots:{} });
  if (shorten) out.push(shorten);

  const words = String(content.role || '').trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && (!shorten || shorten.id !== 'content.role')){
    const short = words.slice(0, Math.max(1, words.length - 1)).join(' ');
    out.push({ id:'content.role', group:'role', label:'Shorten the role text',
      note:`The longest field is what eliminates most layouts. This sets it to “${short}”.`,
      cta:`Use “${short}”`, cost:{ taka:0, label:'No cost' },
      consequence:'The rest of the role line stops being printed.',
      mutate:c => ({ ...c, role:short }),
      apply(){ const el = $('#i_role'); if (el) el.value = short; } });
  }

  /* Free before paid, and a change to the card's geometry before a change
     to what the customer wrote. */
  return out.sort((a,b) => (a.cost.taka - b.cost.taka) ||
    ((a.mutate ? 1 : 0) - (b.mutate ? 1 : 0)));
}

/** Why nothing fits, and the ranked ways out. The only caller is
 *  `drawNoResults`, which is why this returns the reason alongside the
 *  options rather than making the screen derive it a second time. */
function diagnose(content){
  const brief = pfBrief();
  const key = specHash({ brief, content, qty:state.qty });
  if (pfDiagCache.key === key) return pfDiagCache.out;

  const causes = eliminationCauses(brief, content);
  const options = [], filled = new Set();
  for (const o of pfResolutionPool(content, causes)){
    /* One offer per kind of change. Three ways to reach the same outcome is
       one resolution presented three times, and it pushes the genuinely
       different approach off the bottom of the screen. */
    if (filled.has(o.group)) continue;
    let restores = 0;
    try {
      restores = generate({ ...brief, ...(o.brief || {}) },
        o.mutate ? o.mutate(content) : content, { n:6 }).picked.length;
    } catch (err){ restores = 0; }
    if (!restores) continue;
    filled.add(o.group);
    options.push({ ...o, restores });
    if (options.length >= 3) break;
  }
  const out = { reason:conflictReason(causes, content), causes, options };
  pfDiagCache = { key, out };
  return out;
}

function drawNoResults(content){
  const { reason, causes, options } = diagnose(content);
  const fmt = FORMATS.find(f => f.id === state.format) || FORMATS[0];

  const worst = Object.entries(causes.slots).sort((a,b) => b[1].n - a[1].n)[0];
  const conflict = pfMount('conflict', 'noresults');
  /* The reason leads, in the words of the person who typed the content, and
     the two constraints sit under it as the evidence for it. It rides in
     this container rather than one of its own so it stays at the top of the
     screen whatever the markup around it does. */
  if (conflict) conflict.innerHTML =
    `<p class="lede" style="grid-column:1/-1;font-size:15px;color:var(--color-text)">${esc(reason)}</p>` +
    [['Constraint A', fmt.name,
      `Chosen in step 05. Every slot must sit inside the ${fmt.safe} mm safe area at this trim.`],
     ['Constraint B', 'The content you entered',
      worst ? `${worst[1].why} — on ${worst[1].n} of the ${causes.tried} combinations tried.`
            : `All ${causes.tried} combinations composed; ${
                Object.keys(causes.blocked).length ? 'each one then failed preflight.' : 'none scored.'}`]
    ].map(([k,t,n]) => `<div class="stack" style="gap:6px"><h6 style="color:var(--color-accent)">${k}</h6>
      <b>${esc(t)}</b><span class="lede" style="font-size:13px;margin:0">${esc(n)}</span></div>`).join('');

  const res = pfMount('resolutions', 'noresults');
  if (res) res.innerHTML = options.length
    ? options.map((o,i) =>
      `<button class="tile" role="button" tabindex="0" aria-pressed="false" data-fix="${i}">
        <span class="tiletitle">${i+1}. ${esc(o.label)}</span>
        <span class="tilemeta">${esc(o.note)}</span>
        <span class="tilemeta">${esc(o.consequence)}</span>
        <span class="pill ${o.cost.taka ? 'pill-warn' : 'pill-ok'}">${esc(o.cost.label)}</span>
        <span class="pill pill-ok">${o.restores} concept${o.restores > 1 ? 's' : ''} return</span>
        <span class="btn" style="pointer-events:none;align-self:flex-start">${esc(o.cta)}</span>
      </button>`).join('')
    : `<p class="lede">${esc(reason)} Nothing in the library composes around it at any trim, density or
         script, so this one goes back to the brief — every automatic way out was tried and none of them
         worked, and offering one anyway would waste the trip.</p>`;

  bindTiles('#resolutions .tile', t => { options[Number(t.dataset.fix)].apply(); runGenerate(); });

  const panel = pfMount('pfNoResBar', 'noresults');
  if (panel) panel.innerHTML = bottomBar(
    `<span class="micro">${options.length} way${options.length === 1 ? '' : 's'} forward</span>
     <button class="btn" data-pf-brief2="1">Back to the brief</button>`);
  $$('[data-pf-brief2]').forEach(b => b.onclick = () => { state.step = 0; go('brief'); });
}

/* ── ORDER ───────────────────────────────────────────────────────────────── */
