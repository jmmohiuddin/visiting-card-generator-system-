/* ══════════════════════════════════════════════════════════════════════════
   CARDWORKS — concepts, detail and typed refinement
   --------------------------------------------------------------------------
   The six results, one concept in detail, and the typed-instruction surface.
   Loaded as a classic script after engine.js and ui-shell.js; top-level
   declarations share one global scope, so ordering in index.html matters.

   This is the moment the product's central promise is made or broken, so the
   three rules below are load-bearing rather than stylistic.

   PRD Decision 1 — there is no canvas here and there never will be. Nothing
   on these screens can move, resize or recolour an element. Every control,
   typed or tapped, emits an operation from the closed set in engine.js, and
   an operation re-selects a component and re-composes. That is what keeps
   the print guarantee true after a refinement, not only before one.

   PRD Epic B — every number shown is one the engine computed for this brief.
   A score that survives a change of brief is a shipped defect, so the tiles
   read `c.score` directly and carry it in `data-score-total` where it can be
   checked from outside.

   PRD Epic B, second half — an explanation may cite what the user stated. An
   industry prior is something the system inferred, and it is labelled as
   inferred. See `intentDisclosure` for the engine defect this works around.

   The three screens render their own markup into the sections `index.html`
   reserves for them, because the shell is owned by another subgroup and the
   markup for a result set that changes shape with the format cannot usefully
   live in a static document.
   ══════════════════════════════════════════════════════════════════════ */

/* Layout-critical rules only. Everything cosmetic comes from app.css; these
   are the few properties this surface cannot be correct without, so they
   travel with the code that depends on them. The 2-up grid at 360px is a
   requirement of Wireframing §5.5, not a preference. */
const B3_CSS = `
.b3-grid{display:grid;gap:0;grid-template-columns:repeat(2,minmax(0,1fr))}
.b3-said{font-size:13.5px;line-height:1.5}
.b3-quote{font-family:var(--font-mono);font-size:12.5px;padding:9px 11px;
  border-left:3px solid var(--color-accent);background:var(--color-neutral-100);
  overflow-wrap:anywhere}
.b3-bn{font-family:var(--font-bn)}
.b3-alts{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--space-3)}
.b3-gone{font-size:12px;color:var(--muted);line-height:1.55}
.b3-facepair{display:flex;flex-wrap:wrap;gap:var(--space-4)}
.b3-facepair > *{flex:1 1 240px;min-width:0}
@media (min-width:760px){.b3-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
`;
function b3Style(){
  /* The engine suite evaluates these files against a DOM stub with no head,
     so the surface has to be inert rather than throwing when there is no
     document to paint into. */
  if (typeof document.getElementById !== 'function' || !document.head) return;
  if (document.getElementById('b3-style')) return;
  const s = document.createElement('style');
  s.id = 'b3-style'; s.textContent = B3_CSS;
  document.head.appendChild(s);
}
/* Paint into the section the shell reserves. Returning the element rather
   than a selector keeps every id in this file addressable only after the
   markup that owns it exists. */
function b3Paint(screen, html){
  b3Style();
  const sec = document.querySelector(`[data-screen="${screen}"]`);
  if (sec) sec.innerHTML = html;
  return sec;
}
const b3Lang = () => (typeof uiLang === 'function' && uiLang() === 'bn') ? 'bn' : 'en';
const pick2 = (lang, en, bn) => lang === 'bn' ? bn : en;

/* ─────────────────── STATED VERSUS INFERRED — the audit ───────────────────
   PRD Epic B: a "why" may cite preferences the user actually stated, and an
   inferred preference must say so explicitly rather than being attributed to
   the user. `resolveIntent` in engine.js gets this right in exactly one of
   the two cases.

   When nothing is stated it sets `inferredFrom` and `explain` opens with
   "You did not state a personality, so this is ranked on what a doctor /
   chamber card usually needs" — correct, and nothing here overrides it.

   When something IS stated it sets `inferredFrom: null` and throws the
   industry's contribution away, even though `resolveIntent` folded that
   industry prior into the same vector at half weight and `scoreCandidate`
   still applies the industry's `avoid` list as a hard exclusion. `explain`
   then says "You asked for premium and bold. This composition scores 80/100
   against that brief" — but that brief is not what the user said. Three of
   its five non-zero axes came from the doctor prior, and `bold`, which the
   user did state, is on that prior's avoid list and is being penalised by
   20% of the score with no mention of it anywhere.

   The engine cannot be edited from here, so the contribution is recomputed
   from the same library records `resolveIntent` read, and the surface says
   plainly which half of the brief is the user's and which half is ours. */
function intentDisclosure(intent){
  const ind = INDUSTRIES[state.industry] || { label:null, prior:{}, avoid:[] };
  const stated = (intent.stated || []).filter(a => AXES.includes(a));
  const inferred = AXES
    .filter(a => (ind.prior[a] || 0) > 0 && !stated.includes(a))
    .sort((a,b) => ind.prior[b] - ind.prior[a]);
  const avoid = (intent.avoid || []).filter(a => AXES.includes(a));
  return { stated, inferred, avoid, industry: ind.label,
           conflicts: stated.filter(a => avoid.includes(a)),
           /* True only when the engine's own sentence is safe to print as
              written: nothing stated (it discloses the inference itself), or
              nothing inferred (there is nothing to disclose). */
           engineHonest: !stated.length || !inferred.length };
}

/* `explain` builds its clauses with `out.join('. ')`, and the clause this
   surface has to replace is the first one, which itself contains a full
   stop. Splitting on the sentence separator would cut it in half, so the
   split is on the phrase that ends it — the one string in `explain` that is
   only ever emitted by the clause being corrected. */
const B3_CONFLATED_TAIL = 'against that brief. ';
function traceClausesAfterOpening(why){
  const i = String(why || '').indexOf(B3_CONFLATED_TAIL);
  return i < 0 ? '' : why.slice(i + B3_CONFLATED_TAIL.length);
}

/* The corrected opening. Every number in it is the engine's: `personality`
   is the cosine the ranker used, and the axis names come from the library
   records the ranker read. */
function whyBlock(cand, intent, lang){
  const d = intentDisclosure(intent);
  const words = a => AXIS_WORD[a] || a;
  const pct = (cand.score.parts.personality * 100).toFixed(0);
  const rows = [];

  if (d.engineHonest){
    rows.push(`<p class="b3-said">${esc(cand.why)}</p>`);
  } else {
    rows.push(`<p class="b3-said">${esc(pick2(lang,
      `You stated ${d.stated.map(words).join(' and ')}. This composition scores ${pct}/100 on personality — but that number is measured against your words and the ${d.industry.toLowerCase()} prior together, not against your words alone.`,
      `আপনি বলেছেন ${d.stated.map(words).join(' এবং ')}। এই কম্পোজিশনের ব্যক্তিত্ব স্কোর ${pct}/১০০ — তবে সেটি আপনার কথা ও ${d.industry} প্রায়োরিটি দুটো মিলিয়ে মাপা, শুধু আপনার কথার বিপরীতে নয়।`))}</p>`);
    rows.push(checkRow({ s:'review',
      label: pick2(lang,
        `Inferred, not stated: ${d.inferred.map(words).join(' · ')}`,
        `অনুমান করা, আপনি বলেননি: ${d.inferred.map(words).join(' · ')}`),
      note: pick2(lang,
        `These came from the ${d.industry} prior at half weight because that is the industry on the brief. You did not ask for them.`,
        `${d.industry} শ্রেণির জন্য এগুলো অর্ধেক ওজনে যোগ হয়েছে। আপনি এগুলো চাননি।`) }));
    const rest = traceClausesAfterOpening(cand.why);
    if (rest) rows.push(`<p class="b3-said">${esc(rest)}</p>`);
  }

  if (d.conflicts.length){
    rows.push(checkRow({ s:'review',
      label: pick2(lang,
        `You stated ${d.conflicts.map(words).join(' and ')}, and a ${String(d.industry).toLowerCase()} card excludes it`,
        `আপনি ${d.conflicts.map(words).join(' এবং ')} চেয়েছেন, কিন্তু ${d.industry} কার্ডে সেটি বাদ`),
      note: pick2(lang,
        `The industry dimension is 20% of the score and it is scoring these compositions down, not up. Change the industry if that is wrong.`,
        `শিল্প বিভাগ স্কোরের ২০% এবং সেটি এই কম্পোজিশনগুলোকে নামাচ্ছে, ওঠাচ্ছে না। শ্রেণি ভুল হলে বদলান।`) }));
  } else if (d.avoid.length){
    rows.push(`<p class="lede" style="font-size:12px">${esc(pick2(lang,
      `A ${String(d.industry).toLowerCase()} card also excludes ${d.avoid.map(words).join(' and ')} outright — inferred from the industry, not from anything you said.`,
      `${d.industry} কার্ডে ${d.avoid.map(words).join(' এবং ')} পুরোপুরি বাদ — এটি শ্রেণি থেকে অনুমান করা, আপনার বলা নয়।`))}</p>`);
  }
  return rows.join('');
}

/* ──────────────── PLAIN LANGUAGE FOR A CLOSED-SET OPERATION ────────────────
   Wireframing §5.7 asks the success case to state the operation performed in
   plain language rather than "done". The sentences below are the only place
   an operation is described, and each one says what the operation actually
   did to the SPEC — which for `promoteSlot` means saying out loud that the
   type was not scaled where it stood. */
const nameOfLayout  = id => LAYOUTS.find(l => l.id === id)?.name || id;
const nameOfPalette = id => PALETTES.find(p => p.id === id)?.name || id;
const nameOfType    = id => TYPE_SYSTEMS.find(t => t.id === id)?.name || id;
const nameOfFormat  = id => FORMATS.find(f => f.id === id)?.name || id;
const nameOfFinish  = id => FINISH_COST[id]?.label || id;

const SHIFT_WORD = { dark:['darkest','সবচেয়ে গাঢ়'], light:['lightest','সবচেয়ে হালকা'],
  saturated:['most saturated','সবচেয়ে রঙিন'], muted:['most muted','সবচেয়ে নরম'] };
/* Slot refs are engine identifiers. Naming one back to the user in Bangla is
   a translation of the field, not of the identifier — the operation still
   carries `name`, and the row below the sentence still prints it. */
const SLOT_WORD = { name:'নাম', role:'পদবি', company:'প্রতিষ্ঠান', contact:'যোগাযোগ',
                    mark:'মনোগ্রাম', qr:'কিউআর' };
const refWord = (ref, lang) => lang === 'bn' ? (SLOT_WORD[ref] || ref) : ref;
/* Bengali numerals on a Bangla face are the standard, not a nicety —
   engine.js encodes the same rule for the card itself. */
const num = (n, lang) => lang === 'bn' ? toBnDigits(n) : String(n);

function saidInWords(op, arg, after, lang){
  const L = () => nameOfLayout(after.layout);
  switch (op){
    case 'promoteSlot': return pick2(lang,
      `Promoted “${arg}” to a layout with more room — ${L()}. The type was not scaled in place; the composition was re-selected and re-composed around it.`,
      `“${refWord(arg, lang)}” বেশি জায়গা আছে এমন বিন্যাসে তোলা হয়েছে — ${L()}। টাইপ জায়গায় বড় করা হয়নি; পুরো কম্পোজিশন নতুন করে বসানো হয়েছে।`);
    case 'demoteSlot': return pick2(lang,
      `Demoted “${arg}” to the composition that gives it the least prominence — ${L()}. The type was not shrunk in place; the layout changed.`,
      `“${refWord(arg, lang)}” সবচেয়ে কম প্রাধান্য পায় এমন কম্পোজিশনে নামানো হয়েছে — ${L()}। টাইপ ছোট করা হয়নি; বিন্যাস বদলেছে।`);
    case 'setPalette': return pick2(lang,
      `Palette set to ${nameOfPalette(arg)}, and the card re-composed on it.`,
      `রঙ ${nameOfPalette(arg)} করা হয়েছে এবং কার্ড নতুন করে বসানো হয়েছে।`);
    case 'shiftPalette': {
      const w = SHIFT_WORD[arg] || [arg, arg];
      return pick2(lang,
        `Moved to the ${w[0]} palette in the library — ${nameOfPalette(after.palette)}.`,
        `লাইব্রেরির ${w[1]} রঙে সরানো হয়েছে — ${nameOfPalette(after.palette)}।`); }
    case 'setTypeSystem':
    case 'shiftType': return pick2(lang,
      `Type system set to ${nameOfType(after.type)}. Both scripts change together, because a type system always declares a Bangla family.`,
      `টাইপ সিস্টেম ${nameOfType(after.type)} করা হয়েছে। দুই লিপি একসাথে বদলায়, কারণ প্রতিটি টাইপ সিস্টেমে বাংলা ফ্যামিলি থাকে।`);
    case 'setLayout': return pick2(lang,
      `Composition changed to ${L()} and the content re-fitted into its slots.`,
      `কম্পোজিশন ${L()} করা হয়েছে এবং লেখা নতুন স্লটে বসানো হয়েছে।`);
    case 'setLayoutFamily': return pick2(lang,
      `Re-selected a ${arg} composition — ${L()}.`,
      `${arg} ঘরানার কম্পোজিশন বেছে নেওয়া হয়েছে — ${L()}।`);
    case 'setDensity': return pick2(lang,
      `Density set to ${arg}. This scales the whole type ramp before fitting, never one field after it.`,
      `ঘনত্ব ${arg} করা হয়েছে। এটি ফিট করার আগে পুরো টাইপ র‍্যাম্প বদলায়, পরে একটি ফিল্ড নয়।`);
    case 'setCorner': return pick2(lang,
      `Corner radius set to ${Number(arg) || 0} mm. That is a die, not a border — the safe area is re-checked against it.`,
      `কোণের ব্যাসার্ধ ${num(Number(arg) || 0, lang)} মিমি। এটি ডাই, বর্ডার নয় — নিরাপদ এলাকা আবার যাচাই হয়েছে।`);
    case 'moveSlotToBack': return pick2(lang,
      `Contact routes moved to the back face, and the front re-composed onto ${L()}, which has no contact slot to crowd.`,
      `যোগাযোগের তথ্য পিছনের পিঠে সরানো হয়েছে এবং সামনের দিক ${L()}-এ বসানো হয়েছে, যেখানে যোগাযোগের স্লট নেই।`);
    case 'setBack': return pick2(lang,
      `Back face set to ${nameOfLayout(arg)}.`,
      `পিছনের পিঠ ${nameOfLayout(arg)} করা হয়েছে।`);
    case 'setScript': return pick2(lang,
      `Front face set to ${arg === 'bangla' ? 'Bangla' : 'Latin'} — the per-script floor, line height and tracking rules change with it.`,
      `সামনের দিক ${arg === 'bangla' ? 'বাংলা' : 'ল্যাটিন'} করা হয়েছে — লিপি-ভিত্তিক ন্যূনতম আকার, লাইন উচ্চতা ও ট্র্যাকিং সঙ্গে বদলেছে।`);
    case 'setFormat': return pick2(lang,
      `Format set to ${nameOfFormat(arg)}. Layouts with no authored composition for that shape are removed, not stretched.`,
      `আকার ${nameOfFormat(arg)} করা হয়েছে। যে বিন্যাসের ওই আকারের জন্য আলাদা কম্পোজিশন লেখা নেই, তা টেনে বড় না করে বাদ দেওয়া হয়েছে।`);
    case 'addFinish': return pick2(lang,
      `${nameOfFinish(arg)} added to the finishes. Preflight will re-check its trim clearance.`,
      `${nameOfFinish(arg)} যোগ হয়েছে। প্রিফ্লাইট আবার কাটার দূরত্ব যাচাই করবে।`);
    case 'removeFinish': return pick2(lang,
      `${nameOfFinish(arg)} removed from the finishes.`,
      `${nameOfFinish(arg)} বাদ দেওয়া হয়েছে।`);
    default: return `${op}(${arg})`;
  }
}

/* ───────────────────── UNMAPPED — the case that matters ─────────────────────
   Wireframing §5.7's second frame. Zero operations, an honest message, and
   alternatives that are REAL: every one is drawn from `EDIT_RULES`, which is
   the only table the classifier can ever match, so a suggestion the user
   takes is guaranteed to map to something.

   Close alternatives are found by looking for a near-miss — a word in the
   instruction that is one or two edits away from a keyword the classifier
   knows. "premum look" is not a guess the system should act on, but it is a
   typo it can name. Where there is no near-miss the menu is the capability
   list, unfiltered and unranked, because pretending to rank it would be a
   guess of a different kind. */
const B3_RULE_BN = {
  'more premium':'আরও প্রিমিয়াম', 'more minimal':'আরও সাদামাটা', 'less crowded':'কম ভিড়',
  'bigger name':'নাম বড় করুন', 'smaller name':'নাম ছোট করুন', 'more technical':'আরও প্রযুক্তিগত',
  'more corporate':'আরও কর্পোরেট', 'more traditional':'আরও ঐতিহ্যবাহী', 'bolder':'আরও জোরালো',
  'darker':'আরও গাঢ়', 'lighter':'আরও হালকা', 'more colour':'আরও রঙিন', 'more muted':'আরও নরম',
  'QR on the back':'পিছনে কিউআর', 'add gold foil':'সোনালি ফয়েল', 'add spot UV':'স্পট ইউভি',
  'portrait format':'খাড়া আকার', 'landscape format':'শোয়ানো আকার', 'Bangla face':'বাংলা পিঠ',
  'English face':'ইংরেজি পিঠ', 'serif type':'সেরিফ টাইপ', 'monospaced type':'মনোস্পেস টাইপ',
  'tighter':'আরও ঘন', 'rounded corners':'গোল কোণ', 'square corners':'সোজা কোণ',
  'contact on the back':'যোগাযোগ পিছনে'
};
const ruleLabel = (label, lang) => pick2(lang, label, B3_RULE_BN[label] || label);

/* Keywords the classifier actually holds, read off its own patterns so this
   list cannot drift away from what the classifier will match. Splitting a
   pattern on its metacharacters also yields fragments — `colou?rful` gives
   back "rful" — so a candidate is kept only if the rule itself matches it or
   the rule's own label contains it. */
const B3_RULE_WORDS = EDIT_RULES.map(r => {
  const label = r.label.toLowerCase();
  const raw = [...new Set(String(r.re.source).split(/[^a-zঀ-৿]+/i).filter(w => w.length >= 4))];
  return { label:r.label, words: raw.filter(w => r.re.test(w) || label.includes(w.toLowerCase())) };
});
function editDistance(a, b){
  if (Math.abs(a.length - b.length) > 2) return 9;
  const prev = Array.from({length:b.length+1}, (_,j) => j);
  for (let i = 1; i <= a.length; i++){
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++){
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j-1] + 1, diag + (a[i-1] === b[j-1] ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
}
function nearMisses(text){
  const typed = String(text || '').toLowerCase().split(/[^a-zঀ-৿]+/i).filter(w => w.length >= 4);
  const hits = new Map();
  for (const w of typed){
    for (const r of B3_RULE_WORDS){
      for (const k of r.words){
        const d = editDistance(w, k.toLowerCase());
        if (d === 0 || d > 2 || d > Math.floor(k.length / 3)) continue;
        const prev = hits.get(r.label);
        if (!prev || d < prev.d) hits.set(r.label, { d, typed:w, meant:k });
      }
    }
  }
  return [...hits.entries()].sort((a,b) => a[1].d - b[1].d).slice(0, 3)
    .map(([label, m]) => ({ label, ...m }));
}
/* The capability menu. Ordered by what a user on this screen most often
   wants, not by anything the system computed — and it is the whole list of
   headline capabilities, so it is a menu rather than a suggestion. */
const B3_MENU = ['more premium','less crowded','bigger name','more traditional',
                 'darker','more colour','QR on the back','contact on the back',
                 'portrait format','Bangla face'];

/* An alternative offered after a refusal is a promise, so it is checked
   rather than asserted: a label survives into the menu only if typing it
   back into `classifyInstruction` produces the rule it came from. This is
   what catches the Bangla gap — five of the twenty-six rules carry no Bangla
   pattern at all, so their Bangla glosses classify as unmapped and are not
   offered to a Bangla user as though they would work. */
const _menuCache = {};
function menuFor(lang){
  if (_menuCache[lang]) return _menuCache[lang];
  return (_menuCache[lang] = B3_MENU.filter(label =>
    (classifyInstruction(ruleLabel(label, lang)).matched || []).includes(label)));
}
/* Rules whose pattern contains no Bangla at all. Named on the screen rather
   than quietly omitted, because a Bangla user finding out by trial that the
   product only half-speaks their language is worse than being told. */
const B3_EN_ONLY = EDIT_RULES.filter(r => !/[ঀ-৿]/.test(String(r.re.source))).map(r => r.label);

function unmappedBlock(log){
  const lang = log.lang;
  const near = log.near || [];
  const head = pick2(lang,
    `I can’t do that. Nothing was changed, and nothing was guessed.`,
    `এটি আমি পারি না। কিছুই বদলানো হয়নি এবং কিছুই অনুমান করা হয়নি।`);
  const sub = near.length
    ? pick2(lang, `Did you mean one of these?`, `আপনি কি এগুলোর কোনোটি বোঝাতে চেয়েছেন?`)
    : pick2(lang, `Here is what it can change instead:`, `এর বদলে যা যা বদলাতে পারি:`);
  const list = near.length ? near.map(n => n.label) : menuFor(lang);
  const gap = lang === 'bn' && B3_EN_ONLY.length
    ? `<p class="b3-gone" style="margin-top:var(--space-3)">${esc(
        `আরও ${num(B3_EN_ONLY.length, 'bn')}টি কাজ এখনো শুধু ইংরেজিতে চাওয়া যায়: ${B3_EN_ONLY.join(' · ')}।`)}</p>`
    : '';
  return checkRow({ s:'review', label:head,
      note: pick2(lang,
        `“${log.text}” does not map to any operation in the closed set, and a free-form change is not something this product has — see the note under the box.`,
        `“${log.text}” নির্ধারিত অপারেশনের কোনোটির সাথে মেলে না, আর ইচ্ছেমতো বদল এই পণ্যে নেই।`) })
    + `<p class="lede" style="font-size:12.5px;margin-top:var(--space-3)">${esc(sub)}</p>`
    + `<div class="b3-alts">` + list.map(label => {
        const n = near.find(x => x.label === label);
        return `<button class="chip chip-sm ${lang === 'bn' ? 'b3-bn' : ''}" data-alt="${esc(ruleLabel(label, lang))}"
          title="${esc(n ? `“${n.typed}” is ${n.d} edit${n.d > 1 ? 's' : ''} from “${n.meant}”` : label)}">${
          esc(ruleLabel(label, lang))}</button>`;
      }).join('') + `</div>` + gap;
}

/* ─────────────────────────── THE REFINE SURFACE ───────────────────────────
   One box, three screens. The literal instruction stays visible above the
   result on every one of them, because the thing a user needs to see first
   is not the outcome but what the system believed they said. */
function refineBox(idPrefix, placeholderKey){
  const lang = b3Lang();
  const ph = pick2(lang,
    'Make it more premium · Move contact to the back',
    'আরও প্রিমিয়াম করুন · নাম বড় করুন');
  return `<div class="field">
      <label class="lbl" for="${idPrefix}_text">${esc(pick2(lang,
        'Tell it what to change', 'কী বদলাতে হবে লিখুন'))}</label>
      <input class="input b3-bn" id="${idPrefix}_text" autocomplete="off"
        placeholder="${esc(ph)}" value="${esc(state.instrDraft || '')}">
      <p class="lede" style="font-size:12px;margin-top:var(--space-2)">${esc(pick2(lang,
        'English or Bangla. Every instruction resolves to a change in the component set — never a redraw, never a nudge.',
        'বাংলা বা ইংরেজি। প্রতিটি নির্দেশ কম্পোনেন্ট বদলে রূপ নেয় — কখনো নতুন করে আঁকা নয়, কখনো টেনে সরানো নয়।'))}</p>
    </div>
    <div class="row" style="margin-top:var(--space-3)">
      <button class="btn btn-primary" id="${idPrefix}_apply">${esc(pick2(lang,'Apply','প্রয়োগ করুন'))}</button>
    </div>`;
}

/* The result. Success states the operation; failure states the refusal. Both
   keep the instruction above them. */
function refineResult(log){
  if (!log) return '';
  const lang = log.lang || 'en';
  const quote = log.text
    ? `<div class="b3-quote ${lang === 'bn' ? 'b3-bn' : ''}">“${esc(log.text)}”</div>`
    : `<div class="b3-quote">${esc(pick2(lang, 'From the pickers', 'পিকার থেকে'))}</div>`;

  if (log.unmapped) return quote + unmappedBlock(log);

  const rows = log.ops.map(o =>
    checkRow({ s:'pass', label: saidInWords(o.op, o.arg, log.after || {}, lang),
               note: `${o.op}(${o.arg})` })).join('');
  const noop = !log.changes.length
    ? checkRow({ s:'review',
        label: pick2(lang, 'The design was already in that state, so nothing changed.',
                           'ডিজাইন আগে থেকেই ওই অবস্থায় ছিল, তাই কিছু বদলায়নি।'),
        note: pick2(lang, 'Reported rather than shown as a success — a no-op that looks like a change is the defect this screen exists to avoid.',
                          'সফল না দেখিয়ে সত্যটা বলা হলো — যে বদল হয়নি সেটিকে বদল দেখানোই এই পর্দার মূল ভুল।') })
    : log.changes.map(c => `<div class="check"><span class="ico">${ICON.dot}</span>
        <span class="mono" style="font-size:12px">${esc(c.key)}: ${esc(String(c.from))} → <b>${esc(String(c.to))}</b></span></div>`).join('');
  return quote + rows + noop;
}

/* Classify, apply, and record — the one path every typed instruction takes.
   `scope` names where the result landed so the log can be read honestly on a
   screen that is refining six designs rather than one. */
function runInstruction(text, opts = {}){
  const lang = /[ঀ-৿]/.test(String(text || '')) ? 'bn' : b3Lang();
  const cls = classifyInstruction(text);
  if (cls.empty) return null;
  if (cls.unmapped){
    /* Zero operations. Not a fallback, not a nearest match — the closed set
       is what bounds this product, and an instruction outside it produces
       nothing but an explanation. */
    const log = { ...cls, ops:[], changes:[], text:String(text).trim(), lang,
                  near: nearMisses(text), scope: opts.scope || 'design' };
    state.instrLog.push(log);
    return log;
  }
  const { design:next, changes } = applyOps(lastDesign, cls.ops);
  state.history.push({ ...lastDesign });
  state.refine = next;
  const log = { ...cls, changes, text:String(text).trim(), lang, after:next,
                scope: opts.scope || 'design' };
  state.instrLog.push(log);
  if (typeof markDirty === 'function') markDirty();
  return log;
}

function bindRefine(idPrefix, opts = {}){
  const input = document.getElementById(idPrefix + '_text');
  const run = () => {
    if (!input) return;
    state.instrDraft = '';
    const log = runInstruction(input.value, opts);
    if (log && opts.onApply) opts.onApply(log);
    draw();
  };
  if (input){
    input.oninput = e => { state.instrDraft = e.target.value; };
    input.onkeydown = e => { if (e.key === 'Enter'){ e.preventDefault(); run(); } };
  }
  const btn = document.getElementById(idPrefix + '_apply');
  if (btn) btn.onclick = run;
  /* An alternative offered on a refusal is only honest if taking it works.
     Clicking one runs it rather than typing it back at the user. */
  document.querySelectorAll(`[data-screen="${state.screen}"] [data-alt]`).forEach(b => {
    b.onclick = () => {
      state.instrDraft = '';
      const log = runInstruction(b.dataset.alt, opts);
      if (log && opts.onApply) opts.onApply(log);
      draw();
    };
  });
}

/* Undo and Keep it, the pair Wireframing §5.7 puts under the result. */
function undoRefine(){
  if (!state.history.length) return;
  state.refine = state.history.pop();
  state.instrLog.pop();
  state.genRefined = null;
  draw();
}
function keepRefine(){
  const log = state.instrLog[state.instrLog.length - 1];
  if (log) log.kept = true;
  state.instrDraft = '';
  draw();
}

/* ────────────────────── FORMAT — what disappears, and why ──────────────────
   Technical Design §4.1: a layout must AUTHOR its portrait and square
   variants, it cannot be stretched into them, and `slotsFor` returns null
   when it has not. Wireframing §5.5 requires that this be visible: the
   concept count drops from six to five to three across the three shapes, and
   a result set that silently shrinks reads as a bug rather than a rule. */
function formatFilter(formatId){
  const fmt = FORMATS.find(f => f.id === formatId) || FORMATS[0];
  const fronts = LAYOUTS.filter(l => l.face === 'front');
  const gone = fronts.filter(l => !slotsFor(l, fmt.orientation));
  return { fmt, fronts, gone };
}
function formatNote(lang){
  const { fmt, fronts, gone } = formatFilter(state.format);
  if (!gone.length) return `<p class="b3-gone">${esc(pick2(lang,
    `All ${fronts.length} front compositions are authored for ${fmt.orientation}.`,
    `${num(fronts.length, "bn")}টি সামনের কম্পোজিশনই ${fmt.orientation} আকারে লেখা আছে।`))}</p>`;
  return `<p class="b3-gone">${esc(pick2(lang,
    `${gone.length} of ${fronts.length} front compositions are gone at this format: ${
      gone.map(l => l.name).join(' · ')}. None of them has an authored ${fmt.orientation} composition, and a landscape composition stretched into ${fmt.orientation} is not the same design — so they are removed rather than reshaped.`,
    `এই আকারে ${num(fronts.length, "bn")}টির মধ্যে ${num(gone.length, "bn")}টি সামনের কম্পোজিশন নেই: ${
      gone.map(l => l.name).join(' · ')}। এগুলোর ${fmt.orientation} আকারের জন্য আলাদা কম্পোজিশন লেখা নেই, আর টেনে বড় করা মানে একই ডিজাইন নয় — তাই বাদ দেওয়া হয়েছে।`))}</p>`;
}

/* ────────────────────────── 09 · CONCEPTS ────────────────────────── */

/* Re-score a design the way `generate` scored the ranked six, so a refined
   tile carries a number from the same ladder rather than the number it had
   before the change. */
function rescore(design, content, intent){
  const composed = composeForced(design.layout, content,
    design.script === 'bangla' ? 'bangla' : null,
    { palette:design.palette, type:design.type, density:design.density, format:design.format });
  if (composed.eliminated) return { design, composed, eliminated:composed.eliminated };
  const findings = preflight(composed);
  const cand = { layout:design.layout, palette:design.palette, type:design.type,
                 composed, findings, design };
  cand.score = scoreCandidate(cand, intent);
  cand.why = explain(cand, intent);
  return cand;
}

/* The row currently on screen: either the ranked six, or the ranked six with
   one instruction applied to all of them (Wireframing §5.5 — the refine box
   on this screen applies to all six at once). */
function conceptRow(){
  const r = state.genRefined;
  if (!r) return state.gen.picked.map((c, i) => ({ ...c, i, design:null }));
  return r.items.map((it, i) => ({ ...it, i }));
}

function refineAllSix(text, content){
  const g = state.gen;
  const lang = /[ঀ-৿]/.test(String(text || '')) ? 'bn' : b3Lang();
  const cls = classifyInstruction(text);
  if (cls.empty) return null;
  if (cls.unmapped){
    const log = { ...cls, ops:[], changes:[], text:String(text).trim(), lang,
                  near: nearMisses(text), scope:'all six' };
    state.instrLog.push(log);
    return log;
  }
  const items = g.picked.map(c => {
    const base = { layout:c.layout, palette:c.palette, type:c.type,
                   density:state.density, back:state.back, format:state.format,
                   corner:state.corner || 0,
                   script: state.script === 'bangla' ? 'bangla' : 'latin',
                   finishes: state.finishes.slice() };
    const { design, changes } = applyOps(base, cls.ops);
    return { ...rescore(design, content, g.intent), design, changes, wasLayout:c.layout };
  });
  const log = { ...cls, changes:items.flatMap(x => x.changes), text:String(text).trim(),
                lang, after:items[0]?.design || {}, scope:'all six' };
  state.instrLog.push(log);
  state.genRefined = { text:String(text).trim(), cls, items, lang };
  if (typeof markDirty === 'function') markDirty();
  return log;
}

/* An operation that names one composition — "make my name bigger" is the
   clearest case — selects the same composition for every concept it is
   applied to. Six tiles collapsing into one design is the correct outcome of
   a correct operation, and saying so is better than showing six identical
   cards and letting the user work it out. */
function collapseNote(items, lang){
  const ids = items.filter(x => !x.eliminated).map(x => x.design.layout);
  const distinct = new Set(ids);
  if (distinct.size >= ids.length || !ids.length) return '';
  return checkRow({ s:'review',
    label: pick2(lang,
      `${ids.length} concepts now share ${distinct.size} composition${distinct.size > 1 ? 's' : ''}`,
      `${num(ids.length, "bn")}টি কনসেপ্ট এখন ${num(distinct.size, "bn")}টি কম্পোজিশনে মিলে গেছে`),
    note: pick2(lang,
      `That instruction selects a composition rather than adjusting one, so what still separates these concepts is their palette and type, not their layout. Undo to get the ranked six back.`,
      `ওই নির্দেশ একটি কম্পোজিশন বেছে নেয়, বদলায় না — তাই এখন এগুলোর পার্থক্য শুধু রঙ আর টাইপে, বিন্যাসে নয়। আগের ছয়টি ফিরে পেতে আনডু করুন।`) });
}

function drawConcepts(){
  const lang = b3Lang();
  const g = state.gen;
  const content = readForm();

  if (!g || !g.picked.length){
    b3Paint('concepts', `<div class="sectionhd"><div><h2>${esc(pick2(lang,'Six concepts','ছয়টি কনসেপ্ট'))}</h2></div></div>
      <div class="empty">${esc(pick2(lang,
        'Nothing survived the constraints. Loosen a finish, shorten a field, or choose a larger card.',
        'কোনো নকশা শর্ত পার করেনি। একটি ফিনিশ শিথিল করুন, লেখা ছোট করুন, বা বড় কার্ড নিন।'))}</div>`);
    return;
  }

  const row = conceptRow();
  const refined = state.genRefined;
  const log = state.instrLog[state.instrLog.length - 1];

  /* Counts the generator produced, not counts this screen invented. */
  const meta = `${g.stages.enumerated} ${pick2(lang,'enumerated','গোনা')} · ${g.stages.composed} ${
    pick2(lang,'composed','বসানো')} · ${g.stages.printSafe} ${pick2(lang,'print-safe','প্রিন্ট-নিরাপদ')} · ${
    g.stages.selected} ${pick2(lang,'selected','নির্বাচিত')} · ${g.ms < 1 ? pick2(lang,'under 1','১-এর কম') : g.ms} ms`;

  const tiles = row.map(item => {
    const c = item;
    const L = LAYOUTS.find(l => l.id === (c.design ? c.design.layout : c.layout));
    if (c.eliminated){
      return `<div class="tile dead">
        <div class="deadbox"><span class="pill pill-warn">${esc(pick2(lang,'Removed','বাদ'))}</span></div>
        <span class="tiletitle">${String(c.i + 1).padStart(2,'0')} · ${esc(L ? L.name : '')}</span>
        <span class="tilemeta">${esc(c.eliminated)}</span></div>`;
    }
    const total = c.score.total;
    return `<button class="tile" role="button" tabindex="0"
      aria-pressed="${c.i === state.pick}" data-pick="${c.i}"
      data-score-total="${total.toFixed(4)}" data-layout="${esc(c.layout)}">
      ${renderSVG(c.composed)}
      <span class="tiletitle">${String(c.i + 1).padStart(2,'0')} · ${esc(L ? L.name : c.layout)}</span>
      <span class="tilemeta">${esc(nameOfPalette(c.palette))} · ${esc(nameOfType(c.type).split(' + ')[0])}</span>
      <span class="score"><span class="bar"><span style="width:${(total*100).toFixed(0)}%"></span></span>
      <span class="scorenum">${(total*100).toFixed(0)}</span></span>
      <span class="tilemeta">${Object.keys(W).map(k =>
        `${k.replace(/([A-Z])/g,' $1').toLowerCase()} ${(c.score.parts[k]*100).toFixed(0)}`).join(' · ')}</span>
    </button>`;
  }).join('');

  b3Paint('concepts', `
    <div class="sectionhd">
      <div>
        <h2>${esc(pick2(lang, row.length === 6 ? 'Six concepts' : `${row.length} concepts`,
                               `${num(row.length, "bn")}টি কনসেপ্ট`))}</h2>
        <span class="micro">${esc(meta)}</span>
      </div>
      <div class="row">
        <button class="btn" id="b_regen">${esc(pick2(lang,'Re-compose','আবার বসান'))}</button>
        <button class="btn" id="b_tolibrary">${esc(pick2(lang,'Browse all layouts','সব বিন্যাস দেখুন'))}</button>
      </div>
    </div>

    <div class="tiles b3-grid">${tiles}</div>

    <div class="pane stack" style="margin-top:var(--space-6)">
      <div class="field">
        <label class="lbl" for="c_format">${esc(pick2(lang,'Format','আকার'))}</label>
        <select class="input" id="c_format">${FORMATS.map(f =>
          `<option value="${f.id}"${f.id === state.format ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      </div>
      ${formatNote(lang)}
      <p class="b3-gone">${esc(pick2(lang,
        `Every score above was computed for this brief by the same ranker: personality ${W.personality}, industry ${W.industry}, print safety ${W.printSafety}, legibility ${W.legibility}. Change a personality, an industry or the format and they change with it.`,
        `উপরের প্রতিটি স্কোর এই ব্রিফের জন্য গণনা করা: ব্যক্তিত্ব ${W.personality}, শিল্প ${W.industry}, প্রিন্ট নিরাপত্তা ${W.printSafety}, পাঠযোগ্যতা ${W.legibility}। ব্রিফ বদলালে স্কোরও বদলাবে।`))}</p>
    </div>

    <div class="pane stack" style="margin-top:var(--space-4)">
      <h6>${esc(pick2(lang,'Refine all six at once','ছয়টিতেই একসাথে বদল'))}</h6>
      ${refineBox('c')}
      <div id="c_result">${log && log.scope === 'all six' ? refineResult(log) : ''}</div>
      ${refined ? collapseNote(refined.items, lang) : ''}
    </div>

    ${bottomBar(`
      ${refined ? `<button class="btn" id="c_undo">${esc(pick2(lang,'Undo','আনডু'))}</button>` : ''}
      <button class="btn btn-primary" id="c_open">${esc(pick2(lang,'Open concept','কনসেপ্ট খুলুন'))}</button>`)}
  `);

  bindTiles('[data-screen="concepts"] .tile[data-pick]', tEl => {
    state.pick = Number(tEl.dataset.pick);
    const item = row.find(x => x.i === state.pick);
    if (item && item.design) state.refine = item.design;
    go('detail');
  });
  const el = id => document.getElementById(id);
  el('b_regen').onclick = () => { state.genRefined = null; runGenerate(); };
  el('b_tolibrary').onclick = () => go('library');
  el('c_format').onchange = e => {
    state.format = e.target.value;
    state.genRefined = null;
    /* A format change is a real re-generation — the layouts eligible for the
       new orientation are a different set, so re-filtering by hiding tiles
       would be a lie about what was ranked. */
    runGenerate();
  };
  el('c_open').onclick = () => go('detail');
  if (el('c_undo')) el('c_undo').onclick = () => {
    state.genRefined = null; state.instrLog.pop(); draw();
  };
  /* The box on this screen fans out over the ranked six rather than over the
     one selected design (Wireframing §5.5), so it is bound here instead of
     going through `bindRefine`. */
  const runAll = (text) => { state.instrDraft = ''; refineAllSix(text, content); draw(); };
  const input = el('c_text');
  if (input){
    input.oninput = e => { state.instrDraft = e.target.value; };
    input.onkeydown = e => { if (e.key === 'Enter'){ e.preventDefault(); runAll(input.value); } };
  }
  el('c_apply').onclick = () => runAll(input ? input.value : '');
  document.querySelectorAll('[data-screen="concepts"] [data-alt]').forEach(b =>
    b.onclick = () => runAll(b.dataset.alt));
}

/* ────────────────────────── DETAIL ────────────────────────── */
function drawDetail(design, content){
  const lang = b3Lang();
  const ranked = state.gen && state.gen.picked[state.pick];
  /* Once a refinement has landed, the ranked candidate's score describes a
     design that is no longer on screen. Showing it next to the refined card
     would be the same defect as a fabricated score with extra steps, so the
     score is recomputed for what is actually drawn. */
  const cand = !ranked ? null
    : state.refine ? (r => r.score ? r : null)(rescore(design, content, state.gen.intent))
    : ranked;
  const restated = !!(ranked && state.refine && cand);
  const { front, back } = facesFor(design, content);
  const L = LAYOUTS.find(l => l.id === design.layout);
  const log = state.instrLog[state.instrLog.length - 1];
  const showLog = log && log.scope !== 'all six';

  const faceOf = c => renderSVG(c, { guides:true }) ||
    `<div class="deadbox"><span class="pill pill-warn">${esc(pick2(lang,'Eliminated','বাদ'))}</span>
      <span class="tilemeta">${esc(c?.eliminated || '')}</span></div>`;
  const faces = state.side === 'back' ? faceOf(back)
    : state.side === 'both' ? `<div class="b3-facepair">${faceOf(front)}${faceOf(back)}</div>`
    : faceOf(front);

  const kv = front && !front.eliminated ? [
    ['Trim', `${front.fmt.w} × ${front.fmt.h} mm`],
    ['Document', `${front.fmt.w + 2*front.fmt.bleed} × ${front.fmt.h + 2*front.fmt.bleed} mm with bleed`],
    ['Type', front.type.name], ['Palette', front.pal.name],
    ['Guides', 'blue = 4 mm safe area · red = resolved slots']
  ].map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') : '';

  const score = cand ? Object.keys(W).map(k => `
    <div class="check" style="padding:6px 0">
      <span style="flex:1">${k.replace(/([A-Z])/g,' $1').toLowerCase()}
        <span class="note">${esc(pick2(lang,'weighted','ওজন'))} ${W[k]}</span></span>
      <span class="bar" style="width:78px;margin-top:6px"><span style="width:${
        (cand.score.parts[k]*100).toFixed(0)}%"></span></span>
      <span class="scorenum" style="width:26px;text-align:right">${(cand.score.parts[k]*100).toFixed(0)}</span>
    </div>`).join('') + `<div class="tally" style="margin-top:10px" data-score-total="${
      cand.score.total.toFixed(4)}"><span>${esc(pick2(lang,'Total','মোট'))} <b>${
      (cand.score.total*100).toFixed(1)}</b> / 100</span></div>`
    : `<p class="lede" style="font-size:12.5px">${esc(pick2(lang,
        'No score for a hand-picked template.', 'হাতে বাছা টেমপ্লেটের কোনো স্কোর নেই।'))}</p>`;

  b3Paint('detail', `
    <div class="pane stack">
      <div class="spread">
        <div>
          <h2 id="detailName">${esc(L ? L.name : pick2(lang,'Concept','কনসেপ্ট'))}</h2>
          <span class="micro" id="detailMeta">${esc([
            nameOfPalette(design.palette), nameOfType(design.type),
            state.refine ? pick2(lang,'refined','পরিমার্জিত') : null].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="seg" role="group" aria-labelledby="lbl_side">
          <span class="sr" id="lbl_side">${esc(pick2(lang,'Which face','কোন পিঠ'))}</span>
          <button data-side="front" aria-pressed="${state.side === 'front'}">${esc(pick2(lang,'Front','সামনে'))}</button>
          <button data-side="back"  aria-pressed="${state.side === 'back'}">${esc(pick2(lang,'Back','পিছনে'))}</button>
          <button data-side="both"  aria-pressed="${state.side === 'both'}">${esc(pick2(lang,'Both','দুটোই'))}</button>
        </div>
      </div>
      <div id="detailCard" class="stack">${faces}</div>
      <dl class="kv" id="detailKv">${kv}</dl>
    </div>

    <div class="pane stack" style="margin-top:var(--space-4)">
      <h6>${esc(pick2(lang,'Why this design','কেন এই নকশা'))}</h6>
      <div id="why">${cand
        ? whyBlock(cand, state.gen.intent, lang)
        : `<p class="b3-said">${esc(pick2(lang,
            'Chosen by hand from the library rather than ranked, so there is no scoring trace to explain.',
            'লাইব্রেরি থেকে হাতে বাছা, র‍্যাঙ্ক করা নয় — তাই ব্যাখ্যা করার মতো কোনো স্কোরিং ট্রেস নেই।'))}</p>`}</div>
    </div>

    <div class="pane stack" style="margin-top:var(--space-4)">
      <h6>${esc(pick2(lang,'Score','স্কোর'))}</h6>
      ${restated ? `<p class="b3-gone">${esc(pick2(lang,
        'Recomputed for the refined design by the same ranker, not carried over from the ranked concept.',
        'পরিমার্জিত নকশার জন্য একই র‍্যাঙ্কার দিয়ে নতুন করে গণনা করা, আগের কনসেপ্টের স্কোর নয়।'))}</p>` : ''}
      <div id="score">${score}</div>
    </div>

    <div class="pane stack" style="margin-top:var(--space-4)">
      <h6>${esc(pick2(lang,'Refine','পরিমার্জন'))}</h6>
      ${refineBox('d')}
      <div id="instr">${showLog ? refineResult(log) : ''}</div>
    </div>

    ${bottomBar(`
      <button class="btn" id="b_undo" ${state.history.length ? '' : 'disabled'}>${
        esc(pick2(lang,'Undo','আনডু'))}</button>
      ${showLog && !log.unmapped ? `<button class="btn" id="d_keep">${
        esc(pick2(lang,'Keep it','রাখুন'))}</button>` : ''}
      <button class="btn" id="b_tocustomise">${esc(pick2(lang,'Customise','পরিবর্তন'))}</button>
      <button class="btn btn-primary" id="b_validate">${esc(pick2(lang,'Validate','যাচাই'))}</button>
      <button class="btn" id="b_toexport">${esc(pick2(lang,'Export or order','ফাইল বা অর্ডার'))}</button>`)}
  `);

  document.querySelectorAll('[data-screen="detail"] [data-side]').forEach(b =>
    b.onclick = () => { state.side = b.dataset.side; draw(); });
  const el = id => document.getElementById(id);
  el('b_undo').onclick = undoRefine;
  if (el('d_keep')) el('d_keep').onclick = keepRefine;
  el('b_tocustomise').onclick = () => go('customise');
  el('b_validate').onclick = () => go('validate');
  el('b_toexport').onclick = () => go('export');
  bindRefine('d', { scope:'design' });
}

/* ── 10 · Customise — every picker emits an operation from the closed set,
   the same one the text box uses. Nothing here writes geometry. ───────── */
function drawCustomise(design, content){
  const lang = b3Lang();
  const { front } = facesFor(design, content);
  const log = state.instrLog[state.instrLog.length - 1];
  const showLog = log && log.scope !== 'all six';

  const bank = (id, items, isOn) => `<div class="chips" role="group" aria-labelledby="lbl_${id}"
      id="alt${id}" style="margin-top:7px">${items.map(([label, arg, extra]) =>
      `<button class="chip chip-sm" data-arg="${esc(arg)}" aria-pressed="${isOn(arg)}">${
        extra || ''}${esc(label)}</button>`).join('')}</div>`;

  const banks = [
    ['Type', 'Typography', 'টাইপোগ্রাফি', 'setTypeSystem',
      TYPE_SYSTEMS.map(t => [t.name.split(' + ')[1] || t.name, t.id]), a => design.type === a],
    ['Colour', 'Colour', 'রঙ', 'setPalette',
      PALETTES.map(p => [p.name, p.id,
        `<span style="display:inline-block;width:26px;height:11px;margin-right:7px;vertical-align:-1px;
          background:linear-gradient(90deg,${p.bg} 50%,${p.accent} 50%);border:1px solid var(--hair)"></span>`]),
      a => design.palette === a],
    ['Layout', 'Layout', 'বিন্যাস', 'setLayout',
      LAYOUTS.filter(l => l.face === 'front').map(l => [l.name, l.id]), a => design.layout === a],
    ['Density', 'Density', 'ঘনত্ব', 'setDensity',
      [['Airy','airy'],['Balanced','balanced'],['Tight','tight']], a => design.density === a],
    ['Corner', 'Corners', 'কোণ', 'setCorner',
      [['Square','0'],['2 mm radius','2'],['4 mm radius','4']], a => String(design.corner || 0) === a],
    ['Back', 'Back of the card', 'কার্ডের পিছন', 'setBack',
      LAYOUTS.filter(l => l.face === 'back').map(l => [l.name, l.id]), a => design.back === a]
  ];

  b3Paint('customise', `
    <div class="sectionhd">
      <div><h2>${esc(pick2(lang,'Customise','পরিবর্তন'))}</h2>
        <span class="micro">${esc(state.refine
          ? pick2(lang, `${state.history.length} change${state.history.length === 1 ? '' : 's'} from the ranked concept`,
                        `র‍্যাঙ্ক করা কনসেপ্ট থেকে ${num(state.history.length, "bn")}টি বদল`)
          : pick2(lang,'Unchanged from the ranked concept','র‍্যাঙ্ক করা কনসেপ্ট অপরিবর্তিত'))}</span></div>
    </div>

    <div class="pane stack">
      <div id="custCard">${renderSVG(front, { guides:false }) ||
        `<div class="deadbox"><span class="pill pill-warn">${esc(pick2(lang,'Eliminated','বাদ'))}</span>
          <span class="tilemeta">${esc(front?.eliminated || '')}</span></div>`}</div>
      ${refineBox('u')}
      <div id="instr">${showLog ? refineResult(log) : ''}</div>
      <p class="lede" style="font-size:12px">${esc(pick2(lang,
        'The pickers and the text box emit the same closed set of operations. Neither can move an element or set a size; the geometry is always re-composed.',
        'পিকার আর টেক্সট বক্স একই নির্ধারিত অপারেশন পাঠায়। কোনোটিই কিছু সরাতে বা আকার বসাতে পারে না; জ্যামিতি সবসময় নতুন করে বসানো হয়।'))}</p>
    </div>

    <div class="pane stack" style="margin-top:var(--space-4)">
      ${banks.map(([id, en, bn, op, items, isOn]) =>
        `<div><span class="lbl" id="lbl_${id}">${esc(pick2(lang, en, bn))}</span>
          ${bank(id, items, isOn)}</div>`).join('')}
    </div>

    ${bottomBar(`
      <button class="btn" id="b_undo" ${state.history.length ? '' : 'disabled'}>${
        esc(pick2(lang,'Undo','আনডু'))}</button>
      <button class="btn" id="b_reset">${esc(pick2(lang,'Reset to the concept','কনসেপ্টে ফিরুন'))}</button>
      <button class="btn btn-primary" id="b_custvalidate">${esc(pick2(lang,'Validate','যাচাই'))}</button>`)}
  `);

  /* A picker is an instruction with no text. It goes through the same log so
     the record of what changed a design is one list, not two. */
  const apply = (op, arg) => {
    const { design:next, changes } = applyOps(lastDesign, [{ op, arg }]);
    state.history.push({ ...lastDesign });
    state.refine = next;
    state.instrLog.push({ ops:[{op, arg}], matched:[op], changes, unmapped:false,
                          text:null, lang, after:next, scope:'picker' });
    if (typeof markDirty === 'function') markDirty();
    draw();
  };
  banks.forEach(([id, , , op]) => {
    document.querySelectorAll(`#alt${id} .chip`).forEach(b =>
      b.onclick = () => apply(op, b.dataset.arg));
  });

  const el = id => document.getElementById(id);
  el('b_undo').onclick = undoRefine;
  el('b_reset').onclick = () => {
    state.refine = null; state.history = []; state.instrLog = [];
    state.instrDraft = ''; state.genRefined = null; draw();
  };
  el('b_custvalidate').onclick = () => go('validate');
  bindRefine('u', { scope:'design' });
}

/* ── Validate ──────────────────────────────────────────────────────────── */
