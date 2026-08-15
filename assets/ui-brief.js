/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — brief funnel
   --------------------------------------------------------------------------
   Start screen, the seven-step brief, and the generating screen.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.

   The markup for these screens belongs to the shell; everything this file
   adds to it is rendered from here, into containers it creates itself, so
   that the funnel's own rules — how many steps there are, which of them may
   be skipped, what the personality cap does when it is hit — live in one
   place and can be asserted in CI rather than being spread across a document
   nobody re-reads.
   ══════════════════════════════════════════════════════════════════════ */

/* ── The seven steps, as data ─────────────────────────────────────────────
   This table is the single source of truth for the brief. The rail, the
   progress counter, the skip affordance and the review summary are all
   derived from it, which is the structural answer to blueprint finding F6:
   the prototype's rail announced twelve steps and delivered seven because
   the rail was written by hand next to a hardcoded "of 7". Nothing here is
   written by hand twice — the step number is the array index, so a rail that
   disagrees with the step count is not a bug that can be introduced, and
   Master PRD Epic A's CI assertion has something real to assert against.

   `required` marks the step the user may not skip. Only the first one is,
   and every other step carries the default it will fall back to, stated in
   the interface rather than left for the user to discover after generation. */
const BRIEF_STEPS = [
  { key:'identity', rail:'Who it is for', panel:0, required:true,
    fallback:null },
  { key:'routes', rail:'Contact routes', panel:1, required:false,
    fallback:'The card carries whatever routes you have already typed, and the QR carries the rest.' },
  { key:'logo', rail:'Logo', panel:2, required:false,
    fallback:'A monogram is drawn from the company name, which is what most cards here use anyway.' },
  { key:'personality', rail:'Personality', panel:3, required:false,
    fallback:'Nothing stated, so the industry prior decides — and every explanation says so.' },
  { key:'language', rail:'Language and size', panel:4, required:false,
    fallback:'Bangla and English together, on the standard 89 × 51 mm card.' },
  { key:'printing', rail:'Printing', panel:5, required:false,
    fallback:'Matte lamination, balanced density, 500 cards, delivered inside Dhaka.' },
  { key:'review', rail:'Review', panel:6, required:false,
    fallback:null }
];

/** How many steps there actually are. Everything that displays a step count
    calls this rather than repeating the number. */
const briefStepCount = () => BRIEF_STEPS.length;

/** The rail, derived. It is a `map` over the step table, so its length is
    the step count by construction and the two cannot drift apart; the
    displayed number is the position, not an authored string. */
function briefRail(){
  return BRIEF_STEPS.map((s, i) => ({
    index: i, key: s.key, label: s.rail,
    num: String(i + 1).padStart(2, '0'),
    required: !!s.required,
    skippable: !s.required && i < BRIEF_STEPS.length - 1
  }));
}

/* The five stages after the brief — Generate, Explore, Customise, Validate,
   Export — used to be appended to this same rail, which is how seven steps
   came to be announced as twelve. They are a different journey and they
   belong to the stage bar; this rail renders brief steps and nothing else. */
function briefRailHTML(step){
  return briefRail().map(r =>
    `<button class="railitem" data-step-go="${r.index}" aria-current="${r.index === step ? 'step' : 'false'}">
       <span class="railnum">${r.num}</span><span>${esc(r.label)}</span>
       ${r.index < step ? `<span class="railmark">${ICON.check}</span>` : ''}
     </button>`).join('');
}

/* ── Brief-local wording ──────────────────────────────────────────────────
   The shell's `t()` carries the handful of strings every screen needs. The
   funnel needs more than that, and adding them to the shell's table would
   make a frozen contract grow every time a screen wants a sentence, so the
   brief keeps its own and reads the same language setting. */
const BRIEF_STRINGS = {
  en: {
    composing:'Composing…', compose:'Compose six concepts',
    stepOf:(a,b) => `Step ${a} of ${b}`,
    nameNeeded:'A full name, first. It is the one field the composer cannot lay out without.',
    optional:'Everything on this step has a default. Skipping is not a worse answer, only a faster one.',
    skipped:'Skipped, using defaults',
    trade:'Start from your trade',
    tradeNote:'Each one fills in the fields that trade actually needs. Not one of these? Choose from the full list below.',
    otherTrade:'Another industry',
    language:'Interface language',
    haveCode:'Have a code?', openDesign:'Open a design',
    haveCard:'Already have a card?',
    haveCardNote:'Bring the one your shop printed. We will say exactly what would go wrong on press, fix what is simply wrong, and ask before changing anything that is a matter of taste.',
    enhanceIt:'Fix my card for print',
    takeApart:'Take it apart and restyle it',
    codeLabel:'Design code',
    badCode:'That code does not look right — six to sixteen characters, digits and a to f.',
    genPending:'Enumerating every layout, palette and type system against your brief.',
    genMs:(ms) => `Composed in ${ms < 1 ? 'under 1' : ms} ms.`,
    genHonest:'This screen is on-screen for exactly as long as the engine took. There is no timed animation.'
  },
  bn: {
    composing:'সাজানো হচ্ছে…', compose:'ছয়টি ডিজাইন তৈরি করুন',
    stepOf:(a,b) => `ধাপ ${a} / ${b}`,
    nameNeeded:'আগে পুরো নাম দিন। নাম ছাড়া কার্ড সাজানো যায় না।',
    optional:'এই ধাপের সবকিছুরই ডিফল্ট আছে। বাদ দিলে ফল খারাপ হয় না, শুধু দ্রুত হয়।',
    skipped:'বাদ দেওয়া হয়েছে, ডিফল্ট ব্যবহার হচ্ছে',
    trade:'আপনার পেশা থেকে শুরু করুন',
    tradeNote:'প্রতিটি পেশার নিজস্ব দরকারি তথ্য আগেই বসানো থাকে। এর মধ্যে না থাকলে নিচের তালিকা থেকে বেছে নিন।',
    otherTrade:'অন্য পেশা',
    language:'ভাষা',
    haveCode:'কোড আছে?', openDesign:'ডিজাইন খুলুন',
    haveCard:'আগে থেকেই কার্ড আছে?',
    haveCardNote:'দোকান থেকে ছাপানো কার্ডটিই নিয়ে আসুন। ছাপার সময় কী কী সমস্যা হবে তা আমরা বলে দেব, যেটা নিশ্চিতভাবে ভুল সেটা ঠিক করে দেব, আর রুচির ব্যাপার হলে আগে জিজ্ঞেস করব।',
    enhanceIt:'কার্ডটি ছাপার উপযোগী করুন',
    takeApart:'খুলে নতুন করে সাজান',
    codeLabel:'ডিজাইন কোড',
    badCode:'কোডটি ঠিক নয় — ছয় থেকে ষোলো অক্ষর, ০–৯ এবং a–f।',
    genPending:'আপনার ব্রিফের সঙ্গে প্রতিটি লেআউট, রং ও টাইপ মিলিয়ে দেখা হচ্ছে।',
    genMs:(ms) => `${ms < 1 ? '১ মিলিসেকেন্ডেরও কম' : ms + ' মিলিসেকেন্ড'} সময় লেগেছে।`,
    genHonest:'ইঞ্জিন যতক্ষণ কাজ করেছে, এই পর্দা ঠিক ততক্ষণই থাকে। কোনো সাজানো অ্যানিমেশন নেই।'
  }
};
function bt(key, ...args){
  const table = BRIEF_STRINGS[uiLang()] || BRIEF_STRINGS.en;
  const v = table[key] !== undefined ? table[key] : BRIEF_STRINGS.en[key];
  return typeof v === 'function' ? v(...args) : (v === undefined ? key : v);
}

/* ── Language and script ──────────────────────────────────────────────────
   Master PRD §5.1 requires the script step to default to bilingual rather
   than English-only, because bilingual is what most of the addressable
   market actually wants. Both `latin` and `bangla` carry both scripts — one
   puts English on the front, the other Bangla — and the two `-only` options
   are the ones that drop a script. The default follows the language the user
   chose on the Start screen, so answering the toggle in Bangla is enough to
   get a Bangla-front card without hunting for step five. */
const BILINGUAL_SCRIPTS = ['latin', 'bangla'];
const briefScriptDefault = (lang) => ((lang || uiLang()) === 'bn' ? 'bangla' : 'latin');

/* Seeded once per page load and only over the shell's own untouched initial
   value, so a restored session that deliberately chose English-only or
   Bangla-only is never quietly overwritten. */
let _scriptSeeded = false;
function seedBriefScript(){
  if (_scriptSeeded || state.scriptTouched) return state.script;
  _scriptSeeded = true;
  if (state.script === 'latin') state.script = briefScriptDefault();
  const el = $('#i_script'); if (el) el.value = state.script;
  return state.script;
}

/* ── Personality, capped at three ─────────────────────────────────────────
   Blueprint finding F8: a fourth tap while three were selected silently
   dropped the oldest selection, which reads as the app being broken rather
   than as a limit being enforced. The cap is now stated, in the exact words
   the Wireframing Document §5.3 specifies, and announced to assistive tech
   as well as drawn. The function is pure so the rule can be tested without
   a browser. */
const PERSONALITY_CAP = 3;
const PERSONALITY_CAP_MESSAGE = '3 of 3 selected — tap one to deselect it';
const personalityCapMessage = (lang) => ((lang || uiLang()) === 'bn'
  ? '৩টির মধ্যে ৩টি নির্বাচিত — একটিতে চাপ দিয়ে বাদ দিন'
  : PERSONALITY_CAP_MESSAGE);

function personalityTap(selected, axis){
  const list = (selected || []).slice();
  const i = list.indexOf(axis);
  if (i >= 0){ list.splice(i, 1); return { personality:list, message:'', capped:false }; }
  if (list.length >= PERSONALITY_CAP)
    return { personality:list, message:personalityCapMessage(), capped:true };
  list.push(axis);
  return { personality:list, message:'', capped:false };
}

/* ── Vertical presets ─────────────────────────────────────────────────────
   Master PRD Epic H wants doctor, RMG/export, advocate and shop/service as
   first-class starting points rather than four rows of a dropdown, because
   the four personas in §3.2 each need a field a generic template has no slot
   for. The content itself is not restated here: each vertical names one of
   the engine's own `PRESETS` and is resolved against it, so the brief and
   the test corpus cannot describe two different doctors. `ensure` fills only
   what a preset leaves blank, and is where the persona-specific route lives
   — chamber hours for Dr. Nasrin, a Facebook page for the shop owner who has
   no website. */
const VERTICALS = [
  { id:'doctor', preset:'Doctor — chamber card', industry:'doctor',
    label:'Doctor / chamber', personality:['traditional','premium'],
    carries:'Long qualification strings and chamber hours',
    ensure:{ addr:'Chamber: House 35/A, Dhanmondi, Dhaka-1205 · 5pm–9pm' } },
  { id:'rmg', preset:'RMG buying house', industry:'rmg',
    label:'RMG / export', personality:['corporate','premium'],
    carries:'Bilingual name and title for a foreign buyer',
    ensure:{ web:'zenithsourcing.com' } },
  { id:'advocate', preset:'Advocate', industry:'advocate',
    label:'Advocate / notary', personality:['traditional','corporate'],
    carries:'Court and chamber address ahead of email',
    ensure:{ addr:'Room 214, Bar Council Bhaban, Ramna, Dhaka-1000' } },
  { id:'shop', preset:'Electronics shop', industry:'shop',
    label:'Shop / service trade', personality:['friendly','bold'],
    carries:'A Facebook page instead of a website, two mobiles',
    ensure:{ web:'fb.com/yourshop' } }
];

/** The engine preset a vertical is built on. A vertical that names one that
    does not exist is a CI failure, not a silently empty form. */
const verticalPreset = (v) => PRESETS.find(p => p.k === (v && v.preset)) || null;

/** Everything a vertical implies, as data: industry, personality defaults,
    a bilingual script for the current interface language, and the content
    fields that trade needs. Pure, so the persona requirements in PRD §3.2
    can be asserted directly. */
function applyVertical(id, lang){
  const v = VERTICALS.find(x => x.id === id);
  if (!v) return null;
  const p = verticalPreset(v);
  const content = Object.assign({}, p ? p.c : {});
  for (const k in v.ensure) if (!content[k]) content[k] = v.ensure[k];
  return { id: v.id, industry: v.industry, personality: v.personality.slice(),
           script: briefScriptDefault(lang), content };
}

/* ── DOM plumbing ─────────────────────────────────────────────────────────
   The shell owns the markup, so the brief adds its own containers rather
   than rewriting anyone else's. `setHTML` only writes when the markup has
   actually changed, which keeps a redraw on every keystroke from stealing
   focus out of a chip the user is operating from the keyboard. */
function briefSlot(id, hostSelector, where){
  let el = $('#' + id);
  if (el) return el;
  const host = $(hostSelector);
  if (!host || typeof document.createElement !== 'function') return null;
  el = document.createElement('div');
  el.id = id;
  const anchor = where === 'first' ? host.firstChild
               : where ? (host.querySelector && host.querySelector(where))
               : null;
  if (anchor && host.insertBefore) host.insertBefore(el, anchor);
  else if (host.appendChild) host.appendChild(el);
  return el;
}
function setHTML(el, html){
  if (el && el.innerHTML !== html) el.innerHTML = html;
  return el;
}

/* ══════════════════════════ BRIEF ══════════════════════════ */
function drawBrief(content){
  seedBriefScript();

  const count = briefStepCount();
  state.step = Math.max(0, Math.min(count - 1, Number(state.step) || 0));
  const step = state.step, def = BRIEF_STEPS[step], last = step === count - 1;
  if (!Array.isArray(state.skipped)) state.skipped = [];

  $$('[data-step]').forEach(p => {
    p.style.display = Number(p.dataset.step) === step ? 'flex' : 'none';
  });

  /* The cap message belongs to the tap that hit the cap, not to the session;
     leaving step four is the user having moved on from it. */
  if (BRIEF_STEPS[step].key !== 'personality') state.capMessage = '';

  setHTML($('#rail'), briefRailHTML(step));
  $$('#rail [data-step-go]').forEach(b =>
    b.onclick = () => { state.step = Number(b.dataset.stepGo); draw(); });

  drawBriefProgress(step, count);
  drawVerticals();
  drawPersonality();
  bindScript();

  const nameOk = !!(content.name || '').trim();
  drawBriefBar(step, count, def, last, nameOk);
  drawImplies();
  if (last) drawReview(content);
}

/* The step counter. It is a live region so a screen reader hears the move
   between steps, and it is only rewritten when the step actually changes —
   otherwise every keystroke would re-announce it. */
let _lastProgress = null;
function drawBriefProgress(step, count){
  const host = briefSlot('briefProgress', '[data-screen="brief"]', 'first');
  if (!host) return;
  if (host.setAttribute){ host.setAttribute('role','status'); host.setAttribute('aria-live','polite'); }
  const key = step + '/' + count + '/' + uiLang() + '/' + (isOffline() ? 'off' : 'on');
  if (key === _lastProgress) return;
  _lastProgress = key;
  const dots = briefRail().map(r =>
    `<span aria-hidden="true">${r.index <= step ? '●' : '○'}</span>`).join('');
  host.innerHTML = offlineBanner() +
    `<div class="spread" style="padding:var(--space-3) 0">
       <span class="mono" aria-hidden="true" style="letter-spacing:3px">${dots}</span>
       <span class="micro">${esc(bt('stepOf', step + 1, count))}</span>
     </div>`;
}

/* Step one. The four verticals are tiles, not dropdown rows, and the full
   industry list stays underneath for everyone the four do not describe. */
function drawVerticals(){
  const host = briefSlot('briefVerticals', '[data-step="0"]', '.grid2');
  if (!host) return;
  setHTML(host,
    `<h6 style="margin-bottom:var(--space-2)">${esc(bt('trade'))}</h6>
     <div class="tiles" id="verticalTiles" style="border-top:1px solid var(--hair)">
       ${VERTICALS.map(v => `<button class="tile" data-vert="${v.id}" role="button" tabindex="0"
            aria-pressed="${state.vertical === v.id}">
            <span class="tiletitle">${esc(v.label)}</span>
            <span class="tilemeta">${esc(v.carries)}</span>
          </button>`).join('')}
     </div>
     <p class="lede" style="font-size:12.5px;margin-top:var(--space-3)">${esc(bt('tradeNote'))}</p>`);
  bindTiles('#verticalTiles [data-vert]', tile => {
    const applied = applyVertical(tile.dataset.vert);
    if (!applied) return;
    state.vertical = applied.id;
    state.industry = applied.industry;
    state.personality = applied.personality;
    if (!state.scriptTouched) state.script = applied.script;
    writeForm(applied.content);
    const ind = $('#i_industry'); if (ind) ind.value = state.industry;
    const scr = $('#i_script');   if (scr) scr.value = state.script;
    markDirty(); draw();
  });
}

/* Step four. The chips are built once and thereafter only have their state
   attributes updated, so operating them from the keyboard does not throw
   focus away on the redraw. */
function drawPersonality(){
  const chips = $('#i_personality');
  if (!chips) return;
  const want = AXES.map(a =>
    `<button class="chip" data-ax="${a}" aria-pressed="${state.personality.includes(a)}">${esc(AXIS_WORD[a])}</button>`).join('');
  if (!chips.querySelectorAll || chips.querySelectorAll('[data-ax]').length !== AXES.length)
    setHTML(chips, want);
  else
    chips.querySelectorAll('[data-ax]').forEach(x =>
      x.setAttribute('aria-pressed', String(state.personality.includes(x.dataset.ax))));
  /* A fourth chip is never marked disabled, and never actually is. The point
     of the cap message is that the tap lands and is answered; a chip that
     announces itself as unavailable would swallow the tap again, which is
     finding F8 restated in ARIA rather than fixed. The group is described by
     the live region instead, so the limit is heard without being enforced by
     making a control inert. */
  if (chips.setAttribute) chips.setAttribute('aria-describedby', 'briefPersCap');

  chips.onclick = e => {
    const b = e.target.closest && e.target.closest('[data-ax]');
    if (!b) return;
    const r = personalityTap(state.personality, b.dataset.ax);
    state.personality = r.personality;
    state.capMessage = r.message;
    markDirty(); draw();
    const again = $(`#i_personality [data-ax="${b.dataset.ax}"]`);
    if (again && again.focus) again.focus();
  };

  const cap = briefSlot('briefPersCap', '[data-step="3"]');
  if (cap){
    if (cap.setAttribute){ cap.setAttribute('role','status'); cap.setAttribute('aria-live','polite'); }
    setHTML(cap, state.capMessage
      ? `<div class="check"><span class="ico i-review">${ICON.review}</span><span>${esc(state.capMessage)}</span></div>`
      : '');
  }
  const note = $('#persNote');
  if (note) note.textContent = state.personality.length
    ? `${state.personality.length} of ${PERSONALITY_CAP} — ${state.personality.map(a => AXIS_WORD[a]).join(', ')}`
    : 'Nothing selected. The system will infer from the industry instead, and say so.';
}

/* Choosing a script by hand is what stops the bilingual default from being
   reapplied, so the flag is set at the point of the choice. */
function bindScript(){
  const el = $('#i_script');
  if (!el) return;
  el.oninput = e => {
    state.script = e.target.value;
    state.scriptTouched = true;
    markDirty(); draw();
  };
}

/* The thumb zone. Wireframing §4 anchors the primary action to the bottom of
   the screen; §5.3 puts the skip next to it, visible, because a default the
   user cannot see is not an option they have been offered. The shell already
   pins an `.actionbar` to the brief, so the brief fills that one rather than
   stacking a second bar underneath it, and falls back to making its own only
   if the shell ever stops providing one. */
function briefBarHost(){
  const shellBar = $('[data-screen="brief"] .actionbar');
  if (shellBar) return { el:shellBar, wrap:false };
  const own = briefSlot('briefBar', '[data-screen="brief"]');
  return own ? { el:own, wrap:true } : null;
}

/* The hint sits above the bar rather than inside it, because inside it is
   hidden on a phone — and a phone is where "a full name, first" is the whole
   reason the button is disabled. */
function briefHintEl(bar){
  let el = $('#briefHint');
  if (el) return el;
  if (!bar || !bar.parentNode || !bar.parentNode.insertBefore) return null;
  el = document.createElement('p');
  el.id = 'briefHint'; el.className = 'micro';
  bar.parentNode.insertBefore(el, bar);
  return el;
}

function drawBriefBar(step, count, def, last, nameOk){
  const host = briefBarHost();
  if (!host) return;

  const skippable = !def.required && !last;
  const blocked = !nameOk && (def.required || last);
  const hint = blocked ? bt('nameNeeded')
             : skippable ? def.fallback
             : def.required || last ? '' : bt('optional');

  const hintEl = briefHintEl(host.el);
  if (hintEl) hintEl.textContent = hint || '';

  const inner =
    `<button class="btn" id="bb_back" ${step === 0 ? 'disabled' : ''}>${ICON.prev} ${esc(t('back'))}</button>` +
    (skippable ? `<button class="btn btn-ghost" id="bb_skip">${esc(t('skip'))}</button>` : '') +
    `<button class="btn btn-primary btn-lg" id="bb_next" ${blocked ? 'disabled' : ''}>${
       last ? esc(bt('compose')) : esc(t('continue'))} ${ICON.next}</button>`;
  setHTML(host.el, host.wrap ? bottomBar(inner) : inner);

  const back = $('#bb_back'), skip = $('#bb_skip'), next = $('#bb_next');
  if (back) back.onclick = () => { state.step = Math.max(0, state.step - 1); draw(); };
  if (skip) skip.onclick = () => {
    if (state.skipped.indexOf(def.key) < 0) state.skipped.push(def.key);
    state.step = Math.min(count - 1, state.step + 1); draw();
  };
  if (next) next.onclick = () => {
    const i = state.skipped.indexOf(def.key);
    if (i >= 0) state.skipped.splice(i, 1);
    if (last) beginGenerate(); else { state.step = state.step + 1; draw(); }
  };
}

/* What the brief already implies, recomputed as it is typed. Nothing here is
   a choice yet; it exists so the user can see the consequences of an answer
   before the composer acts on it. */
function drawImplies(){
  const el = $('#implies');
  if (!el) return;
  const intent = resolveIntent({ industry:state.industry, personality:state.personality });
  const lux = state.personality.includes('premium') || state.personality.includes('traditional');
  setHTML(el, [
    ['Reading', intent.note],
    ['Script', { latin:'English front, বাংলা back', bangla:'বাংলা front, English back',
                 'latin-only':'English only', 'bangla-only':'বাংলা only' }[state.script]],
    ['Type floor', (state.script === 'latin-only') ? '6.0 pt' : '7.5 pt — Bangla conjuncts'],
    ['Palette', lux ? 'Dark ground, one metal' : 'High contrast, restrained'],
    ['Finishes', state.finishes.map(f => FINISH_COST[f].label).join(' · ') || 'None yet'],
    ['Run', `${state.qty} cards`]
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join(''));
}

/* The last step. A skipped step is named here with the default it took, so
   "skippable" never means "quietly decided for you". */
function drawReview(content){
  const el = $('#reviewKv');
  if (!el) return;
  const skipped = BRIEF_STEPS.filter(s => state.skipped.indexOf(s.key) >= 0);
  setHTML(el, [
    ['Name', content.name || '—'], ['Role', content.role || '—'],
    ['Company', content.company || '—'],
    ['বাংলা', content.bname || '—'],
    ['Routes', [content.p1, content.p2, content.email, content.web].filter(Boolean).length + ' collected'],
    ['Industry', INDUSTRIES[state.industry].label],
    ['Personality', state.personality.map(a => AXIS_WORD[a]).join(' · ') || 'inferred'],
    ['Script', BILINGUAL_SCRIPTS.indexOf(state.script) >= 0 ? 'Bangla and English' : 'One script only'],
    ['Size', FORMATS.find(f => f.id === state.format).name],
    ['Logo', state.logo ? 'Accepted' : 'Monogram from the company name'],
    [bt('skipped'), skipped.length ? skipped.map(s => s.rail).join(' · ') : 'nothing skipped']
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join(''));
}

/* ── Generating ───────────────────────────────────────────────────────────
   Master PRD Epic B: if the engine finishes in 400ms the result is shown in
   400ms, and the numbers are the engine's own counts for this brief. The
   shell's `runGenerate` reveals six stages on a 70ms timer after generation
   has already finished, which is precisely the artificial delay the PRD
   forbids, so the brief drives its own run: paint the pending state, let the
   browser show it, compose, then hand over on the next frame. Nothing waits
   on a clock, and the counts below are read straight off the result. */
function beginGenerate(){
  const content = readForm();
  state.gen = null; state.genStage = 0;
  state.pick = 0; state.refine = null; state.history = []; state.instrLog = [];
  go('generating');

  const compose_ = () => {
    const front = (state.script === 'bangla' || state.script === 'bangla-only') ? 'bangla' : 'latin';
    state.gen = generate({ industry:state.industry, personality:state.personality,
      format:state.format, density:state.density, script:front }, content);
    state.genStage = 99;
    if (!state.gen.picked.length){ go('noresults'); return; }
    draw();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => go('concepts'));
    else go('concepts');
  };
  /* Two frames, because one only guarantees the pending state is scheduled;
     the second guarantees it was actually painted before the main thread is
     blocked by the composer. */
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => requestAnimationFrame(compose_));
  else compose_();
}

/** Every row is a count the engine produced while composing this brief. None
    of them is a literal, and there is no row for work the engine does not
    actually do. */
function generatingRows(g){
  if (!g) return [];
  return [
    ['Candidates enumerated', g.stages.enumerated, 'every layout × palette × type system'],
    ['Survived the fit ladder', g.stages.composed, 'the rest could not hold your text at the print floor'],
    ['Print-safe', g.stages.printSafe, 'no blocking preflight finding'],
    ['Ranked against your brief', g.considered, 'personality, industry, print safety, legibility'],
    ['Selected', g.stages.selected, 'after the diversity rule']
  ];
}

function drawGenerating(){
  const host = $('#pipeline');
  if (!host) return;
  const g = state.gen;
  if (!g){ setHTML(host, pendingBlock(bt('composing')) +
    `<p class="lede" style="font-size:12.5px">${esc(bt('genPending'))}</p>`); return; }

  /* The shell's staged reveal is still reachable from the stage rail, so the
     row state honours `genStage`; the brief's own run sets it past the end,
     which shows every real count at once. */
  const rows = generatingRows(g);
  setHTML(host, rows.map(([label, count, note], i) => {
    const done = state.genStage >= 99 || state.genStage > i;
    const now = state.genStage === i;
    return `<div class="check ${done ? 'stage' : ''}" style="${done ? '' : 'opacity:.32'}">
      <span class="ico ${done ? 'i-pass' : ''} ${now ? 'ticking' : ''}">${done ? ICON.pass : ICON.dot}</span>
      <span>${esc(label)}<span class="note mono">${done ? esc(String(count)) + ' — ' + esc(note) : ''}</span></span>
    </div>`;
  }).join('') +
    `<p class="micro" style="margin-top:var(--space-4)">${esc(bt('genMs', g.ms))}${
      state.genStage >= 99 ? ' ' + esc(bt('genHonest')) : ''}</p>`);
}

/* ── Start ────────────────────────────────────────────────────────────────
   Wireframing §5.1 puts the language toggle here rather than inside the
   brief: a UI that defaults to English before it has asked is itself a small
   English-first bias in a market that is majority Bangla. The code field
   next to it reloads the page against the saved design, which reuses the
   shell's own restore path rather than growing a second one. */
function drawStart(){
  seedBriefScript();
  drawStartControls();

  const sentenceEl = $('#i_sentence');
  const r = readSentence(sentenceEl ? sentenceEl.value : '');

  setHTML($('#startExamples'), [
    'I am a medicine consultant with a chamber in Dhanmondi',
    'I run a knitwear buying house in Uttara dealing with European buyers',
    'আমি নিউ মার্কেটে একটি ইলেকট্রনিক্সের দোকান চালাই',
    'I am an advocate practising at the Supreme Court'
  ].map(x => `<button class="chip chip-sm" data-ex="${esc(x)}">${esc(x)}</button>`).join(''));
  $$('#startExamples .chip').forEach(b =>
    b.onclick = () => { if (sentenceEl) sentenceEl.value = b.dataset.ex; draw(); });

  const conf = v => v ? 'High' : 'Low';
  setHTML($('#inferred'), [
    ['Industry', r.industry ? INDUSTRIES[r.industry].label : 'not stated — step 01 asks', conf(r.industry)],
    ['Personality', r.personality.length ? r.personality.map(a => AXIS_WORD[a]).join(' · ') : 'not stated — step 04 asks', conf(r.personality.length)],
    ['Script', r.script ? 'বাংলা detected' : 'bilingual by default — step 05 can change it', conf(r.script)],
    ['Card size', FORMATS.find(f => f.id === state.format).name, 'High'],
    ['Budget', 'not stated — step 06 asks', 'Low']
  ].map(([k, v, c]) =>
    `<div class="check"><span style="flex:1">${k}<span class="note">${esc(v)}</span></span>
     <span class="pill ${c === 'High' ? 'pill-ok' : 'pill-warn'}">${c}</span></div>`).join(''));

  const go_ = $('#b_startgo');
  if (go_){
    go_.textContent = t('start');
    go_.onclick = () => {
      const s = readSentence(sentenceEl ? sentenceEl.value : '');
      if (s.industry){ state.industry = s.industry; const el = $('#i_industry'); if (el) el.value = s.industry; }
      if (s.personality.length) state.personality = s.personality.slice(0, PERSONALITY_CAP);
      state.script = s.script === 'bangla' ? 'bangla' : briefScriptDefault();
      const scr = $('#i_script'); if (scr) scr.value = state.script;
      const chips = $('#i_personality');
      if (chips && chips.querySelectorAll)
        chips.querySelectorAll('[data-ax]').forEach(x =>
          x.setAttribute('aria-pressed', String(state.personality.includes(x.dataset.ax))));
      state.step = 0; state.skipped = []; markDirty(); go('brief');
    };
  }
}

/* The toggle and the code field. Both are rendered here because the Start
   screen's markup belongs to the shell, and neither should wait on it. */
function drawStartControls(){
  const host = briefSlot('startControls', '[data-screen="start"] .pane');
  if (!host) return;
  const lang = uiLang();
  setHTML(host,
    `<hr class="hair">
     <div class="spread" style="flex-wrap:wrap;gap:var(--space-4)">
       <div class="seg" id="startLang" role="group" aria-label="${esc(bt('language'))}">
         <button data-lang="bn" lang="bn" aria-pressed="${lang === 'bn'}">বাংলা</button>
         <button data-lang="en" aria-pressed="${lang === 'en'}">English</button>
       </div>
       <div class="row" id="startCode">
         <label class="micro" for="i_code">${esc(bt('haveCode'))}</label>
         <input class="input" id="i_code" style="max-width:190px" inputmode="latin"
                aria-label="${esc(bt('codeLabel'))}" placeholder="a1b2c3">
         <button class="btn" id="b_opencode">${esc(bt('openDesign'))}</button>
       </div>
     </div>
     <p class="micro" id="codeOut" role="status" aria-live="polite"></p>

     <!-- The second way in. The founder's own framing is that people arrive
          holding a card a shop already made for them; that customer met a
          screen offering only "start a brief", and the two features built for
          them lived in a nav menu they had no reason to open. An entry point
          nobody is shown is an entry point nobody uses. -->
     <hr class="hr">
     <h6>${esc(bt('haveCard'))}</h6>
     <p class="lede" style="font-size:12.5px;max-width:58ch">${esc(bt('haveCardNote'))}</p>
     <div class="row" style="gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-3)">
       <button class="btn" data-start-go="enhance">${esc(bt('enhanceIt'))}</button>
       <button class="btn" data-start-go="destructure">${esc(bt('takeApart'))}</button>
     </div>`);

  $$('#startControls [data-start-go], [data-screen="start"] [data-start-go]')
    .forEach(b => b.onclick = () => go(b.dataset.startGo));

  $$('#startLang [data-lang]').forEach(b => b.onclick = () => {
    _lastProgress = null;              // the counter is bilingual; force a repaint
    setUiLang(b.dataset.lang);
  });
  const open = $('#b_opencode');
  if (open) open.onclick = () => {
    const el = $('#i_code');
    const code = ((el && el.value) || '').trim().toLowerCase();
    const out = $('#codeOut');
    if (!/^[0-9a-f]{6,16}$/.test(code)){ if (out) out.textContent = bt('badCode'); return; }
    if (out) out.textContent = '';
    if (typeof location !== 'undefined' && location.assign) location.assign('?c=' + encodeURIComponent(code));
  };
}
