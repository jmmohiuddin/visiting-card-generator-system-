/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — export, order, tracking and dashboard
   --------------------------------------------------------------------------
   Everything downstream of a passing preflight: files, money and fulfilment.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.

   Two rules run through every function below, and they are the reason this
   file is written defensively rather than optimistically. Nothing is charged
   before the customer has approved a physical proof, and no design carrying a
   blocking preflight finding may reach Export or Order at all (Wireframing
   §3). Where a capability genuinely does not exist yet — the PDF/X-4 writer,
   the payment providers, real press quotes — the screen says so in words
   rather than offering a control that cannot do what it appears to do.
   ══════════════════════════════════════════════════════════════════════ */

/* ── The markup this file owns ─────────────────────────────────────────────
   index.html belongs to the shell rebuild, so anything invented here is
   rendered from here. `slot` returns an existing container when the markup
   already provides one and otherwise creates it inside the screen, which
   keeps this file working whether or not the shell has been restructured
   underneath it. Everything writes through `paint`/`on` so a container that
   has gone missing degrades to nothing rather than throwing mid-draw and
   taking the whole screen down with it. */
const FULFIL = {
  paint(sel, html){ const el = $(sel); if (el) el.innerHTML = html; return el; },
  text(sel, s){ const el = $(sel); if (el) el.textContent = s; return el; },
  on(sel, fn){ const el = $(sel); if (el) el.onclick = fn; return el; },
  enable(sel, yes){ const el = $(sel); if (el) el.disabled = !yes; return el; },
  slot(screen, id, cls){
    const found = $('#' + id);
    if (found) return found;
    const host = $(`[data-screen="${screen}"]`);
    if (!host || typeof host.appendChild !== 'function') return null;
    const d = document.createElement('div');
    d.id = id; if (cls) d.className = cls;
    host.appendChild(d);
    return d;
  }
};

/* ── Sibling services ──────────────────────────────────────────────────────
   The print writer, the quote table, the payment providers and accounts are
   each a separate function being built alongside this screen. A build that
   does not have one yet must say so rather than fail obscurely at the moment
   a customer presses a button, so availability is established before the
   screen makes a claim about it. A missing function 404s, since netlify.toml
   carries no catch-all redirect that would swallow the distinction.

   Every request below is one the endpoint was built to answer. An earlier
   version poked all four with a bare GET, which is a question two of them
   have no answer to: `/api/quotes` is POST-only and said 405, and a bare GET
   to `/api/payments` wants an order reference and said 400. Both were logged
   as console errors on a normal, healthy page load — and error monitoring
   that everyone has learned to ignore is worse than none. So there is no
   generic probe. `/api/render-print` answers a GET with a capability
   document, `/api/payments?methods=1` answers with its live provider list,
   and the two that have no such question are not asked one: the first real
   call to `/api/quotes` and `/api/auth` reports its own absence, which both
   already handle honestly. */
const ENDPOINT = { print:'/api/render-print', quotes:'/api/quotes',
                   payments:'/api/payments', auth:'/api/auth', orders:'/api/orders',
                   entitlements:'/api/entitlements' };
const _endpointState = {};   // path → 'present' | 'absent'
const _probing = new Set();

function endpointStatus(path){ return _endpointState[path] || 'unknown'; }

/** Record what a real response told us about whether a service is deployed.
 *  404 is the only status that means "not on this build"; 405 and 501 mean
 *  the path is not the service we want, which for our purposes is the same
 *  answer. Every other status proves it is there. */
function noteEndpoint(path, status){
  _endpointState[path] = (status === 404 || status === 405 || status === 501) ? 'absent' : 'present';
  return _endpointState[path];
}

/** Ask a service a question it is built to answer, once, then redraw so the
 *  screen can stop guessing. Offline is left as 'unknown' deliberately — a
 *  missing network is not a missing service. */
function ensureEndpoint(path, ask){
  if (_endpointState[path] || _probing.has(path) || isOffline()) return;
  _probing.add(path);
  fetch(ask || path, { method:'GET', headers:{ accept:'application/json' } })
    .then(r => {
      noteEndpoint(path, r.status);
      /* The payment probe is not only a probe: it answers with the providers
         this deploy actually has and whether each is running against a real
         gateway or a sandbox, which is the difference between a captured
         payment and a rehearsal of one. */
      if (path === ENDPOINT.payments && r.ok)
        return r.json().then(j => { if (Array.isArray(j.methods) && j.methods.length) state.payMethods = j.methods; })
                       .catch(() => {});
    })
    .catch(() => { /* leave unknown; a network failure is not an answer */ })
    .then(() => { _probing.delete(path); draw(); });
}
const askPayments = () => ensureEndpoint(ENDPOINT.payments, ENDPOINT.payments + '?methods=1');

/** Is *this* call in flight — not "is anything, anywhere".
 *
 *  `net.pending` is one shared set across every screen, so the shell's
 *  `isPending()` is true whenever any request is open: a preflight report, a
 *  quote refresh, a dashboard load. Disabling Approve & pay on that answer
 *  greys out the customer's primary action because an unrelated background
 *  call has not come back yet, with nothing on screen to explain why — and if
 *  that call hangs, the button never returns. The key shape is the shell's,
 *  so this asks the same set a narrower question. */
const busy = (path, method = 'POST') => net.pending.has('net:' + path + ':' + method);

/** `api()` parses JSON, and a print file is bytes. This is the same call —
 *  same pending set, same offline rule, same Idempotency-Key so a retried
 *  render cannot bill twice against a metered writer — resolving to a Blob. */
async function apiBlob(path, body, extraHeaders){
  const key = 'net:' + path + ':POST';
  net.pending.add(key); net.lastError = null;
  try {
    if (isOffline()){
      const e = new Error('You are offline. The print file is built on the server.');
      e.code = 'offline'; e.remediation = 'Reconnect and try again.'; throw e;
    }
    const res = await fetch(path, {
      method:'POST',
      /* The session travels as a bearer header rather than a cookie, so it has
         to be attached deliberately — and the print writer now asks who is
         requesting the file, because the file is a paid line (PRD §9). A
         request with no identity on it is an anonymous one, which is a real
         answer and not an error: the server refuses it with a price. */
      headers:{ 'content-type':'application/json',
                ...(extraHeaders || {}),
                'idempotency-key':'idem-' + specHash({ p:path, b:body || null, o:ownerKey(), n:idemNonce() }) },
      body: JSON.stringify(body || {})
    });
    if (!res.ok){
      const env = (await res.json().catch(() => ({}))).error || {};
      const e = new Error(env.message || (res.status === 404
        ? 'The print-file service is not part of this build yet.'
        : 'The print file could not be built.'));
      e.code = env.code || ('http_' + res.status);
      /* `remediation` may be a token, and `remediationText` is the sentence
         the endpoint sent alongside it for tokens the shell's table does not
         know yet. Dropping the second here is what would make an unrecognised
         token render as nothing — silent, and in the reassuring direction. */
      e.remediation = env.remediation || 'Try again, or export the geometry documents below.';
      e.remediationText = env.remediationText;
      if (res.status === 404) _endpointState[path] = 'absent';
      throw e;
    }
    _endpointState[path] = 'present';
    return await res.blob();
  } catch (err){
    net.lastError = { code: err.code || 'network', message: err.message,
                      remediation: err.remediation || 'Check your connection and try again.',
                      remediationText: err.remediationText };
    throw err;
  } finally { net.pending.delete(key); }
}

/* ══════════════════════════ THE GATE ══════════════════════════
   Wireframing §3 states the rule once so every downstream screen can be
   checked against it. This is that check, in one place, so Export and Order
   cannot drift apart on what "blocked" means. An advisory finding is not a
   block — it is a judgement the customer is allowed to make — but a failing
   check is, and no control on either screen may work around it. */
function exportGate(design, content){
  /* The faces are still composed here because the export screen needs the
     actual documents to hand a customer, not merely a verdict on them. */
  const { front, back } = facesFor(design, content);
  const composed = !!(front && !front.eliminated);
  const why = [];

  /* The verdict itself belongs to `preflightGate` in ui-validate.js wherever
     that exists. It prefers the server's preflight report over the browser's
     and it holds the record of which advisories were accepted, neither of
     which this file can see — and two screens deriving a second opinion from
     the same findings is exactly the drift these gates exist to prevent. What
     follows below is the fallback for a build without it, not a rival answer.

     `allowed` and `ready` are deliberately different questions. A blocking
     finding is arithmetic about the printed sheet and closes the door. An
     unaccepted advisory does not: it is a judgement the customer is entitled
     to make (PRD Epic D), and what it withholds is proceeding *before* they
     have made it. Collapsing the two would tell someone their card cannot be
     printed when the truth is that nobody has ticked a box yet. */
  if (typeof preflightGate === 'function'){
    const g = preflightGate(design, content);
    if (g.error) why.push(g.error.message);
    if (g.blocking.length)
      why.push(`${g.blocking.length} blocking finding${g.blocking.length === 1 ? '' : 's'} must be fixed first.`);
    if (g.pending.length)
      why.push(`${g.pending.length} advisory finding${g.pending.length === 1 ? '' : 's'} ${
        g.pending.length === 1 ? 'has' : 'have'} not been accepted yet.`);
    return { front, back, findings: g.findings, blocking: g.blocking, pending: g.pending,
             allowed: !g.error && g.blocking.length === 0, ready: !!g.ok,
             source:'preflight', reason: why.join(' ') };
  }

  const findings = allFindings(front, back);
  const blocking = findings.filter(f => f.s === 'fail');
  /* Both refusals can be true at once — an over-long name eliminates the
     layout and takes a required field off the card with it — so the reason
     names every cause rather than the first one found. A customer told only
     "no layout survived" would go looking for a different layout. */
  if (blocking.length)
    why.push(`${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} must be fixed first.`);
  if (!composed)
    why.push('No layout survived composition at this trim and content length.');
  const allowed = composed && blocking.length === 0;
  return { front, back, findings, blocking, pending: [],
           allowed, ready: allowed, source:'local', reason: why.join(' ') };
}

/* ══════════════════════════ THE PAID GATE ══════════════════════════
   The gate above decides whether a design *can* be printed. This one decides
   whether it has been paid for, and they are deliberately separate questions
   asked in that order — telling someone their card cannot be printed when the
   truth is that they have not bought the file is the same category of lie as
   the reverse, and it would send them back to Validate to fix nothing.

   Master PRD §9's free tier is unlimited briefs, six concepts, watermarked
   previews, no export and no order. Everything before this screen stays free
   and has no clock on it: the brief, generation, refinement, and the whole
   preflight report. §9's pricing principle is to charge at the moment of
   realised value and never for access to the tool, and §3.2's Farhana has to
   reach a watermarked preview she can screenshot and post without signing up
   at all. Nothing here asks her to.

   What this screen does is name the price before offering a control that
   would refuse. It is not what protects the file. That is `assertEntitled` in
   lib/entitlements.mjs, called from `/api/render-print` and `/api/orders`,
   which are owned by other subgroups and are where the two-line call belongs —
   a gate that lives only in a browser is a gate that a browser can skip, which
   is the same argument `lib/preflight-gate.mjs` makes for its own existence.

   What a customer buys is one design's file, so there is nothing to ask about
   until the design has been saved and has a short code — an entitlement is
   keyed on the design's content hash, and only the server can resolve a code
   to one. An unsaved design is free-tier without a round trip. */
const FILE_PACK = { amount:199, currency:'BDT', label:'File pack' };

const FREE_TIER = { code:null, tier:'free', checked:false, watermark:true,
                    may:{ export:false, order:false }, price:FILE_PACK };

/** What this browser holds for the design on screen. */
function entitlementView(){
  const e = state.ent;
  if (!state.shareCode || !e || e.code !== state.shareCode) return { ...FREE_TIER };
  return e;
}

/** Ask once per saved design, the same shape as `ensureServerQuote`: the
 *  request key is recorded before the call goes out, because `api()` redraws
 *  in its `finally` and would otherwise re-enter this from the draw it caused.
 *
 *  Failing closed is deliberate. A build whose entitlements endpoint is
 *  missing behaves as the free tier, because that is what the server will do
 *  at the moment the file is asked for — a screen that offered the download
 *  anyway would be promising something `/api/render-print` is about to
 *  refuse, which is the one failure mode this whole file is written against. */
function ensureEntitlement(){
  const code = state.shareCode;
  if (!code || state.entKey === code || isOffline()) return;
  state.entKey = code;
  api(ENDPOINT.entitlements + '?code=' + encodeURIComponent(code)
      + '&owner=' + encodeURIComponent(ownerKey()),
      { quiet:true, headers: typeof authHeaders === 'function' ? authHeaders() : {} })
    .then(j => {
      _endpointState[ENDPOINT.entitlements] = 'present';
      state.ent = { code, tier: j.tier || 'free', checked:true,
                    may: j.may || { export:false, order:false },
                    watermark: j.watermark !== false,
                    price: j.filePack || FILE_PACK };
      state.entError = null;
    })
    .catch(err => {
      if (/^http_(404|405|501)$/.test(err.code || ''))
        _endpointState[ENDPOINT.entitlements] = 'absent';
      state.ent = { ...FREE_TIER, code, checked:true };
      /* A deploy that cannot read purchases must say so rather than let a
         customer who has paid read "buy the file pack" — the two are
         different sentences and only one of them is honest. */
      state.entError = { code: err.code, message: err.message,
                         remediation: err.remediation, remediationText: err.remediationText };
    })
    .then(draw);
}

/** The purchase panel. It stands where the files or the checkout would be, so
 *  the customer meets the price at the moment they wanted the thing rather
 *  than at the moment a button failed. It offers no Pay button yet: bKash and
 *  Nagad capture against an order reference (`lib/payments`), and a file-pack
 *  purchase has no order to capture against until that line is wired. Saying
 *  that plainly is the house rule — where a capability does not exist, the
 *  screen says so rather than offering a control that cannot do what it
 *  appears to. */
function filePackBlock(ent, action){
  if (state.entError)
    return errorBlock(state.entError, t('retry'))
      + `<p class="lede" style="font-size:12.5px">This is a gap on our side, not something you can work
         around. Nothing you have designed is affected.</p>`;
  const price = ent.price || FILE_PACK;
  return `<span class="pill pill-warn">${ICON.review} ${
      action === 'order' ? 'Ordering needs the file pack' : 'The print file is the file pack'} — ${taka(price.amount)}</span>
    <p class="lede" style="font-size:12.5px">${action === 'order'
      ? 'A print run sends this exact file to a press, so the file pack is what an order is made of. It is credited against the print price, so you never pay for it twice.'
      : 'One payment, for this design, with no subscription and no clock on it. It releases the print-ready PDF/X-4 and a separation plate for every foil and spot-UV finish you chose, and it takes the watermark off the preview.'}</p>
    <p class="lede" style="font-size:12.5px">Everything you have done so far stays free and stays yours:
      unlimited briefs, all six concepts, every refinement, and the whole preflight report. Master PRD §9 —
      we charge when something real is handed over, never for reaching the tool. The preview above is
      watermarked, not restricted; screenshot it and post it.</p>
    <p class="lede" style="font-size:12px;color:var(--color-accent)">Payment for a file pack is not wired up on
      this build. bKash and Nagad capture against an order reference, and this line has none yet, so nothing
      here pretends to take money.</p>`;
}

/* ══════════════════════════ MONEY ══════════════════════════
   The engine's `quote()` returns what the job costs us, line by line, plus a
   single marked-up retail figure. A customer must never be shown a lump sum
   (PRD Epic F), so the retail figure is redistributed back over the same
   lines here: printing and each finish carry the margin proportionally and
   the last of them absorbs the rounding, which is what makes the printed
   lines add up to the printed total exactly rather than nearly.

   Delivery is deliberately excluded from that redistribution and passes
   through at the courier's own cost. PRD Epic F asks for delivery shown
   itemised and never absorbed silently; a marked-up delivery line would be
   itemised and still not be the delivery cost. */
function spreadToTotal(costLines, total, passthrough){
  const pass = passthrough.filter(l => l.cost != null);
  const unpriced = passthrough.filter(l => l.cost == null);
  const passSum = pass.reduce((s, l) => s + l.cost, 0);
  const work = costLines.filter(l => l.cost != null && !/^Delivery/i.test(l.label || ''));
  const workCost = work.reduce((s, l) => s + l.cost, 0) || 1;
  const target = total - passSum;
  const lines = [];
  let run = 0;
  work.forEach((l, i) => {
    const share = i === work.length - 1 ? target - run : Math.round(target * (l.cost / workCost));
    run += share;
    lines.push({ label: l.label, cost: share });
  });
  return lines.concat(pass, unpriced);
}

function customerLines(qty, finishes, zone, mult = 1){
  const q = quote(Number(qty), finishes, zone);
  const del = DELIVERY[zone] ?? DELIVERY.dhaka;
  const total = Math.round(q.retail * mult);
  const lines = spreadToTotal(q.lines, total, [{ delivery:true, cost: del,
    label: `Delivery — ${zone === 'dhaka' ? 'inside Dhaka, Pathao / Steadfast / RedX'
                                          : 'outside Dhaka, courier partner'}` }]);
  return { lines, total, unit: +(total / Number(qty)).toFixed(2), cost: q.pressCost };
}

/* A quote option from the server carries the engine's *cost* itemisation plus
   the press's plate charge, while `price` is the marked-up figure the customer
   pays — so the two do not add up until the margin is spread back over them,
   exactly as it is for the client model above. Plate setup joins delivery as a
   pass-through: the server adds it on top of the marked-up price rather than
   inside it, so marking it up here would invent money. A plate charge that has
   never been quoted arrives with a null cost and stays null all the way to the
   screen, because "not quoted" and "free" are different answers. */
function optionLines(opt){
  const del = opt.delivery && opt.delivery.cost != null
    ? { delivery:true, cost: opt.delivery.cost, label: opt.delivery.label || 'Delivery' }
    : null;
  const pass = [];
  if (del) pass.push(del);
  for (const l of opt.lines || [])
    if (/^Plate\/block setup/i.test(l.label || '')) pass.push({ ...l, passthrough:true });
  const cost = (opt.lines || []).filter(l => !/^Plate\/block setup/i.test(l.label || ''));
  return { lines: spreadToTotal(cost, opt.price, pass), total: opt.price,
           unit: opt.unit ?? +(opt.price / Number(state.qty)).toFixed(2), cost: null };
}

/* The disclaimer is not decoration. PRD §2.2 and §8.1 record that no Dhaka
   press has quoted yet, so every number on this screen is a model output.
   A server-computed price is better sourced but rests on the same
   unvalidated constants, so it is labelled too — just differently. */
const QUOTE_NOTE = {
  client: 'Estimate — computed on this device from placeholder costs. No Dhaka press has quoted these finishes yet (PRD §8.1), so treat it as a range, not a price. An order is priced by the server against a real quote, not by this number.',
  server: 'Indicative — priced from the press table on the server. The underlying costs are still the unvalidated placeholders of PRD §8.1 and are not a committed price.'
};

/** What the screen should show right now: the chosen server option when A4's
 *  endpoint has answered, and the client cost model as a preview otherwise.
 *  The server states in `costBasis.warning` whether its own numbers rest on
 *  placeholder constants, and that sentence is preferred over ours verbatim —
 *  it is the authority on where its price came from, and paraphrasing it would
 *  let the two drift apart. */
function quoteView(){
  const p = currentPress();
  const q = state.quote;
  const opt = q && q.option;
  if (opt && Array.isArray(opt.lines) && opt.lines.length){
    const v = optionLines(opt);
    const unvalidated = opt.unvalidatedCosts !== false;
    return { ...v, source:'server', estimate: unvalidated,
             note: (q.costBasis && q.costBasis.warning) || QUOTE_NOTE.server,
             basis: opt.priceBasis, press: opt.name, lead: opt.leadTime,
             verified: !!opt.pressVerified, quoteId: q.quoteId,
             expiresInSeconds: q.expiresInSeconds };
  }
  const c = customerLines(state.qty, state.finishes, state.zone, p ? p.mult : 1);
  return { ...c, source:'client', estimate:true, note: QUOTE_NOTE.client,
           press: p && p.name, lead: p && p.lead };
}

/** Ask A4 for real press options once per distinct quote request. `api()`
 *  redraws in its `finally`, which would re-enter this from the draw it
 *  triggered, so the request key is recorded before the call goes out. */
function ensureServerQuote(){
  /* No probe. A quote is a POST, so the only honest question to ask this
     endpoint is the real one — and it already reports its own absence below.
     Poking it with a GET first bought nothing and cost a 405 in the console
     on every visit to this screen. */
  const key = [state.shareCode, state.qty, state.finishes.join('+'), state.zone].join('|');
  if (state.quoteKey === key || endpointStatus(ENDPOINT.quotes) === 'absent' || isOffline()) return;
  state.quoteKey = key;
  api(ENDPOINT.quotes, { method:'POST', quiet:true,
    body:{ shortCode: state.shareCode, qty: Number(state.qty),
           finishes: state.finishes, zone: state.zone } })
    .then(j => {
      const options = Array.isArray(j.options) ? j.options : [];
      _endpointState[ENDPOINT.quotes] = 'present';
      state.quote = { ...j, options,
        option: options.find(o => o.slug === state.press || o.name === state.press) || options[0] || null };
      state.quoteError = null;
      if (state.quote.option) state.press = state.quote.option.slug;
    })
    .catch(err => {
      /* A path that answers "not here" or "not this verb" is not the quote
         service, whichever of the two it says, and asking it again on every
         press change would only produce the same answer more often. */
      if (/^http_(404|405|501)$/.test(err.code || '') || err.code === 'not_found')
        _endpointState[ENDPOINT.quotes] = 'absent';
      state.quote = null;
      /* A refusal to price is information the customer needs — a finish no
         active press can produce comes back here, with the remediation that
         says which one and what to do about it. */
      state.quoteError = { code: err.code, message: err.message,
                           remediation: err.remediation, remediationText: err.remediationText };
    })
    .then(draw);
}

function quoteBlock(v, gate){
  if (gate && !gate.ready)
    return `<p class="lede" style="font-size:12.5px">${gate.blocking.length
      ? 'No price is shown while a blocking finding stands. A quote for a file that cannot be printed is not information.'
      : 'No price is shown until the advisory findings have been read and accepted. Pricing a run the customer has not agreed to would be putting the number before the decision.'}</p>`;
  if (state.quoteError)
    return errorBlock(state.quoteError, t('retry'))
      + `<p class="lede" style="font-size:12.5px">Nothing is priced until a press that can actually
         produce this specification has said what it charges.</p>`;
  return v.lines.map(l =>
    `<div class="check"><span style="flex:1">${esc(l.label)}${
      l.delivery ? '<span class="note">Shown separately at the courier\'s cost, never folded into the card price.</span>'
      : l.passthrough ? '<span class="note">Charged by the press at cost, not marked up.</span>' : ''
    }</span><span class="scorenum">${l.cost == null ? 'not quoted' : taka(l.cost)}</span></div>`).join('')
    + `<div class="check" style="border-bottom:0"><span style="flex:1"><b>Total</b>
        <span class="note">${taka(v.unit ?? +(v.total / Number(state.qty)).toFixed(2))} per card${
          v.press ? ' · ' + esc(v.press) : ''}</span></span>
       <span class="scorenum" style="font-size:14px"><b>${taka(v.total)}</b></span></div>
       <p class="pill ${v.estimate ? 'pill-warn' : 'pill-ok'}" style="margin-top:8px">${
         v.estimate ? ICON.review : ICON.pass} ${
         v.source === 'client' ? 'Estimate — not a committed price'
         : v.estimate ? 'Indicative — not a committed price' : 'Priced from a written press quote'}</p>
       <p class="lede" style="font-size:12px">${esc(v.note)}${
         v.basis ? ` <span class="mono">${esc(v.basis)}</span>` : ''}</p>`;
}

/* ══════════════════════════ EXPORT ══════════════════════════ */
function drawExport(design, content){
  const gate = exportGate(design, content);
  const { front, back } = gate;
  ensureEndpoint(ENDPOINT.print);

  /* "Clean" has to mean clean. Saying so on the strength of zero blocking
     findings, while an advisory sits unaccepted, would be the screen telling
     a customer they are through a gate that is still shut. */
  FULFIL.text('#exportMeta', gate.ready ? 'Preflight clean'
    : gate.blocking.length
      ? `${gate.blocking.length} blocking finding${gate.blocking.length === 1 ? '' : 's'} — export refused`
      : `${gate.pending.length} advisory finding${gate.pending.length === 1 ? '' : 's'} awaiting acceptance`);

  ensureEntitlement();
  const ent = entitlementView();

  /* Three states, not two, and the order they are asked in is the point. A
     blocking finding is arithmetic about the printed sheet and comes first,
     because no payment fixes it. Only once the design is printable does the
     question of whether it has been bought arise.

     The geometry documents are gated with the PDF rather than beside it.
     `card_front_print.svg` carries the trim, the 3 mm bleed, the trim marks
     and a 100% K separation per special — it is a press file in everything
     but its container, and releasing it while withholding the PDF would be a
     free tier with a side door. PRD §9 says no export; this is what that
     means. */
  if (gate.ready && !ent.may.export){
    FULFIL.paint('#exports', filePackBlock(ent, 'export'));
    bindRetry(() => { state.entKey = null; state.entError = null; ensureEntitlement(); });
  } else if (gate.ready){
    const files = [['card_front_print.svg', printDocSVG(front)],
                   ['card_back_print.svg',  printDocSVG(back)]];
    if (state.finishes.includes('foil')){
      const s = separationSVG(front, 'Gold foil'); if (s) files.push([`foil_gold.svg — ${s.areaPct}% plate`, s.svg]);
    }
    if (state.finishes.includes('spotuv')){
      const s = separationSVG(front, 'Spot UV'); if (s) files.push([`spot_uv.svg — ${s.areaPct}% plate`, s.svg]);
    }
    FULFIL.paint('#exports', files.filter(f => f[1]).map(([n, x]) =>
      `<a class="chip" download="${n.split(' ')[0]}"
        href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(x)}">${ICON.down} ${esc(n)}</a>`).join(''));
  } else {
    FULFIL.paint('#exports', `<span class="pill pill-warn">${ICON.review} ${
      gate.blocking.length ? 'Export blocked' : 'Export not released yet'} — ${esc(gate.reason)}</span>`
      + `<p class="lede" style="font-size:12.5px">${gate.blocking.length
        ? 'Go back to Validate, fix the finding, and this list returns. A blocking finding is arithmetic about the printed sheet, not a warning to click past.'
        : 'Go back to Validate and accept each advisory. They are judgements for you to make, not faults — but the file is not released until you have made them.'}</p>`
      + `<button class="btn" data-tovalidate="1">Open Preflight</button>`);
    FULFIL.on('#exports [data-tovalidate]', () => go('validate'));
  }

  drawPrintFile(gate, ent);
  FULFIL.paint('#quote', quoteBlock(quoteView(), gate));
  ensureServerQuote();

  /* Order is a downstream screen, so the door to it is closed here as well as
     inside `drawOrder`. Two locks, because the route can also be reached by
     restoring a session straight onto the order screen.

     Whether the file has been bought is deliberately *not* one of the two
     locks. The checkout is where the price is met and paid, so refusing to
     open the screen that sells the thing would leave nowhere to buy it; the
     order screen states the refusal and disables the button that would place
     the order, which is where the money actually is. */
  FULFIL.enable('#b_toorder', gate.ready);
  FULFIL.on('#b_toorder', () => { if (gate.ready) go('order'); });

  if (front && !front.eliminated){
    const h = specHash({ format:design.format, layoutFront:design.layout, layoutBack:design.back,
      typeSystem:design.type, palette:design.palette, density:design.density,
      script:design.script, content });
    FULFIL.paint('#identity', [['specHash', h], ['Versions', String(state.history.length + 1)],
      ['Renders', `cacheable at renders/${h.slice(0, 8)}/…`]]
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join(''));
  }
}

/* The PDF/X-4 file and the foil/spot-UV separations are the server's work
   (Technical Design §6). Until that function is deployed this block says what
   is missing and what the geometry documents above do and do not cover — the
   one thing it must never do is offer a download the system cannot produce. */
function drawPrintFile(gate, ent){
  const host = FULFIL.slot('export', 'printFile', 'stack');
  if (!host) return;
  const st = endpointStatus(ENDPOINT.print);
  const got = state.printFile;

  if (!gate.ready){
    host.innerHTML = `<h6 style="margin-bottom:8px">Print-ready PDF</h6>
      <p class="lede" style="font-size:12.5px">Not offered while ${gate.blocking.length
        ? 'a blocking finding stands' : 'an advisory finding is still waiting to be accepted'}.</p>`;
    return;
  }
  /* The purchase panel already stands above with the price on it, so this
     block states the one thing that panel does not: that the file exists and
     is built, and that what is missing is the payment rather than the
     capability. Repeating the price here would be the same offer twice. */
  if (ent && !ent.may.export){
    host.innerHTML = `<h6 style="margin-bottom:8px">Print-ready PDF</h6>
      <p class="lede" style="font-size:12.5px">Built on the server from the saved spec — CMYK, outlined fonts,
      3 mm bleed, TrimBox and BleedBox, one named spot separation per special. It is released with the file
      pack above. Nothing about your card changes when you buy it; the file is already what it will be.</p>`;
    return;
  }
  const head = '<h6 style="margin-bottom:8px">Print-ready PDF</h6>';
  if (got && got.url){
    host.innerHTML = head + `<a class="chip" download="${esc(got.name)}" href="${got.url}">${ICON.down} ${
      esc(got.name)} — ${Math.max(1, Math.round(got.size / 1024))} KB</a>
      <p class="lede" style="font-size:12.5px">CMYK, outlined fonts, 3 mm bleed, TrimBox and BleedBox,
      one named spot separation per special.</p>`;
    return;
  }
  if (st === 'absent'){
    host.innerHTML = head + `<span class="pill pill-warn">${ICON.review} Not available on this build</span>
      <p class="lede" style="font-size:12.5px">The PDF/X-4 writer runs on the server at
      <span class="mono">/api/render-print</span>, and this deploy does not have it yet — it is the largest
      open engineering item in the roadmap (PRD Epic E, Technical Design §6). The SVG documents above carry
      the geometry a writer consumes: correct trim, 3 mm bleed, trim marks and a 100% K separation per
      special. They are not a PDF/X-4 and no press should be sent them as one, so nothing here pretends
      otherwise.</p>`;
    return;
  }
  host.innerHTML = head + (net.lastError && net.lastError.code !== 'offline' ? errorBlock(net.lastError, t('retry')) : '')
    + `<button class="btn" data-buildpdf="1" ${busy(ENDPOINT.print) ? 'disabled' : ''}>${
        busy(ENDPOINT.print) ? esc(t('loading')) : 'Build the print-ready PDF'}</button>
      <p class="lede" style="font-size:12.5px">Built on the server from the saved spec, so the press and you
      are looking at the same file. ${state.shareCode ? '' : 'Save the design first and the reference travels with it.'}</p>`;
  FULFIL.on('#printFile [data-buildpdf]', buildPrintFile);
  bindRetry(buildPrintFile);
}

async function buildPrintFile(){
  try {
    const body = state.shareCode ? { shortCode: state.shareCode, owner: ownerKey() }
                                 : { spec: specFor(lastDesign ? lastDesign.layout : state.layout, readForm()),
                                     owner: ownerKey() };
    const blob = await apiBlob(ENDPOINT.print, body,
      typeof authHeaders === 'function' ? authHeaders() : {});
    if (state.printFile && state.printFile.url && URL.revokeObjectURL) URL.revokeObjectURL(state.printFile.url);
    state.printFile = { url: URL.createObjectURL(blob), size: blob.size,
                        name: `cardworks_${state.shareCode || 'card'}_print.pdf` };
  } catch (e){ state.printFile = null; }
  draw();
}

/* ══════════════════════════ PRESSES ══════════════════════════
   These four records are the local fallback for a build that cannot reach the
   quote service. The real list is `presses` in the database, offered through
   A4's endpoint with capability, minimum run and lead time per row; this table
   is what the screen falls back to, and it says so on screen rather than
   passing itself off as presses that have agreed to something. */
function pressesFor(finishes){
  return PRESSES.map(p => ({ ...p, ok: finishes.every(f => p.can.includes(f)) }));
}
/** PRD §7 requires two presses minimum in the same city, so that one press's
 *  rejection or delay never blocks an order. That is a property of the chosen
 *  finish set, not of the product as a whole, so it is computed per order and
 *  said out loud on the screen when the set falls to one. */
function capablePresses(finishes){
  return PRESSES.filter(p => finishes.every(f => p.can.includes(f)));
}
function currentPress(){
  const list = pressesFor(state.finishes);
  return list.find(x => x.ok && x.name === state.press) || list.find(x => x.ok) || list[0] || null;
}

/* ══════════════════════════ PAYMENT ══════════════════════════
   bKash, Nagad and cash on delivery at launch; card rails are deferred until
   volume justifies the gateway (PRD Epic F). Nothing here captures anything
   at checkout — the capture call lives in `approveAndPay`, on the far side of
   the customer holding a printed proof. */
const PAY_METHODS = [
  { id:'bkash', label:'bKash',            kind:'redirect', online:true,
    note:'You are handed to bKash to enter your PIN when you approve the proof, and the run starts once they confirm' },
  { id:'nagad', label:'Nagad',            kind:'redirect', online:true,
    note:'You are handed to Nagad to enter your PIN when you approve the proof, and the run starts once they confirm' },
  { id:'cod',   label:'Cash on delivery', kind:'offline',  online:false,
    note:'Collected by the courier when the run arrives; approving starts the run straight away' }
];
/** The methods this deploy actually offers, merged over the copy above.
 *  `/api/payments?methods=1` is the authority on which providers exist and on
 *  whether each is talking to a real gateway or a sandbox; the local table
 *  supplies the sentence a customer reads, which the server has no business
 *  writing. A provider the server does not list is not offered at all. */
function payMethods(){
  const live = state.payMethods;
  if (!Array.isArray(live) || !live.length) return PAY_METHODS;
  return live.map(m => {
    const local = PAY_METHODS.find(x => x.id === m.id) || {};
    return { ...local, ...m, online: m.kind === 'redirect',
             note: local.note || `Handled by ${m.label} when you approve the proof` };
  });
}
const payMethod = () => payMethods().find(m => m.id === state.payMethod) || null;

/** The single place that decides whether money may move. An order may only be
 *  charged from `awaiting_approval`, which is the state the server puts it in
 *  once a proof exists and before the customer has said yes. Every earlier
 *  state is pre-proof and every later one has already been charged, so both
 *  are refused with a reason rather than silently ignored. */
const CHARGE_FROM = 'awaiting_approval';
function chargeGate(order){
  const status = order && (order.status || (order.order && order.order.status));
  if (!status) return { allowed:false, reason:'No order to charge.' };
  if (status === CHARGE_FROM) return { allowed:true, reason:'' };
  if (status === 'printing' || status === 'delivered')
    return { allowed:false, reason:'This order was already approved and charged.' };
  if (status === 'cancelled') return { allowed:false, reason:'This order was cancelled.' };
  return { allowed:false, reason:'The proof has not reached you yet. Nothing is charged before you approve it.' };
}

/* The flow the server keeps in `orders.mjs`. Mirrored here so tracking has
   something to draw before the first response arrives and so the sequence can
   be asserted without a database. Kept in this order deliberately: approval
   sits between the proof and the run, which is the whole product promise. */
const FLOW_STAGES = [
  ['files_locked',      'Files locked',     'Preflight passed with no blocking finding'],
  ['at_press',          'Sent to press',    'Plates and any foil block prepared'],
  ['proof_printed',     'Proof printed',    'One card, on the exact stock and finish of the run'],
  ['proof_delivered',   'Proof delivered',  'Courier handover'],
  ['awaiting_approval', 'Your approval',    'The run does not start, and nothing is charged, until you approve'],
  ['printing',          'Run and delivery', 'Four working days after approval'],
  ['delivered',         'Delivered',        '']
];
const STATUS_LABEL = Object.fromEntries(FLOW_STAGES.map(([k, l]) => [k, l]));
STATUS_LABEL.cancelled = 'Cancelled';

/* ══════════════════════════ ORDER ══════════════════════════ */
function drawOrder(design, content){
  const gate = exportGate(design, content);
  askPayments();

  /* The same lock as Export. Reaching this screen unready — by restoring a
     session, or by a stage-rail click that raced a content edit — must
     produce a refusal, not a checkout. The router in ui-validate.js normally
     redirects before this runs; this is the second lock, for the moment it
     does not, and a screen that quietly rendered a checkout in that gap would
     be the one place the guarantee leaked. */
  if (!gate.ready){
    FULFIL.paint('#presses', `<span class="pill pill-warn">${ICON.review} Ordering is closed — ${esc(gate.reason)}</span>`);
    FULFIL.paint('#orderSummary', `<p class="lede" style="font-size:12.5px">${gate.blocking.length
      ? 'A press cannot fix a blocking finding and should not be asked to try. Fix it on the Validate screen and the checkout returns.'
      : 'The advisory findings have not been accepted yet. Money should not be committed against a compromise nobody has agreed to.'}</p>
      <button class="btn" data-tovalidate="1">Open Preflight</button>`);
    FULFIL.on('#orderSummary [data-tovalidate]', () => go('validate'));
    FULFIL.paint('#orderSteps', '');
    const q = FULFIL.slot('order', 'orderQuote', 'stack'); if (q) q.innerHTML = '';
    const p = FULFIL.slot('order', 'orderPay', 'stack'); if (p) p.innerHTML = '';
    FULFIL.enable('#b_placeorder', false);
    FULFIL.on('#b_placeorder', () => {});
    FULFIL.paint('#orderOut', '');
    return;
  }

  ensureServerQuote();
  ensureEntitlement();
  const ent = entitlementView();
  const q = state.quote;
  const view = quoteView();

  /* The press list is the quote's own options once A4 has answered: real press
     rows with their capability match, minimum run and lead time, rather than
     the four names this file used to carry. The local table is the fallback
     for a build with no quote service, and it is labelled as such so nobody
     mistakes a placeholder for a press that has agreed to anything. */
  if (q && q.options && q.options.length){
    if (!q.options.some(o => o.slug === state.press)) state.press = q.options[0].slug;
    FULFIL.paint('#presses',
      singlePressWarning(q.singlePressOnly, q.options.length)
      + q.options.map(o => `
      <button class="check" style="width:100%;text-align:left;background:${
        o.slug === state.press ? 'var(--color-accent-100)' : 'transparent'};border:0;border-bottom:1px solid var(--hair);cursor:pointer;font:inherit"
        data-press="${esc(o.slug)}">
        <span class="ico i-pass">${ICON.pass}</span>
        <span style="flex:1"><b>${esc(o.name)}</b>
          <span class="note">Can produce ${esc((o.capabilityMatch && o.capabilityMatch.requested || [])
            .map(f => (FINISH_COST[f] || {}).label || f).join(', ') || 'plain stock')} · lead time ${esc(o.leadTime)}${
            o.pdfx4Stance ? ' · PDF/X-4: ' + esc(o.pdfx4Stance) : ''}${
            o.pressVerified ? '' : ' · not yet verified'}</span></span>
        <span class="scorenum">${taka(o.price)}</span>
      </button>`).join('')
      + (q.unavailable || []).map(u => `
      <div class="check" style="opacity:.55"><span class="ico i-fail">${ICON.fail}</span>
        <span style="flex:1"><b>${esc(u.name)}</b><span class="note">${esc(u.note || u.reason)}</span></span>
        <span class="scorenum">—</span></div>`).join(''));
  } else {
    const list = pressesFor(state.finishes);
    const capable = capablePresses(state.finishes);
    if (!list.some(p => p.ok && p.name === state.press))
      state.press = (list.find(p => p.ok) || list[0]).name;
    FULFIL.paint('#presses',
      singlePressWarning(capable.length < 2, capable.length)
      + list.map(p => `
      <button class="check" style="width:100%;text-align:left;background:${
        p.name === state.press ? 'var(--color-accent-100)' : 'transparent'};border:0;border-bottom:1px solid var(--hair);cursor:${p.ok ? 'pointer' : 'not-allowed'};font:inherit"
        data-press="${esc(p.name)}" ${p.ok ? '' : 'disabled'}>
        <span class="ico ${p.ok ? 'i-pass' : 'i-fail'}">${p.ok ? ICON.pass : ICON.fail}</span>
        <span style="flex:1"><b>${esc(p.name)}</b>
          <span class="note">${p.ok ? 'Can produce ' + (state.finishes.map(f => (FINISH_COST[f] || {}).label || f).join(', ') || 'plain stock')
            : 'Cannot produce ' + state.finishes.filter(f => !p.can.includes(f)).map(f => (FINISH_COST[f] || {}).label || f).join(', ')}
            · lead time ${p.lead}</span></span>
        <span class="scorenum">${p.ok ? taka(customerLines(state.qty, state.finishes, state.zone, p.mult).total) : '—'}</span>
      </button>`).join('')
      + `<p class="lede" style="font-size:12px">These four are the local placeholder table, not presses that
         have quoted. The order screen prices from the server's press records when it can reach them.</p>`);
  }
  $$('#presses [data-press]').forEach(b => b.onclick = () => {
    state.press = b.dataset.press;
    if (state.quote) state.quote.option =
      state.quote.options.find(o => o.slug === state.press) || state.quote.option;
    draw();
  });

  const p = currentPress();
  state.orderTotal = view.total;
  state.orderSub = view.cost ?? Math.round(view.total / MARGIN);

  const qHost = FULFIL.slot('order', 'orderQuote', 'stack');
  if (qHost) qHost.innerHTML = '<h6 style="margin-bottom:8px">Quote</h6>' + quoteBlock(view, gate);

  FULFIL.paint('#orderSummary', `<dl class="kv">
    <dt>Design</dt><dd>${esc((LAYOUTS.find(l => l.id === design.layout) || {}).name || '—')}</dd>
    <dt>Quantity</dt><dd>${state.qty} cards</dd>
    <dt>Stock</dt><dd>300 gsm art card</dd>
    <dt>Finish</dt><dd>${esc(state.finishes.map(f => (FINISH_COST[f] || {}).label || f).join(', ') || 'none')}</dd>
    <dt>Press</dt><dd>${esc(view.press || (p ? p.name : '—'))}</dd>
    <dt>Lead time</dt><dd>${esc(view.lead || (p ? p.lead : '—'))} after approval</dd>
    <dt>Total</dt><dd><b>${taka(view.total)}</b> <span class="note">${
      view.estimate ? 'estimate' : 'press-quoted'}</span></dd></dl>`);

  drawPayment();

  FULFIL.paint('#orderSteps', [
    ['01', 'Files locked',     'Preflight passed with no blocking finding'],
    ['02', 'Printed proof',    'One card, same stock and finish'],
    ['03', 'You approve',      'Charged at this point, not before'],
    ['04', 'Run and delivery', (view.lead || (p ? p.lead : '—')) + ' after approval']
  ].map(([n, ttl, d]) => `<div class="check"><span class="railnum">${n}</span>
    <span style="flex:1">${ttl}<span class="note">${esc(d)}</span></span></div>`).join(''));

  /* An order is priced by the server against the quote it issued, so there is
     nothing to place until that quote exists. The old screen would happily
     post a browser-computed total; the endpoint now refuses one, and refusing
     it here first is the difference between a disabled button with a reason
     and a failed request the customer has to interpret.

     And nothing to place until the design's file has been bought. PRD §9's
     free tier is briefs, concepts and a watermarked preview — a print run is
     the other paid line, and it is made of the file. The refusal is stated in
     `#orderOut` beside the other three, because a disabled button with no
     sentence next to it is the worst version of every gate on this screen.

     The server has to refuse it too — `/api/orders` is where `assertEntitled`
     belongs, so that a caller who skips this file meets the same answer with
     the same price on it rather than an order nobody can honour. */
  const ready = !!state.shareCode && !!payMethod() && !!(q && q.quoteId) && ent.may.order;
  FULFIL.enable('#b_placeorder', ready && !busy(ENDPOINT.orders));
  FULFIL.on('#b_placeorder', placeOrder);
  FULFIL.paint('#orderOut',
    (!state.shareCode ? checkRow({ s:'review', label:'Save the design first',
        note:'An order points at a saved design, so the press and the customer are looking at the same file.' }) : '')
    + (state.shareCode && !ent.may.order ? filePackBlock(ent, 'order') : '')
    + (state.shareCode && !(q && q.quoteId) ? checkRow({ s:'review', label:'Waiting for a server quote',
        note:'The price on an order is the one the server issued, never one this browser worked out. Until that quote arrives the figure above is a preview.' }) : '')
    + (!payMethod() ? checkRow({ s:'review', label:'Choose how you will pay',
        note:'Nothing is taken now — the method is recorded and captured only when you approve the proof.' }) : '')
    + (q && q.proofRequired ? checkRow({ s:'review', label:'A physical proof is mandatory for this finish',
        note:'PRD §7 — foil, letterpress, emboss and edge paint cannot be approved from a photograph, and that wait cannot be waived.' }) : '')
    + offlineBanner()
    + (net.lastError ? errorBlock(net.lastError, t('retry')) : ''));
  bindRetry(placeOrder);
}

/* PRD §7 requires two presses for any order so one press's delay never blocks
   it. The server decides this now, because it is a property of the press
   records rather than of this screen; the local computation is the fallback. */
function singlePressWarning(single, count){
  if (!single) return '';
  return `<div class="check"><span class="ico i-review">${ICON.review}</span>
    <span style="flex:1">Only ${count === 1 ? 'one press' : 'no press'} can produce ${
      esc(state.finishes.map(f => (FINISH_COST[f] || {}).label || f).join(', ') || 'this specification')}
    <span class="note">PRD §7 asks for two capable presses before launch, so one press's delay or refusal
    never blocks an order. Drop a finish to widen the list, or accept that this run has no fallback.</span></span></div>`;
}

/* Payment selection, not payment capture. The distinction is the product:
   the customer states an intent here and the money moves on the tracking
   screen, after a printed proof has been in their hands. */
function drawPayment(){
  const host = FULFIL.slot('order', 'orderPay', 'stack');
  if (!host) return;
  const st = endpointStatus(ENDPOINT.payments);
  host.innerHTML = `<h6 style="margin-bottom:8px">Pay with</h6>
    <div class="chips" role="radiogroup" aria-label="Payment method">${
      payMethods().map(m => `<button class="chip" role="radio" data-pay="${m.id}"
        aria-checked="${state.payMethod === m.id}" aria-pressed="${state.payMethod === m.id}">${esc(m.label)}</button>`).join('')}</div>
    ${payMethod() ? `<p class="lede" style="font-size:12.5px">${esc(payMethod().note)}</p>` : ''}
    ${st === 'absent' && payMethod() && payMethod().online
      ? `<p class="pill pill-warn" style="margin-top:8px">${ICON.review} ${esc(payMethod().label)} cannot be captured on this build</p>
         <p class="lede" style="font-size:12.5px">No provider is wired up at
         <span class="mono">/api/payments</span> yet (Technical Design §10 item 2). You can still place the
         order and receive the proof — the approval step will refuse to pretend a ${esc(payMethod().label)}
         payment succeeded, and cash on delivery works today.</p>` : ''}
    ${payMethod() && payMethod().simulated
      ? `<p class="pill pill-warn" style="margin-top:8px">${ICON.review} ${esc(payMethod().label)} is running against a sandbox</p>
         <p class="lede" style="font-size:12.5px">This deploy has no live ${esc(payMethod().label)} credentials, so
         approving will move no real money. Everything else behaves as it will in production — the run is
         recorded as paid — which is exactly why it should not be pointed at a paying customer.</p>` : ''}
    <p class="lede" style="font-size:12.5px">Nothing is charged now. The amount is captured at the moment
    you approve the printed proof, and not one step earlier.</p>`;
  $$('#orderPay [data-pay]').forEach(b => b.onclick = () => { state.payMethod = b.dataset.pay; draw(); });
}

async function placeOrder(){
  const q = state.quote;
  if (!state.shareCode || !payMethod() || !(q && q.quoteId)) return;
  const g = exportGate(lastDesign || currentDesign(), readForm());
  if (!g.allowed){ draw(); return; }
  try {
    /* No amount moves here, and no payment call is made here — checkout
       records an intent and nothing else; capture happens in `approveAndPay`,
       after a printed proof.

       `total` is sent only because it came from the server's own quote, and
       it is sent so the server can *disagree*: if the price moved between the
       quote and this click, the endpoint answers `price_moved` rather than
       charging a number the customer never saw. Sending the client's estimate
       here would turn that safeguard into a false alarm, which is why the
       button is disabled until a real quote exists. */
    const j = await api(ENDPOINT.orders, { method:'POST', body:{
      shortCode: state.shareCode, qty: Number(state.qty),
      press: (q.option && q.option.slug) || state.press,
      quoteId: q.quoteId, total: q.option ? q.option.price : undefined,
      finishes: state.finishes, zone: state.zone,
      payMethod: state.payMethod, owner: ownerKey(),
      recipient: { name: ($('#i_recname') || {}).value || '', phone: ($('#i_recphone') || {}).value || '',
                   address: ($('#i_recaddr') || {}).value || '' } } });
    markSaved(state.shareCode);
    state.orderTotal = j.total ?? state.orderTotal;
    state.trackRef = j.ref; state.order = null; go('tracking'); loadOrder(j.ref);
  } catch (err){
    /* A stale or moved price is not a failure to report and forget: the quote
       has to be refetched before the button can mean anything again. */
    if (/price_moved|quote_stale|quote_expired|bad_quote/.test(err.code || '')){
      state.quote = null; state.quoteKey = null;
    }
    draw();
  }
}

/* ══════════════════════════ TRACKING ══════════════════════════ */
async function loadOrder(ref){
  try { state.order = await api(ENDPOINT.orders + '?ref=' + encodeURIComponent(ref), { quiet:true }); }
  catch (e){ state.order = null; }
  draw();
}

const whenText = (ts) => ts ? String(ts).replace('T', ' ').replace(/(:\d\d)[.:].*$/, '$1').slice(0, 16) : '';

function drawTracking(){
  /* Approval is where money moves, so this screen needs the same answer about
     the payment provider that checkout had — a customer can land here from a
     link or a reload without ever having drawn the order screen. */
  askPayments();
  const o = state.order;
  if (!o){
    FULFIL.paint('#trackTimeline', net.lastError ? errorBlock(net.lastError, t('retry'))
      : pendingBlock('Loading the order'));
    bindRetry(() => { if (state.trackRef) loadOrder(state.trackRef); });
    return;
  }
  const order = o.order || {};
  const cur = order.status;
  const flow = Array.isArray(o.flow) && o.flow.length ? o.flow : FLOW_STAGES;
  const events = Array.isArray(o.events) ? o.events : [];
  const idx = flow.findIndex(f => f[0] === cur);
  /* The server now returns `charge` from the same `chargeability()` the
     payment module refuses with, so the screen greys the button out for
     exactly the reason the endpoint would give. `chargeGate` stays as the
     fallback for a build without it, and as the invariant the suite asserts —
     but where both speak, the server is the authority on its own money. */
  const charge = o.charge
    ? { allowed: !!o.charge.ok, reason: o.charge.message || '' }
    : chargeGate(order);
  const paid = o.payment && o.payment.paid;

  FULFIL.text('#trackRef', order.ref || 'Order');
  FULFIL.text('#trackStatus', STATUS_LABEL[cur] || cur || '');

  /* The proof moment, made first-class rather than a row in a list. It is the
     trust mechanism from PRD §1 and §7 and the reason the whole flow exists,
     so it sits above the timeline whenever the order is actually waiting on
     the customer, and disappears when it would be theatre. */
  const proof = FULFIL.slot('tracking', 'proofPanel', 'stack');
  if (proof) proof.innerHTML = charge.allowed ? `
    <h6 style="margin-bottom:8px">Your proof is here</h6>
    <p class="lede" style="margin-top:0"><b>Nothing is charged until you approve this exact card.</b>
    One card was printed on the exact stock and finish of the run. Hold it. If anything is wrong, send it
    back with a note and the run does not start.</p>
    <div class="row">
      <button class="btn" data-reproof="1">Request changes</button>
      <button class="btn btn-primary btn-lg" data-approve="1" ${busy(ENDPOINT.orders) ? 'disabled' : ''}>Approve &amp; pay${
        state.orderTotal || order.total ? ' ' + taka(order.total || state.orderTotal) : ''}</button>
    </div>
    <p class="lede" style="font-size:12.5px">Approving is the moment the ${
      esc((payMethod() || {}).label || String(order.pay_method || 'payment'))} is captured and the run starts.${
      (payMethod() || {}).kind === 'redirect'
        ? ' You will be sent to the provider to enter your PIN, and this order stays unapproved until they confirm.' : ''}</p>`
    : `<p class="lede" style="margin-top:0">${esc(charge.reason)}</p>`;

  /* A vertical, timestamped log. The times come from `order_events`, which is
     append-only on the server, so what is drawn here is the history rather
     than a summary of it that could be rewritten. */
  const firstAt = {};
  for (const e of events) if (!(e.type in firstAt)) firstAt[e.type] = e.created_at;
  FULFIL.paint('#trackTimeline', flow.map(([k, ttl, n], i) => {
    const done = i < idx, now = i === idx, at = firstAt[k];
    return `<div class="check" style="${i > idx ? 'opacity:.45' : ''}">
      <span class="ico ${done || now ? 'i-pass' : ''} ${now ? 'ticking' : ''}">${done ? ICON.pass : ICON.dot}</span>
      <span style="flex:1">${esc(ttl)}<span class="note">${esc(n)}${
        at ? ` · ${esc(whenText(at))}` : ''}</span></span>
      <span class="scorenum">${done ? 'done' : now ? 'now' : ''}</span></div>`;
  }).join('')
    + (events.length ? `<h6 style="margin:12px 0 8px">Event log</h6>` + events.map(e =>
        `<div class="check"><span style="flex:1">${esc(STATUS_LABEL[e.type] || String(e.type).replace(/_/g, ' '))}
          <span class="note">${esc(e.actor || 'system')}${e.note ? ' · ' + esc(e.note) : ''}</span></span>
         <span class="scorenum mono">${esc(whenText(e.created_at))}</span></div>`).join('')
        + `<p class="lede" style="font-size:12px">Append-only. Entries are added, never edited or removed,
           so the record of who approved what and when cannot be quietly changed.</p>` : ''));

  const pay = o.payment && o.payment.payment;
  FULFIL.paint('#trackKv', [
    ['Reference', order.ref], ['Design', '/c/' + order.short_code],
    ['Quantity', order.qty + ' cards'], ['Press', order.press],
    ['Total', taka(order.total || 0)],
    ['Payment', pay ? `${pay.provider} · ${pay.status}${pay.simulated ? ' (simulated provider)' : ''}`
      : (payMethods().find(m => m.id === order.pay_method) || payMethod() || {}).label || 'not recorded'],
    ['Charged', paid ? taka(pay.amount) + ' at approval' : 'nothing charged yet'],
    ['Placed', String(order.created_at).slice(0, 10)]
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')
    + ((o.payment && o.payment.openIncidents || []).length
      ? `<dt>Open incident</dt><dd>${esc(o.payment.openIncidents.map(i => i.kind).join(', '))}</dd>` : ''));

  FULFIL.enable('#b_approve', charge.allowed && !busy(ENDPOINT.orders));
  FULFIL.enable('#b_reproof', charge.allowed && !busy(ENDPOINT.orders));
  FULFIL.on('#b_approve', approveAndPay);
  FULFIL.on('#b_reproof', requestChanges);
  FULFIL.on('#proofPanel [data-approve]', approveAndPay);
  FULFIL.on('#proofPanel [data-reproof]', requestChanges);
}

/** Approval, which is the only moment money moves, and only from
 *  `awaiting_approval`.
 *
 *  The approve action itself now opens the payment: the endpoint owns the
 *  "cannot charge twice" guarantee behind a partial unique index, so a second
 *  call from this screen would be a second charge attempt rather than a second
 *  opinion. Nothing here posts to the payment endpoint separately any more,
 *  and nothing here supplies a callback URL — where a paying customer lands
 *  after typing their PIN is the money module's to resolve, never a caller's,
 *  because a caller-chosen callback is a phishing hop that looks like a
 *  completed payment to everyone watching. */
async function approveAndPay(){
  const o = state.order;
  const order = o && o.order;
  const charge = o && o.charge ? { allowed: !!o.charge.ok, reason: o.charge.message || '' }
                               : chargeGate(order);
  const m = payMethods().find(x => x.id === (order && order.pay_method)) || payMethod();
  if (!charge.allowed){
    FULFIL.paint('#trackOut', checkRow({ s:'fail', label:'Not approvable yet', note:charge.reason }));
    return;
  }
  if (!m){
    FULFIL.paint('#trackOut', checkRow({ s:'fail', label:'No payment method on this order',
      note:'Choose bKash, Nagad or cash on delivery before approving.' }));
    return;
  }
  try {
    const j = await api(ENDPOINT.orders, { method:'POST', body:{
      ref: order.ref, action:'approve', provider: m.id,
      total: order.total, note: ($('#i_proofnote') || {}).value || '' } });

    /* A redirect provider has not taken any money yet — the order stays at
       `awaiting_approval` until bKash or Nagad confirms — so the screen says
       that plainly instead of congratulating the customer on a payment that
       has not happened, and then hands them over. */
    if (j.redirectURL){
      FULFIL.paint('#trackOut', checkRow({ s:'review',
        label:`Continue in ${m.label}`,
        note:'The run has not started and nothing has been charged yet. It starts when the provider confirms your payment.' })
        + `<p class="lede" style="font-size:12.5px"><a class="btn btn-primary" href="${esc(j.redirectURL)}">Open ${esc(m.label)}</a></p>`);
      state.order = null; loadOrder(order.ref);
      if (typeof location !== 'undefined') location.href = j.redirectURL;
      return;
    }
    FULFIL.paint('#trackOut', checkRow({ s:'pass',
      label: j.status === 'printing' ? 'Approved — the run starts now' : 'Approved',
      note: m.id === 'cod' ? 'Cash on delivery — the courier collects when the run arrives.'
                           : `${m.label} captured at approval, as promised.` }));
    loadOrder(order.ref);
  } catch (err){
    /* A refusal because the feature is not deployed reads differently from a
       refusal because the payment failed: the first is a missing capability
       and the second is a transient problem, and telling a customer to retry a
       button that cannot work is its own small dishonesty. */
    if (/^http_(404|405|501)$/.test(err.code || '')){
      _endpointState[ENDPOINT.payments] = 'absent';
      FULFIL.paint('#trackOut', checkRow({ s:'fail',
        label:`${m.label} cannot be captured on this build`,
        note:'No payment provider is deployed, so approving would start a print run against a payment nobody took. Switch the order to cash on delivery, or wait for the provider to be wired up.' }));
      return;
    }
    /* `remediation` in the envelope is a machine token — `fix_phone`,
       `sign_in`, `wait` — that screens branch on, not prose to show anyone.
       Concatenating it put the literal word "wait" in front of a customer at
       the moment their payment had just failed. `remedyText` turns a known
       token into a sentence and an unknown one into nothing, which is the
       right failure direction here: silence beats a machine word. */
    const next = remedyText(err);
    FULFIL.paint('#trackOut', checkRow({ s:'fail', label:'Approval did not go through',
      note: [err.message, next, 'Nothing has been charged.'].filter(Boolean).join(' ') }));
  }
}

async function requestChanges(){
  const order = state.order && state.order.order;
  if (!order) return;
  try {
    await api(ENDPOINT.orders, { method:'POST', body:{
      ref: order.ref, action:'reproof', note: ($('#i_proofnote') || {}).value || '' } });
    FULFIL.paint('#trackOut', checkRow({ s:'pass', label:'A second proof has been requested',
      note:'The run has not started and nothing has been charged.' }));
    loadOrder(order.ref);
  } catch (err){
    FULFIL.paint('#trackOut', checkRow({ s:'fail', label:err.message }));
  }
}

/* ══════════════════════════ MY DESIGNS ══════════════════════════ */
async function loadDash(){
  try {
    state.dash = await api(ENDPOINT.orders + '?list=1&owner=' + encodeURIComponent(ownerKey() || ''), { quiet:true });
  } catch (e){ state.dash = { designs:[], orders:[] }; }
  draw();
}

/** Whether this listing belongs to a person or only to a browser. Until A5's
 *  accounts ship there is no session to find, and the honest answer is the
 *  one the Wireframing Document §5.13 insists stays visible. */
function ensureSession(){
  /* This GET is both the question and the probe. Asking `/api/auth` whether
     it exists and then asking it who is signed in are the same request, and
     sending it twice was one round trip spent learning nothing. */
  if (state.session !== undefined || endpointStatus(ENDPOINT.auth) === 'absent' || isOffline()) return;
  state.session = null;
  api(ENDPOINT.auth, { quiet:true })
    .then(j => { _endpointState[ENDPOINT.auth] = 'present'; state.session = (j && j.user) || null; })
    .catch(err => {
      if (/^http_(404|405|501)$/.test(err.code || '') || err.code === 'not_found')
        _endpointState[ENDPOINT.auth] = 'absent';
      state.session = null;
    })
    .then(draw);
}

function drawDashboard(content){
  ensureSession();
  const d = state.dash;

  const banner = FULFIL.slot('dashboard', 'dashIdentity', 'stack');
  if (banner) banner.innerHTML = state.session
    ? `<div class="check"><span class="ico i-pass">${ICON.pass}</span><span style="flex:1">Signed in as
        <b>${esc(state.session.name || state.session.phone || 'your account')}</b>
        <span class="note">Your designs and orders follow you to a new phone.</span></span></div>`
    : `<div class="check"><span class="ico i-review">${ICON.review}</span><span style="flex:1">Signed in as
        <b>this device only</b>
        <span class="note">These designs are keyed to a browser key stored on this phone, not to you.
        Clear the browser data, change device, or use a private window and they are gone. Signing in with
        your phone number moves this browser's work onto an account that survives the change.</span></span>
      <button class="btn" data-signin="1">Sign in</button></div>`;
  FULFIL.on('#dashIdentity [data-signin]', () => go('signin'));

  if (!d){
    FULFIL.paint('#savedTiles', pendingBlock('Loading your designs'));
    return;
  }
  FULFIL.text('#dashMeta', `${d.designs.length} saved · ${d.orders.length} orders`);
  FULFIL.paint('#savedTiles', d.designs.length ? d.designs.map(x => {
    const L = LAYOUTS.find(l => l.id === x.layout);
    const c = L ? composeForced(x.layout, content, null, { palette:x.palette }) : null;
    return `<button class="tile" role="button" tabindex="0" aria-pressed="false" data-code="${esc(x.short_code)}">
      ${(c && renderSVG(c)) || '<div class="deadbox"><span class="tilemeta">preview unavailable</span></div>'}
      <span class="tiletitle">${esc(x.name || x.label || 'Untitled')}</span>
      <span class="tilemeta">/c/${esc(x.short_code)} · ${String(x.created_at).slice(0, 10)}</span></button>`;
  }).join('') : `<div class="empty">Nothing saved from this browser yet. Design a card and press
      <b>Save and get a link</b> on the export screen.</div>`);
  bindTiles('#savedTiles .tile', tile => { location.href = '/?c=' + tile.dataset.code; });

  FULFIL.paint('#ordersList', d.orders.length ? d.orders.map(o =>
    `<button class="check" style="width:100%;text-align:left;border:0;border-bottom:1px solid var(--hair);background:transparent;cursor:pointer;font:inherit"
      data-ref="${esc(o.ref)}">
      <span style="flex:1"><b>${esc(o.ref)}</b><span class="note">${o.qty} cards · ${esc(o.press)}</span></span>
      <span class="scorenum">${taka(o.total)}</span>
      <span class="pill ${o.status === 'delivered' ? 'pill-ok' : 'pill-accent'}">${
        esc(STATUS_LABEL[o.status] || String(o.status).replace(/_/g, ' '))}</span>
    </button>`).join('') : '<p class="lede">No print orders yet.</p>');
  $$('#ordersList [data-ref]').forEach(b => b.onclick = () => {
    state.trackRef = b.dataset.ref; state.order = null; go('tracking'); loadOrder(b.dataset.ref);
  });
}

/* ── PROFILES ────────────────────────────────────────────────────────────── */
