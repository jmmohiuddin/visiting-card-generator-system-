# CARDWORKS — Production Blueprint
## Bangladesh edition

**Input reviewed:** `Card Studio.html` (709 KB bundle → 169 KB app template, 2,428 lines, 21 screens, one `CardFace` sub-component, 24 embedded woff2 faces).
**Market:** Bangladesh first. Currency BDT. Trim 89 × 51 mm. Bangla + English.
**Companion:** `index.html` — a working reference implementation covering §4 (design system), §6 (DesignSpec), §7 (ranking and explanation, rules path), §10 (print output) and the §17 cost model. 74 headless assertions pass. Open it in a browser.
**Date:** 9 August 2026

**Verdict in one line:** the prototype contains the correct product idea in two places and the wrong implementation everywhere else. The fix is not more screens — it is to make the thing you already drew on screen 10 (the slot/grid model) into the runtime, and delete the twelve hand-written layouts.

**What changed in this edition.** The market moved from the UAE to Bangladesh. That is not a find-and-replace on currency: it changes the launch-blocking constraint (Bangla, not Arabic), the type library, the minimum print size, the payment rails, the price points by roughly an order of magnitude, the device mix, and the competitive set. Sections 0.3, 1, 3, 10, 14–19 and the new §BD are Bangladesh-specific. The architecture sections (2, 4–9, 11–13) are market-independent and stand as written.

---

## 0. What the file actually is

### 0.1 Structure as built

| Layer | What's there |
|---|---|
| Shell | One `Component extends DCLogic`, flat 25-key `state`, screen routing by string comparison (`st.screen === 'intake'`) |
| View model | One `renderVals()` returning ~120 keys — every screen's data, inline styles included, in a single function |
| Markup | 21 `<sc-if>` screen blocks, 78 `<input>` elements, all with hardcoded `value=` |
| Card renderer | `CardFace.dc.html`, props `{concept, side, scale, foil, uv, emboss}`, **12 hand-written layout branches** (`isRule`, `isCentered`, `isSplit`, `isBleed`, `isEditorial`, `isGrid`, `isBand`, `isCorner`, `isStack`, `isFrame`, `isDuotone`, `isIndex`) |
| Data | `CONCEPTS` (6), `EXTRA_TEMPLATES` (6), `COLOR_ALTS` (8), `TYPE_ALTS` (5), `LAYOUT_ALTS` (12), `SLOTS` (6), `ADMIN_COMPONENTS` (7), `FINISHES` (8), `VIBES` (18) |

### 0.2 The screens

Brief (7 steps behind a 12-step rail) · Generating · Results · Detail · Editor · Layout builder · Validate · Export · Order · Tracking · No-results · Dashboard · Library · Studio (admin) · Component editor · Profiles · Mockups · Pricing · Sign-in · Settings · Start.

That is a more complete surface than most funded products ship in year one. The gaps below are engineering gaps, not imagination gaps.

---

## 0.3 What is genuinely good — keep all of this

These are not consolation prizes. Each one is a decision most competitors get wrong.

1. **Proof before charge.** `orderSteps`: files locked → printed proof → *you approve, charged at this point, not before* → run. This single decision removes the category's biggest fear and is worth more than any AI feature.
2. **Market-specific trim sizes.** The table already carries Bangladesh at 89 × 51 mm — the size every press in Nilkhet, Fakirapool and Banglabazar cuts by default. Every Western competitor assumes US Letter geometry and ships 3.5 × 2 in. This is a real moat in your actual market.
3. **The constraint-conflict screen** (`isNoResults`) with three named resolutions and their unit-cost consequences. Almost nobody designs the empty state of a generative system. You did.
4. **Preflight as a first-class screen**, not a download-time error. `validationGroups` names the right checks: 6.5 pt floor, 4 mm safe area, 3 mm bleed, 218%/300% TAC, FOGRA51, foil across a fold-free edge.
5. **Component compatibility declared as data.** `ADMIN_COMPONENTS[].compatible / .incompatible` — e.g. *edge-paint incompatible with lamination*, *tech-grid incompatible with gold foil*. This is the constraint engine, already written down. Nothing consumes it yet.
6. **Press capability matrix** (`presses`: what each can produce, lead time, unit price). That is the broker business model expressed as a data structure.
7. **The "why this concept" rationale copy.** *"Premium plus powerful pushes towards contrast and scarcity: a dark ground makes the foil the only bright thing on the card."* This is the product's actual differentiator. Make it generated from a real decision trace instead of prose, and it becomes defensible.
8. **The visual language itself** — modernist, hairline rules, uppercase micro-labels, no rounded-corner SaaS mush. It does not look AI-generated. Protect it.

---

## 0.4 The findings — ranked by what they cost you

### 🔴 F1. There is no layout engine. There are twelve HTML files.

`CardFace.dc.html` hardcodes the content:

```html
<div style="font-size:29px;...">Mohiuddin Ahmed</div>
<div style="{{ sMuted }}">Chief Executive Officer</div>
<div style="...">NOVA Technologies</div>
```

Ten literal occurrences of the demo name across twelve layout branches. **The 78 intake inputs feed nothing.** A user typing their real name would see yours.

Consequences, in order of severity:

- Adding a 13th layout means writing HTML by hand → you have built the template explosion the brief forbids.
- Every layout must be re-authored for portrait, for bilingual, for a 4-line address, for a long name.
- Nothing can be validated geometrically, because nothing knows where anything is.
- The layout builder on screen 10 — a 12×8 grid with slot positions, minimum sizes and fallback rules — is the correct model, and it is **decorative**. `slots` drives a click-highlight demo and never reaches `CardFace`.

**This is the whole rebuild.** Everything else in this document depends on fixing it.

### 🔴 F2. Nothing survives a real name.

`Mohiuddin Ahmed` is 15 characters. `Dr. Krishnamurthy Venkataraman Subramanian` is 42. At 29 px in a fixed-width box the second one overflows or truncates, and the prototype has no concept of either. There is no text measurement anywhere in the file.

A system whose promise is *"you cannot get a wrong result"* fails at the first real Bangladeshi name. `Mohammad Shafiqur Rahman Chowdhury Bhuiyan` is 43 characters and entirely ordinary here; a doctor's card adds `MBBS (DMC), FCPS (Medicine), MRCP (UK)` on top. Text fitting is not a polish item; it is the product. `index.html` implements the ladder that solves it.

### 🔴 F3. No Bangla — the launch blocker for the market you picked.

The prototype ships five Latin families (Space Grotesk, Playfair, DM Serif, Archivo, IBM Plex Mono) and zero Bangla coverage. A Bangladeshi card is routinely bilingual: Bangla on one face, English on the other, or both on one face. The prototype's back side offers `contact | qr | mark` and nothing else.

Bangla is not Latin with different glyphs. Three facts break a Latin-only engine outright, and all three are now encoded in `index.html`:

1. **Matra (মাত্রা).** The hanging headline sits at the top of most letters, and vowel signs (ি ী ে ৈ ো ৌ) rise above it. Bangla needs materially more room above the baseline than Latin — a slot sized on Latin ascent metrics clips.
2. **Conjuncts (যুক্তাক্ষর).** ক্ষ, ঙ্গ, ন্ত্র stack vertically and collapse into unreadable mush below roughly 7.5 pt on 300 gsm art card. **The 6 pt Latin floor is unsafe for Bangla.** The engine floors Bangla at 7.5 pt and Latin at 6.0 pt, per script, per slot.
3. **Optical size.** At equal point size Bangla reads smaller and denser than Latin. A bilingual card set at one nominal size looks unbalanced. The engine applies a 1.12× optical compensation to Bangla.

A fourth, subtler one: **letter-spacing must never go negative on Bangla** — it breaks the matra join and the conjunct clusters. The prototype's uppercase-tracked micro-labels (`letter-spacing:.22em`, `text-transform:uppercase`) are Latin idioms that are meaningless in Bangla, which has no case at all. Roughly a third of the prototype's type styling does not survive translation.

No Western card tool encodes any of this. It is the single most defensible reason a Bangladesh-first product can beat Canva here permanently — and it is invisible in a demo that only ever renders one Latin name.

### 🟠 F4. There is no AI. There are six `if` statements.

```js
if (k === 'minimal') return Object.assign({}, c, pal(i % 2 ? 3 : 1), { layout: [...][i % 6], ... });
```

`tf(c, i)` switches on one of six fixed instruction keys and reassigns palettes **by array index modulo 6**. `nlChips` are four canned overrides. Free text is never parsed. The pipeline — *"Reading the brief · 7 signals"*, *"1 480 components"*, *"412 remain"* — is seven `setTimeout` calls over invented numbers.

The good news is that the *shape* is right, and your own copy states the correct principle: **"Every instruction resolves to a change in the component set, never a redraw."** That sentence is the architecture. Section 7 implements it.

### 🟠 F5. The brief-fit score is a lie the user can catch.

`fit: 91 / 96 / 88 / 79 / 85 / 83` are literals on the concept records. Change your personality selection from *Premium · Modern · Powerful* to *Friendly · Sustainable · Traditional* and all six scores stay identical. Any user who tries this once stops believing the product. A fabricated confidence number is worse than no number.

### 🟠 F6. Copy that contradicts code.

- **Portrait.** `INSTR.portrait.note` claims *"Three layouts cannot hold a tall format and were swapped for ruled stacks."* But `PORTRAIT_SAFE` marks **all nine** layouts safe, so `tf()` swaps nothing. And `orient: 'portrait'` is never read by `CardFace` — nothing rotates. *(Fixed in the reference engine: orientation support is declared per layout, portrait compositions are separately authored, and unsupported layouts are eliminated with a stated reason.)*
- **"Twelve short steps."** The rail has 12 entries but only entries 0–6 are brief steps; 7 is Generate and 8–11 are post-generation screens. The user is told the brief is twelve steps long. It is seven.
- **Preflight counts.** Tracking says *"Preflight passed 16 of 19, three accepted."* `validationGroups` contains 12 rows. The numbers were never wired to each other.

Each of these is a small thing that a careful buyer notices, and together they read as a product that does not mean what it says.

### 🟠 F7. Desktop-only, in mobile-first markets.

Fixed `max-width:1440px`, `grid-template-columns: 280px 1fr 300px`, a 506 px canvas, a 12-column nav bar of eleven buttons. Below ~1100 px this collapses into unusable overlap. In Bangladesh the SMB owner buying a card is on a mid-range Android phone, very often exclusively, frequently on metered mobile data. Desktop-only is not a degraded experience here — it is no experience.

The intake flow is *ideal* for mobile — one question per screen, chips, no canvas. That's the whole thesis: because the user never manipulates a canvas, this product can be mobile-native in a way Canva structurally cannot. You have built the one design that works on a phone and then locked it to a desktop grid.

### 🟡 F8. Silent no-op on the personality cap.

```js
if (v[label]) delete v[label];
else { if (Object.keys(v).length >= 3) return {}; v[label] = 1; }
```

At three selections, clicking a fourth chip returns an empty state patch — nothing happens, no message, no visual. Users conclude the app is broken. Either show *"Deselect one first"* or replace the oldest selection.

### 🟡 F9. Step flags are shuffled.

`step1: st.step === 0, step4: st.step === 1, step5: st.step === 2, step2: st.step === 3, step6: st.step === 4, step3: st.step === 5, step7: st.step === 6`. The display order was rearranged and the flag names kept their original meanings. This will cause a wrong-screen bug the first time someone inserts a step.

### 🟡 F10. Multi-tenancy is a four-item string switch.

`st.profile` selects from four hardcoded names, with palettes resolved by a literal object lookup. Meanwhile the pricing table sells **"Business — 10 seats, shared team library, locked templates, bulk ordering."** You are selling an architecture that does not exist. Either build it (Section 13) or remove the tier until you do.

### 🟡 F11. Everything downstream of the design is a fixture.

- **Export** — `cmyk_artwork.pdf 4.2 MB`, `foil_gold.pdf 38 KB`, `card.svg 96 KB`. No renderer exists.
- **Pricing** — `{100:'320', 250:'540', 500:'820', 1000:'1 340'}` lookup tables. No cost model, no press quote, no finish surcharge, no VAT, no shipping.
- **Mockups** — four grey rectangles with labels. Delete these for MVP; photoreal mockups are a render-cost sink that sells nothing at this stage.
- **Logos** — five filenames, one annotated *"Raster · low resolution."* Right instinct, no upload pipeline, no quality gate, no vectorisation, no colour-space handling.

### 🟡 F12. Accessibility of the app itself.

`color-mix(in srgb, var(--color-text) 45%, transparent)` on 10–12 px uppercase micro-labels, used throughout for meta text. That will not clear 4.5:1. Buttons carry no focus ring, the rail items are `<button>` with no `aria-current`, the card preview has no text alternative. You audit contrast rigorously for print and not at all for screen.

### 🟢 F13. Font licensing — you got lucky, now make it deliberate.

Space Grotesk, Playfair Display, DM Serif Display, Archivo and IBM Plex Mono are all SIL OFL. OFL permits embedding and outlining in commercial print output. **Write this constraint down as a rule** — "library fonts must be OFL or explicitly print-licensed" — because the first designer who adds a Monotype face without checking creates a real liability, and outlined vectors in a customer's PDF are irrevocable.

---

## 0.5 Bangladesh — the market layer

Everything in this section is specific to launching here, and none of it is derivable from a Western product brief.

### 0.5.1 The card itself

| | Bangladesh reality |
|---|---|
| Trim | **89 × 51 mm** (3.5 × 2 in) standard; 90 × 50 mm second. Portrait is rare but real for doctors' chamber cards |
| Stock | 300–350 gsm art card is the default; 250 gsm at the cheap end; 600 gsm cotton essentially only for premium/letterpress work |
| Finish | Matte and gloss lamination ubiquitous and cheap. **Spot UV and gold foil are widely available and far cheaper than in the West** — a premium-feeling card is within reach of an ordinary budget here, which is a genuine product opportunity |
| Sides | Two-sided is normal, not an upsell. Bangla one side, English the other is the classic |
| Numerals | Bengali numerals (০১৭…) on the Bangla face, Western on the English face. The engine does this conversion automatically |

### 0.5.2 Content conventions a Western engine gets wrong

- **Two or three mobile numbers** on one card is normal, not clutter to be designed away. The engine's `reduceRoutes` rung must move the extras to the back rather than delete them — the numbers are the point of the card.
- **No website; a Facebook page instead.** A large share of SMBs have `fb.com/shopname` and no domain. The contact model must treat a Facebook page as a first-class route, not squeeze it into a "web" field.
- **Degrees and titles carry enormous weight.** `MBBS (DMC), FCPS (Medicine), MRCP (UK)` is a 38-character string that is the most important line on a doctor's card after the name. It cannot be abbreviated away and it cannot overflow.
- **Md. / Mohammad prefixes** are extremely common and should never be dropped by an abbreviation rule that does not know they are part of the name.
- **Chamber hours** (`রোগী দেখার সময়: বিকাল ৫টা – রাত ৯টা`) are a required field on a doctor's card and have no equivalent in any international template.
- **Address formats** are landmark-relative, not postal (`House 35/A, Road 4, Dhanmondi, Dhaka-1205`). Long, and they wrap.

### 0.5.3 The verticals worth building templates for

Ranked by volume × willingness to pay. Each is a preset in `index.html`.

1. **Doctors** — chamber cards, highest willingness to pay, hardest content, reorder on every chamber change
2. **RMG / buying houses / textiles** — bilingual, export-facing, corporate budgets, Dhaka-concentrated
3. **Advocates and notaries** — formal, traditional, Bangla-dominant, court-address-led
4. **Real estate and land brokers** — high volume, image-conscious, frequent reprints
5. **Coaching centres and private tutors** — enormous volume, very price-sensitive, seasonal peaks
6. **Shops, restaurants, service trades** — the long tail, best reached through the shop channel
7. **Travel agencies (Hajj/Umrah)** — seasonal, distinctive visual conventions, good margins

### 0.5.4 Distribution and devices

- **Android, mid-range, metered data.** Page weight is a feature. Keep the first meaningful render under a few hundred KB; the composer is a pure function and can run entirely client-side, so briefing and preview should work with no network at all.
- **Mobile-first is not a nice-to-have** — it is the only interface most of this market will ever use. See F7.
- **The UI must be available in Bangla**, and Bangla should probably be the default. An English-only interface silently excludes most of the addressable market.
- **Facebook is the marketing channel.** Not search, not LinkedIn. Design the sharing artefact (a preview image of the card with a watermark) to be a Facebook post, because that is the loop.

### 0.5.5 Type library — Bangla, and licensing

Use SIL OFL families only, for the same reason as §F13, and outline them in output:

| Family | Use | Licence |
|---|---|---|
| **Hind Siliguri** | Workhorse UI and card body; best small-size legibility | OFL |
| **Noto Sans Bengali** | Widest conjunct coverage — safest for uncommon names | OFL |
| **Tiro Bangla** | Editorial/traditional letterforms, high contrast | OFL |
| **Baloo Da 2** | Heavy display — retail, food, events | OFL |
| **Mina / Galada / Atma** | Additional variety as the library grows | OFL |

Avoid SolaimanLipi and Kalpurush at launch despite their ubiquity: both are widely redistributed but their commercial-print and outlining terms are not cleanly documented, and you will be embedding them into files customers pay for. Revisit only with written clarification.

### 0.5.6 Compliance and operations

- **VAT/tax** — printing and design services have their own treatment under the NBR rules; confirm the applicable rate and your invoicing obligations with an accountant before you set list prices. Do not guess this into the pricing table.
- **Trade licence and BIN** are needed for corporate invoicing; corporate customers will ask.
- **Press onboarding** — a two-press minimum per city from day one (§19). Ask every press for: profile/ICC or "none", plate/block setup cost, minimum run, lead time in working days, and whether they will accept a PDF/X-4 without "fixing" it in CorelDRAW. That last answer matters more than the price.

---

# PART I — PRODUCT

## 1. Product Strategy (PM view)

### 1.1 The actual problem

Not *"people can't design cards."* The real problem: **a non-designer cannot tell whether a design is good, and cannot tell whether a file will print correctly — and both mistakes are only discovered after paying for 1,000 cards.**

Canva solves neither. It gives an infinite canvas to someone who does not know that 5 pt type disappears under office light, that gold foil 1 mm from the trim will drift, or that 340% ink coverage will offset onto the next sheet. It moves the risk to the user and calls it freedom.

### 1.2 The customer, in order of willingness to pay

| Segment | Volume | Pays for | Annual value |
|---|---|---|---|
| **Print shops** (Nilkhet, Fakirapool, Banglabazar, every upazila town) | ~40,000+ outlets | A front-end that removes their design labour and lets them charge more | ৳2,000–15,000/shop |
| **Corporate card programmes** (banks, RMG groups, pharma, telcos, NGOs) | Low count, high value | Brand governance, bulk generation for 500+ staff, one invoice | ৳3–25 lakh |
| **Professionals** (doctor, advocate, engineer, broker, tutor) | High | A card that signals credibility; reorders on chamber or job change | ৳1,500–5,000/order |
| **SMB owner** (shop, restaurant, service) | Highest count | Speed and not having to go to Nilkhet | ৳500–2,500/order |

The demo is aimed at rows three and four. **The leverage is in row one.**

**The strategic correction: the print shop is your distribution channel, not your competitor.** In Bangladesh, design is bundled free with printing — you sit in the shop while someone types your name into a CorelDRAW template. You cannot win a price war against free, and you should not try. What you can do is give that shop a tablet app that produces a card in two minutes that they could not have produced in thirty, let them charge more for it, and take a cut. In a low-ARPU market, a channel with 40,000 existing storefronts and existing customer trust beats direct-to-consumer acquisition by a wide margin.

All four rows are unlocked by the same primitive — a machine-readable `DesignSpec`, plus an API — which is exactly what the current architecture lacks.

### 1.3 Positioning statement

> For professionals and organisations who need a card that is correct, CARDWORKS turns a seven-question brief into six print-ready designs. Unlike Canva, you never touch a canvas and the output cannot be wrong — because every design is assembled from print-validated components under explicit constraints, not drawn freehand.

### 1.4 What we deliberately do not do

- No free canvas, no drag-and-drop, no arbitrary element placement. Users who want pixel control are not our customers, and serving them destroys the guarantee.
- No image generation on the card. Generated imagery cannot be colour-managed, cannot be vector, cannot be foil-separated.
- No logo *design*. Adjacent product, different constraint system. Monogram generation only.
- No posters, flyers, or "anything else." The constraint system is card-specific, and that specificity is the advantage.

### 1.5 The metric that matters

**Print-Correct Rate** — orders delivered with zero preflight-attributable defects, as a percentage. Target ≥ 99.5%. Every architectural decision in this document is subordinate to that number. Revenue follows it; it does not lead it.

Supporting metrics: brief→first-concept p95 latency (< 6 s), concept→order conversion, reorder rate at 12 months, LLM cost per brief (< $0.01), render cost per preview (< $0.0001).

---

## 2. System Architecture (CTO view)

### 2.1 The one idea

```
Brief ──► IntentResolver ──► BriefVector ──► CandidateEngine ──► DesignSpec ──► Renderer ──► Preflight ──► Export/Print
        (LLM, 1 call,        (typed,        (deterministic:    (immutable,    (pure fn,     (geometric,
         cached)              no prose)      filter→compose     content-       cacheable)    blocking)
                                             →score)           addressed)
```

**`DesignSpec` is the atom of the product.** It is a JSON document that fully determines a card: geometry, slots, resolved content, type scale, palette, finishes, colour space. Everything downstream is a pure function of it.

That gives you, for free:
- **Determinism** — same spec, same bytes, forever.
- **Caching** — renders are addressed by `sha256(spec)`; a cache hit costs a CDN lookup.
- **Versioning** — specs are immutable; an edit mints a child with a parent pointer. History, rollback, fork and diff fall out of the data model rather than needing a system of their own (this answers requirement §4E without building anything extra).
- **Testability** — a golden-file suite of 500 specs renders on every deploy; any pixel drift fails CI.
- **Portability** — the same spec renders to preview SVG, print PDF/X-4, email signature, or an NFC landing page.

### 2.2 Services

| Service | Responsibility | Runtime | Scale shape |
|---|---|---|---|
| `api` | REST/GraphQL, auth, tenancy, orchestration | Node/TS or Go | Stateless, horizontal |
| `intent` | LLM intent resolution + edit-instruction classification | Node/TS | Rate-limited, cached, circuit-broken |
| `engine` | Filter → compose → score → six specs | **Pure, no I/O, no network** | CPU-bound, trivially parallel |
| `render-preview` | Spec → SVG/PNG | Same process as `engine` | < 20 ms, CDN-fronted |
| `render-print` | Spec → PDF/X-4 + separations | Isolated worker pool | Queue-backed, the only heavy path |
| `preflight` | Geometric + colorimetric validation | Shares geometry lib with `engine` | Fast, synchronous |
| `orders` | Quotes, press routing, proofs, fulfilment | Node/TS | Low volume, high value — needs an audit log |
| `library` | Component CRUD, versioning, compat rules, publishing | Node/TS | Read-heavy, aggressively cached |

**Non-negotiable:** `engine` is a pure function of `(BriefVector, LibrarySnapshot, seed)`. No database calls, no clock, no randomness that isn't seeded. This is what makes the system reproducible, cheap to test, and possible to run client-side later for instant preview.

### 2.3 Why not render in a browser

Do not put headless Chromium in the render path. At scale it costs ~300 MB and ~800 ms per instance for a job that is geometrically trivial. Compose the PDF directly (`pdf-lib`, `HexPDF`, or a Rust `printpdf` worker): full control over colour space, spot channels, overprint and font outlining, at ~40 ms and ~10 MB. Previews are SVG strings generated in-process — no browser, no rasteriser, no queue.

### 2.4 Storage

- **Postgres** — all relational state, row-level security keyed on `org_id`.
- **S3-compatible object store** — renders, uploads, export bundles. Renders keyed `renders/{spec_hash}/{variant}.{ext}` so they are immutable and infinitely cacheable.
- **Redis** — intent cache, library snapshot cache, rate limits, idempotency keys.
- **CDN** — everything under `renders/` with a one-year `immutable` cache header.

---

## 3. UX Flow

### 3.1 The corrected flow

```
Start ──► Brief (7 steps, mobile-native) ──► Generating (real work, real numbers)
   │                                              │
   │                                              ▼
   └──────────────────────────────────────►  Six concepts
                                                  │
                    ┌─────────────────────────────┼──────────────────────────┐
                    ▼                             ▼                          ▼
              Re-instruct all six           Open one (Detail)          No candidates
              (typed operations)                  │                   → resolution ladder
                                                  ▼
                                            Refine (typed operations only)
                                                  │
                                                  ▼
                                            Preflight (blocking on hard failures)
                                                  │
                              ┌───────────────────┴───────────────────┐
                              ▼                                       ▼
                        Export files                            Order → proof → approve → run
```

### 3.2 Brief: seven steps, not twelve

Cut to: **1** Identity (name, role, company, industry) · **2** Contact routes · **3** Logo *or* monogram · **4** Personality (max 3) · **5** Language & market · **6** Physical feel & budget · **7** Review.

Rules:
- Steps 3–6 are all skippable with a sensible default. Only step 1 is required. A user who abandons at step 2 must still be able to generate.
- The rail shows **7** and says seven. Post-generation stages (Explore/Refine/Validate/Order) belong to a separate progress indicator, not the brief rail.
- Step 5 is new and load-bearing: **language and script**. বাংলা only / English only / বাংলা front + English back / English front + বাংলা back. It changes the font set, the type floor, the line-height, the tracking rules and the back-side default. It cannot be an afterthought, and it must default to bilingual — that is what most of the market actually wants.

### 3.3 Fixes to specific interactions

| Screen | Problem | Fix |
|---|---|---|
| Personality | 4th chip silently ignored | Replace-oldest with a toast, or disable unselected chips with *"3 of 3 — deselect one"* |
| Generating | 2.3 s of fake progress | Show real stage counts from the engine; if generation finishes in 400 ms, show the result in 400 ms. Never pad for theatre. |
| Results | `fit` is fabricated | Show a real score with its three top contributing factors on hover, or show no score |
| Editor | Free-text box with 4 canned chips | Free text goes to the classifier; unmapped instructions get an honest *"I can't do that — here are three things close to it"* |
| Detail | "Why" is static prose | Render from the engine's decision trace: *"Chosen because Premium + Powerful ranked dark-ground palettes 2.3× above light; foil area held to 6% to keep plating in Standard."* |
| Preflight | Advisory | **Hard failures block export.** Soft failures require an explicit "accept and continue" that is recorded on the order. |
| Everything | Desktop-only | Mobile-first rebuild; the 280/1fr/300 grid becomes a stacked flow with a bottom sheet for controls |

---

# PART II — SYSTEM

## 4. Design System Architecture

### 4.1 The rule that prevents template explosion

> **Nothing visual is ever written as markup. Everything visual is a record in a library, and there is exactly one renderer.**

Current: 12 layouts = 12 hand-written HTML blocks. Adding portrait doubles it to 24. Adding bilingual doubles it to 48. Adding a "no logo" variant doubles it to 96.

Target: 12 `LayoutTemplate` records + 8 `Palette` records + 5 `TypeSystem` records + 6 `SlotDefinition` records = **31 records driving 480+ valid combinations**, with orientation, script and logo-presence handled as parameters of the single renderer rather than as new files.

### 4.2 The six engines

**1. Grid engine.** Canonical 12×8 grid on the trim box (this is already in the prototype: `506/12` × `289/8`). All geometry is expressed in grid units and resolved to millimetres at render. Grid is orientation-aware: portrait transposes to 8×12 with slot positions remapped by the layout's declared portrait variant.

**2. Slot engine.** Six slots (`mark`, `company`, `name`, `role`, `contact`, `qr`) — already correctly specified in the prototype, including minimum sizes and fallback rules like *"falls back to the mark slot when the name is longer than 24 characters."* Promote these from a UI demo to the runtime.

**3. Typography engine.** A `TypeSystem` declares family, weights, and a scale as *ratios*, never absolute px. Absolute sizes are derived at fit time from the measured content. Enforces: three distinct hierarchy steps minimum, ≥ 1.6× ratio between name and role, 6 pt absolute floor (6.5 pt on uncoated).

**4. Colour engine.** A `Palette` declares `{bg, fg, accent, muted, hair, panel}` in **Lab**, with per-market CMYK conversions cached per ICC profile. Validates WCAG-analogue contrast at the *rendered physical size*, and computes total ink coverage before the file is ever built.

**5. Composition engine.** Given a layout, a slot set, resolved content and a density, produces final geometry. Owns the **fit ladder** (§4.4). Owns overflow policy. Never produces overlap — that is an invariant, asserted in code, not a check performed afterwards.

**6. Print engine.** Bleed, safe area, registration clearance, separations, overprint, TAC, ICC. Owns the mapping from *finish intent* ("gold foil on the monogram") to *plate geometry* (a 1-bit vector separation with 2 mm trim clearance and 0.3 mm choke).

### 4.3 A `LayoutTemplate`, as data

```jsonc
{
  "id": "lay.front.split-panel",
  "version": "3.0",
  "family": "structured",
  "grid": { "cols": 12, "rows": 8 },
  "orientations": {
    "landscape": { "supported": true },
    "portrait":  { "supported": true, "variant": "lay.front.split-panel@portrait" }
  },
  "scripts": ["latin", "arabic", "bangla", "devanagari"],
  "direction": "bidi",                       // mirrors slot x-positions under RTL
  "regions": [
    { "id": "panel", "x": 0, "y": 0, "w": 4, "h": 8, "fill": "palette.panel" }
  ],
  "slots": [
    { "ref": "mark",    "x": 1, "y": 1, "w": 2, "h": 2, "priority": 3, "required": false,
      "onAbsent": "collapse", "color": "palette.bg" },
    { "ref": "name",    "x": 5, "y": 3, "w": 6, "h": 2, "priority": 1, "required": true,
      "maxLines": 2, "fit": ["track", "step", "wrap", "shrinkBox"] },
    { "ref": "role",    "x": 5, "y": 5, "w": 6, "h": 1, "priority": 2, "required": false,
      "maxLines": 1, "fit": ["track", "step", "abbreviate", "drop"] },
    { "ref": "contact", "x": 5, "y": 6, "w": 6, "h": 2, "priority": 4,
      "capacity": { "airy": 2, "balanced": 3, "tight": 4 }, "overflow": "moveToBack" }
  ],
  "compat": {
    "requires": ["palette.hasPanel"],
    "incompatible": ["fin.letterpress", "typ.header.luxury-serif"],
    "minTrim": { "w": 74, "h": 40 }
  },
  "cost": { "inkCoverage": "high", "plateCount": 0 }
}
```

Compare with today's `{ id:'c3', layout:'split', bg:'#ffffff', ... }` plus a hand-written `<sc-if value="{{ isSplit }}">` block. The record above is renderable, validatable, portrait-capable, RTL-capable, and authorable by a designer without touching code.

### 4.4 The fit ladder — the hardest and most important part

Every text slot declares an ordered degradation ladder. The composer measures with **real font metrics** (`opentype.js` server-side; `canvas.measureText` client-side, both against the same embedded metrics table) and walks the ladder until the content fits, in this order:

1. **Track** — tighten letter-spacing within a bounded range (−1.5% to +0.5%).
2. **Step** — drop one step on the type scale, never below the slot's declared minimum.
3. **Wrap** — allow an additional line, up to `maxLines`, if the slot has vertical room.
4. **Abbreviate** — apply a typed rule: *"Chief Executive Officer" → "CEO"*, *"Muhammad" → "Md."* only where culturally correct, never invented.
5. **Shrink box** — take horizontal space from a lower-priority neighbouring slot.
6. **Drop** — remove the slot entirely if `required: false`, and record the drop in the decision trace so it can be explained to the user.

If the ladder is exhausted and the content still does not fit, the layout is **eliminated from the candidate set** — it is not rendered badly. That is why the engine generates 96 candidates and returns 6: most candidates die on fit, and dying quietly is the feature.

This single mechanism is what a competitor cannot copy without rebuilding their editor, and it is the entire answer to F2 and F3.

---

## 5. Component Taxonomy

```
COMPONENT
├── lay.  Layout          front | back | universal          ~120 at maturity
├── typ.  Type system     header | body | pairing            ~40
├── pal.  Palette         2-colour | 3-colour | duotone      ~90
├── bg.   Ground          flat | pattern | mark | gradient   ~60
├── mrk.  Logo treatment  symbol | wordmark | monogram | lockup ~30
├── cnt.  Contact block   stacked | inline | iconed | qr-behind ~24
├── qr.   QR style        framed | bleed | inverted | dotted ~12
├── fin.  Finish          laminate | foil | uv | emboss | letterpress | edge ~20
└── fmt.  Format          per market trim, orientation, corner ~14
```

Every component carries the same envelope:

```jsonc
{
  "slug": "fin.stock.edge-paint",
  "version": "1.1",
  "status": "draft|review|published|deprecated",
  "orgId": null,                                  // null = global; set = tenant-private
  "personality": { "luxury": 0.9, "exclusive": 0.8, "minimal": 0.3 },   // weights, not tags
  "industries": { "include": ["fashion","hospitality","consulting"], "exclude": ["government"] },
  "priceTier": "luxury",
  "compat":    { "requires": ["stock.gsm>=600","fin.letterpress"], "excludes": ["fin.laminate"] },
  "print":     { "plateCount": 1, "setupCost": 220, "unitCost": 0.9, "presses": ["letterpress-studio-alquoz"] },
  "deprecatedBy": null
}
```

Note the two upgrades over the prototype's version: **personality as weights rather than tags** (so ranking is arithmetic, not string matching) and **`compat` as evaluable expressions** rather than prose (so the engine can actually enforce them). The prototype's `incompatible: ['Uncoated cotton', 'Letterpress', 'Legal, government']` mixes materials, processes and industries in one list of English strings — correct thinking, unusable form.

---

## 6. Metadata Schema — `DesignSpec`

```jsonc
{
  "specVersion": "1.0",
  "specHash": "sha256:...",                  // content address; identity of the design
  "orgId": "org_...", "briefId": "brf_...", "parentSpecId": "spec_...",
  "engine": { "libraryVersion": "2026.08.03", "rankerVersion": "1.4", "seed": "a91f..." },

  "format": { "market": "AE", "trim": { "w": 85, "h": 55, "unit": "mm" },
              "orientation": "landscape", "corner": { "radius": 0 },
              "bleed": 3, "safe": 4, "sides": 2 },

  "content": {
    "primary": { "script": "latin", "dir": "ltr",
      "name": "Mohiuddin Ahmed", "role": "Chief Executive Officer",
      "company": "NOVA Technologies",
      "routes": [ { "type": "phone", "value": "+971 50 214 8890", "rank": 1 },
                  { "type": "email", "value": "m.ahmed@novatech.ae", "rank": 2 },
                  { "type": "web",   "value": "novatech.ae",        "rank": 3 } ] },
    "secondary": { "script": "arabic", "dir": "rtl", "name": "محي الدين أحمد", "role": "..." },
    "asset": { "logoId": "ast_...", "kind": "vector", "colorCount": 2 }
  },

  "design": {
    "layoutFront": "lay.front.split-panel@3.0",
    "layoutBack":  "lay.back.qr-forward@3.2",
    "typeSystem":  "typ.pairing.grotesk-tight@2.1",
    "palette":     "pal.duo.black-gold@1.0",
    "density":     "balanced",
    "finishes":    ["fin.laminate.soft-touch@1.0", "fin.foil.gold@2.0"]
  },

  "composed": {                                // OUTPUT of the composer — never hand-authored
    "front": [
      { "slot": "name", "text": "Mohiuddin Ahmed",
        "box": { "x": 35.4, "y": 20.6, "w": 42.1, "h": 9.0 },
        "type": { "family": "Space Grotesk", "size": 10.4, "weight": 600, "tracking": -0.02,
                  "lines": 1, "baseline": 27.8 },
        "color": "fg", "ladder": ["step"] }
    ],
    "back": [ /* ... */ ]
  },

  "color": { "space": "cmyk", "profile": "FOGRA51",
             "spots": [ { "name": "FOIL-GOLD", "separation": true, "overprint": false } ],
             "tac": 218 },

  "trace": {                                   // why — for the user and for support
    "briefVector": { "premium": 0.9, "modern": 0.7, "powerful": 0.8 },
    "candidatesConsidered": 96, "survivedFit": 41, "survivedCompat": 28,
    "score": { "total": 0.91, "personality": 0.94, "industry": 0.88,
               "printSafety": 1.0, "diversity": 0.72 },
    "decisions": [
      { "why": "dark ground ranked 2.3× on premium+powerful", "chose": "pal.duo.black-gold" },
      { "why": "foil plate area held to 6% to stay in Standard tier", "chose": "fin.foil.gold" },
      { "why": "role dropped one type step to fit 26 characters", "slot": "role" }
    ]
  }
}
```

`composed` and `trace` are the two additions that make everything else possible. `composed` is what preflight measures and what the renderer draws — no interpretation, no layout logic at render time. `trace` is what the Detail screen's "why" paragraph is generated from, turning your best copy into a truthful feature.

---

## 7. AI Role Definition — **LLM disabled**

**Decision: no LLM ships.** The product runs entirely on deterministic rules. This section records what that costs, what it buys, and exactly where a model would slot in later if it is ever worth it.

### 7.1 What replaces it

Everything an LLM was scoped for is implemented and working in `index.html`:

| Job | Rules implementation | What is actually lost |
|---|---|---|
| **Intent resolution** — brief → weighted personality vector | Industry priors + explicit personality selections, normalised | Free-form self-description ("I run a small catering business for weddings"). The user picks an industry and up to three traits instead. |
| **Edit instructions** — free text → typed operations | Keyword classifier over a closed operation set, English and Bangla | Unusual phrasings. The system says what it cannot do and offers three things it can — which is arguably better behaviour than a confident wrong guess. |
| **Explanation** — why this concept | Generated from the decision trace | Nothing. This is *better* without a model: the text cannot claim a reason the ranker did not use. |
| **Tagline suggestion** | Not offered | A genuine feature loss. Cut it rather than fake it. |

### 7.2 What disabling it buys

This is not a consolation list. Several of these are things the LLM version could not have had:

- **Determinism.** Same brief → same six concepts, permanently. This is what makes §12 caching, golden-file regression testing and "show me what the customer saw" possible at all.
- **Zero marginal cost per brief.** No token budget, no rate limits, no per-org quota, no cost that scales with a free tier.
- **No network dependency.** The whole engine is a pure function, so it runs client-side. Briefing and preview work with no connection — which matters on metered mobile data (§0.5.4).
- **No provider risk.** No outage path, no price change, no model deprecation, no data-handling question about customer contact details leaving the country.
- **A smaller failure surface.** Nothing to hallucinate, no prompt to break, no JSON to fail validation.

The engine composes 360 candidates in a few milliseconds. Latency was never the LLM's contribution, and neither was correctness.

### 7.3 Where a model would go, if ever

Two places, both narrow, both optional, both replacing exactly one function:

1. **`resolveIntent(brief)`** — accept free-form self-description and return the same `{vector, avoid, stated}` shape. The rules version stays as the fallback and the offline path.
2. **`classifyInstruction(text)`** — map unusual phrasing onto the same closed operation set. A returned operation outside the set fails enum validation and is discarded.

**Both are bounded by the same contract the rules obey**: the model may only emit a vector of clamped floats, or operations from a closed enum. It may never emit geometry, a layout choice, a colour, or a size. That constraint is what made hallucination structurally impossible in the original design, and it is what would keep it impossible.

**The trigger to reconsider:** measured evidence that intake abandonment or refinement failure is caused by users unable to express themselves through the structured controls. Until that evidence exists, adding a model adds cost, latency, non-determinism and a dependency, in exchange for nothing measured.

## 8. Database Schema

```sql
-- Tenancy
orgs(id, name, slug, plan, seats, billing_customer_id, created_at)
users(id, email, name, locale, created_at)
memberships(org_id, user_id, role, created_at)          -- owner|admin|designer|member|viewer|print_ops
  PRIMARY KEY (org_id, user_id)

-- Brand
brand_profiles(id, org_id, name, palette_json, type_pref_json,
               logo_asset_id, contact_json, locked bool, created_by, updated_at)
assets(id, org_id, kind, storage_key, mime, width, height, vector bool,
       color_count, quality_score, quality_report_json, created_at)

-- Design
briefs(id, org_id, brand_profile_id, created_by, input_json,
       vector_json, intent_source, created_at)          -- intent_source: llm|rules|manual
design_specs(id, org_id, brief_id, parent_spec_id, spec_hash, spec_json,
             library_version, ranker_version, label, status, created_by, created_at)
  UNIQUE (org_id, spec_hash)                            -- IMMUTABLE: never UPDATE
renders(spec_hash, variant, storage_key, bytes, created_at)   -- variant: preview|print|foil|uv|thumb
  PRIMARY KEY (spec_hash, variant)
preflight_reports(id, spec_hash, status, findings_json, created_at)

-- Library
components(id, slug, kind, org_id NULL, status, created_at)   -- org_id NULL = global
component_versions(id, component_id, version, payload_json, status,
                   published_at, deprecated_by)
compat_rules(id, subject_slug, predicate, object_expr, severity, note)

-- Commerce
presses(id, name, country, capabilities_json, lead_days, min_qty, active)
price_rules(id, market, press_id, rule_json, valid_from, valid_to)
orders(id, org_id, spec_id, press_id, qty, currency, subtotal, tax, total,
       status, proof_required bool, created_by, created_at)
order_events(id, order_id, type, actor, payload_json, created_at)   -- append-only
usage_events(id, org_id, type, tokens, cost_micros, created_at)     -- LLM + render metering
```

Three schema decisions worth defending:

1. **`design_specs` is append-only.** An edit inserts a row with `parent_spec_id` set. Versioning, forking, rollback and side-by-side comparison are queries, not features. Storage cost is negligible (a spec is ~8 KB).
2. **`renders` is keyed by `spec_hash`, not by spec id.** Two users who independently arrive at an identical design share one render. At scale with common briefs this is a meaningful hit rate.
3. **Every tenant table carries `org_id` and is protected by Postgres RLS**, not by application-layer filtering. Application filters get forgotten in one endpoint eventually; RLS does not.

---

## 9. API Architecture

API-first, versioned, idempotent on every mutation.

```
POST   /v1/briefs                     { input }                    → { briefId, vector, source }
POST   /v1/briefs/:id/generate        { count=6, seed? }           → { specs[], trace[] }
POST   /v1/specs/:id/instruct         { text | ops[] }             → { specId, ops[], unmapped[] }
GET    /v1/specs/:id                                               → DesignSpec
GET    /v1/specs/:id/history                                       → ancestry chain
POST   /v1/specs/:id/fork                                          → { specId }
GET    /v1/specs/:id/render?variant=preview&scale=2                → 302 → CDN
POST   /v1/specs/:id/preflight                                     → { status, findings[] }
POST   /v1/specs/:id/export           { formats[] }                → { jobId } → webhook
POST   /v1/quotes                     { specId, qty, market }      → { options[] }   // per press
POST   /v1/orders                     { specId, quoteId, address } → { orderId, status }
GET    /v1/orders/:id                                              → order + events

POST   /v1/bulk/generate              { templateSpecId, rowsCsv }  → { jobId }   // employee cards
GET    /v1/bulk/:jobId                                             → { done, total, bundleUrl }

# Library (admin / enterprise)
GET    /v1/components?kind=&status=   POST /v1/components   POST /v1/components/:id/versions
POST   /v1/components/:id/publish     POST /v1/components/:id/deprecate
```

**Design rules.** Every POST accepts `Idempotency-Key`. Generation and export are async with webhooks; preview and preflight are synchronous. Errors return `{ code, message, field?, remediation? }` — `remediation` is a UI-renderable next step, which is what makes the constraint-conflict screen possible without bespoke logic. The public API is the same API the web app uses; no private endpoints.

The bulk endpoint is the enterprise wedge: one approved spec + a CSV of 500 employees → 500 specs → one print job. It is nearly free to build once `DesignSpec` exists, and it is the thing Canva handles worst.

---

## 10. Print System Design

### 10.1 Output contract

| Property | Value |
|---|---|
| Format | PDF/X-4:2010 |
| Colour | CMYK. **Ask each press for its profile.** Most Dhaka presses run uncalibrated; assume FOGRA39 (coated) as the safe default and hold a per-press profile in `presses.capabilities_json` |
| Bleed | 3 mm all edges |
| Safe area | 4 mm inside trim (5 mm for foil, 6 mm for die-cut) |
| Resolution | Vector throughout; any raster ≥ 300 dpi at placed size, ≥ 600 dpi for 1-bit |
| Fonts | **Outlined.** No embedding — eliminates licensing exposure and rendering drift in one decision. |
| TAC | ≤ 300% coated, ≤ 280% uncoated |
| Registration | ≥ 2 mm clearance between any spot element and trim; 0.3 mm choke on foil |
| Separations | One PDF per special: `foil_gold`, `spot_uv`, `emboss`, `edge_paint` — 100% K on white, spot-named, overprint off |
| Minimum type | 6.0 pt coated, 6.5 pt uncoated, 7.0 pt reversed out |
| Minimum rule | 0.25 pt positive, 0.5 pt reversed |
| QR | ECC ≥ M, module ≥ 0.5 mm, quiet zone ≥ 4 modules, contrast ≥ 40%, never under foil. ✅ Implemented: real byte-mode encoder, versions 1–10, mask selection by penalty, verified by Reed–Solomon syndrome check. A payload that cannot be scanned at the available size falls back to a short link, and if even that will not fit, **no QR is emitted at all** |

The prototype's `checks` array already names most of these. It just never measures them. Once `composed` geometry exists, every one of these is a pure function over it — a few hundred lines, fully unit-testable, zero AI.

### 10.2 Preflight severity

- **Blocking** — overlap, outside bleed, below type floor, TAC exceeded, foil crossing trim clearance, missing required field, QR unscannable. Export is refused.
  **Overlap must be measured on rendered glyph extents, not on reserved slot boxes.** A right- or centre-anchored line sits inside its box but not at its left edge, so two boxes that never intersect can still collide on the page. Building this engine surfaced exactly that: uppercase slots were measured in mixed case and rendered in caps — about 12% wider — and the text ran over its neighbour while every box-based check passed.
- **Advisory** — contrast marginal at physical size, logo below recommended reproduction size, tagline empty, five-plus contact routes. Requires explicit acceptance, recorded on the order with the accepting user and timestamp.
- **Informational** — cost implications, press availability, lead-time impact.

The prototype's *"Preflight passed 16 of 19, three accepted"* is exactly the right model. Make the numbers real and record who accepted what — that record is your defence when a customer disputes a run.

### 10.3 Press integration

Three tiers, in build order: **(1) manual** — operations emails the bundle and files a tracking record; **(2) semi-automated** — SFTP drop + CSV job ticket, which covers most regional presses; **(3) API** — for partners who have one.

`presses.capabilities_json` gates the finish library per press, so a design that no available press can produce is never offered. The prototype's `costNote` — *"Two of four partner presses can produce this"* — is precisely this idea and should be computed, not written.

### 10.4 Physical proofing

Keep proof-before-run for foil, letterpress, emboss and edge-paint. Make it optional (a stated 3-day delay) for plain matte/soft-touch runs where the risk is low, so speed-sensitive customers are not forced to wait. Charge at approval, never before. This is your strongest trust mechanism — do not trade it away for conversion.

---

## 11. Scalability Plan

**Target: 1M designs / month, 50k print orders / month.**

| Stage | Cost driver | Per-unit | At 1M/mo |
|---|---|---|---|
| Intent (LLM) | Tokens | ~$0.004 | ~$4k, minus 40–60% cache hits |
| Generation | CPU, pure function | ~15 ms | ~4 core-hours/day |
| Preview render | SVG in-process | ~8 ms, ~40 KB | Trivial; CDN absorbs delivery |
| Print render | PDF composition | ~40 ms, ~4 MB | Only on paid export — ~50k/mo |
| Storage | Specs + renders | ~8 KB + ~4 MB | ~200 GB/mo, lifecycle to cold at 90 days |

The architecture's scaling property is that **the expensive operation is the rare one**. Previews — the thing users generate constantly — are cheap SVG strings served from a CDN by content hash. PDFs — expensive — only happen when someone pays.

Concretely: `api` and `engine` autoscale on CPU; `render-print` is a queue-backed worker pool with a dead-letter queue and bounded retries; the intent service sits behind a circuit breaker with a rules fallback. Database load is read-dominated — one primary plus read replicas for library and dashboard queries carries this comfortably.

**Load-shedding order under stress:** disable bulk generation → serve cached previews only → queue exports with an ETA → degrade intent to rules. The product stays usable at every step; a user with a slightly less nuanced brief is a far better outcome than an error page.

---

## 12. Caching Strategy

| Layer | Key | TTL | Hit rate (est.) |
|---|---|---|---|
| Intent | `sha256(normalised brief input)` | 30 days | 40–60% (briefs cluster hard by industry) |
| Library snapshot | `libraryVersion` | Until publish | ~100% |
| Candidate set | `sha256(vector, libraryVersion, rankerVersion, seed)` | 7 days | 25–40% |
| Preview render | `spec_hash + variant` | Immutable, 1 year | 70–85% |
| Print render | `spec_hash` | Immutable | 30% (re-orders, proof→run) |
| Explanation | `spec_hash` | 30 days | High |
| Quote | `spec_hash + qty + market` | 24 h | Moderate |

**Determinism is what makes caching possible.** `seed = sha256(briefId ‖ libraryVersion ‖ rankerVersion)` means the same brief returns the same six concepts, permanently — until you publish a library change, which correctly invalidates them. That property also gives you: reproducible support ("show me what this user saw"), regression testing against golden files, and A/B testing of ranker versions with clean attribution.

Publishing a component version bumps `libraryVersion` and rolls candidate caches; **it never invalidates existing specs**, because a spec pins the versions it was built from. A user's saved design cannot change under them. That guarantee is non-negotiable in a product that people order physical goods from.

---

## 13. Multi-tenant SaaS Design

### 13.1 Model

Org is the unit of tenancy; personal accounts are single-member orgs, so there is no second code path.

**Roles**

| Role | Design | Order | Brand profiles | Library | Members | Billing |
|---|---|---|---|---|---|---|
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Designer | ✓ | request | ✓ | tenant only | — | — |
| Member | own only | request | use only | — | — | — |
| Viewer | — | — | — | — | — | — |
| Print ops | — | ✓ | — | — | — | — |

### 13.2 Tenant libraries

Resolution order at generation time: **org override → industry pack → global**. An org can (a) add private components, (b) hide global components, (c) lock a subset so members can only generate within brand. Locking is the enterprise feature that sells: *"every card from this company will be on-brand, and nobody needs to police it."*

### 13.3 Isolation

Postgres RLS on `org_id` for every tenant table. Object storage prefixed by org with signed, short-lived URLs. Per-org rate limits and token budgets so one tenant cannot exhaust the LLM quota. Full audit log on library publishes, template locks, order approvals and preflight acceptances — enterprise buyers ask for this in procurement, without exception.

---

# PART III — BUSINESS

## 14. MVP Definition

**Scope: one market, one language pair, one press, one guarantee.**

**In**
- Brief: 7 steps, mobile-first, only step 1 required
- Intent resolution: LLM with a rules fallback that is good enough to ship alone
- Library as data: 12 layouts, 8 palettes, 5 type systems, 6 slots, 6 finishes — all records, zero hardcoded markup
- **One renderer**, driven by slots, with the full fit ladder
- **Bangla + English bilingual** (this is the market you chose; without it the MVP does not address it). Per-script type floors, line-heights, tracking rules and optical sizing — all implemented in the reference engine
- Six concepts, deterministic, with real scores and real traces
- Editor: typed operations only, free text through the classifier
- Preflight: blocking + advisory, real geometry
- Export: PDF/X-4 + foil separation + preview PNG + SVG
- Order: quote → proof → approve → run, two Dhaka presses (never one — see §19)
- Auth, single-member orgs, one brand profile, saved designs

**Out — and each of these is a deliberate cut**
- Mockup renders (F11 — pretty, expensive, sells nothing yet)
- Layout builder UI (author components in git; the visual builder is a V2 internal tool)
- Component studio UI (same reason)
- Compare view, tracking screen (email updates instead)
- Four pricing tiers → two
- Multi-tenant, teams, bulk, template locking
- Markets beyond Bangladesh
- Raster logo auto-vectorisation (accept SVG/PDF/EPS; reject low-quality raster **at upload**, with a clear explanation)

**Also in MVP, specific to this market:** bKash/Nagad and cash-on-delivery, a Bangla UI, a Facebook-shareable preview image, and the doctor / RMG / advocate / shop verticals as first-class presets.

**Success criteria before building anything in V2:** 100 paid orders, ≥ 99% print-correct rate, ≥ 40% of briefs reaching a concept view, median brief→export under 10 minutes, LLM cost per brief under ৳1, and — the one that decides the model — **at least 3 of 5 pilot print shops still using it unprompted after a month.**

---

## 15. V2 Roadmap (months 4–9)

0. **The print-shop channel** — outlet accounts, per-shop pricing, an operator-mode UI built for a counter, offline-tolerant. If the §14 pilot succeeded, this is V2 item one and everything else waits.
1. **Multi-tenant + teams + roles + tenant libraries + template locking** — unlocks the highest-value corporate segment (banks, RMG groups, pharma, NGOs).
2. **Bulk employee-card generation** (CSV → N specs → one order). Small build on top of `DesignSpec`; large differentiator.
3. **Markets 2–4**: West Bengal/India (Bangla already done, add Devanagari and Hindi), then the Bangladeshi diaspora in the UK and Middle East — they order cards in both scripts and pay in GBP/AED at far higher margin.
4. **Logo pipeline**: vector ingest, raster quality gate with an honest scorecard, monogram auto-generation, one-colour/reversed variant derivation.
5. **Press marketplace**: route each order to the cheapest capable press within the customer's lead-time constraint; margin management per route.
6. **Visual component authoring** (the prototype's layout builder, made real) so designers extend the library without engineering.
7. **Public API + white-label embed** for print shops — the reseller channel.
8. **Brand profile intelligence**: extract palette and type from an existing logo or website, propose a profile.

---

## 16. V3 Vision (months 10–24)

**The insight that makes this more than a card company:** `DesignSpec` is not card-specific. It is *content + slots + constraints + print rules*. Change the format record and the same engine produces:

- Letterhead, compliment slips, envelopes (identical constraint class)
- Email signatures and digital cards (RGB, HTML — a different renderer over the same spec)
- Name badges, door signs, vehicle lettering (different substrates, same slot logic)
- Presentation and document templates (looser constraints, same type/colour engines)

That is the path from "card maker" to **small-business identity system** — and it is reachable because you refused to let anyone freehand a layout in V1.

Also in V3: NFC/QR-linked digital card with scan analytics (closing the loop — *you now know whether the card works*), reorder automation on role change, and an agency tier where a design studio manages 100 client brands in one console.

---

## 17. Monetization Strategy

### 17.1 What is wrong with the prototype's model

Four subscription tiers. **A subscription for an annual purchase is the wrong shape anywhere, and in Bangladesh it is worse than wrong.** An individual designs cards once every 18 months. Monthly billing guarantees churn immediately after their single moment of value. On top of that, card-based recurring billing has thin penetration here — the payment rails people actually use (bKash, Nagad) are built for one-off pushes, not for silent monthly pulls. A subscription-first product will fail at the payment layer before it fails at the value layer.

### 17.2 Recommended: transaction-led hybrid

All figures below are **estimates to validate against real quotes** from two or three Dhaka presses before you commit to a price list. Treat them as the shape of the model, not as the model.

| Line | Price | Margin | Why |
|---|---|---|---|
| **Shop channel** (white-label per outlet) | ৳500–1,500/mo, or ৳20–40 per card design | 80%+ | The scale play. 40,000 outlets, existing customers, zero CAC per end-user |
| **Print orders** (broker, direct) | ৳600 / 100 · ৳1,300 / 500 · ৳2,400 / 1,000 | 30–40% gross | Customer already intends to buy; we route to a partner press |
| **File pack** (design only, print anywhere) | ৳199–499 one-off | ~98% | The large segment that will always print locally. Priced below what a shop charges for design so it is never the expensive option |
| **Corporate / bulk** | ৳3–25 lakh/yr | ~85% | CSV → 500 staff cards → one invoice. Banks, RMG groups, pharma, NGOs |
| **Teams** (agencies, coaching chains, brokerages) | ৳400–600/seat/mo | ~90% | Brand governance, locked templates, shared library |
| **Pro** (individual, optional) | ৳1,200/yr — annual only, never monthly | ~95% | Only for genuinely repeat designers. Annual matches how bKash/Nagad are actually used |

**Free tier**: unlimited briefs, six concepts, watermarked previews, no export, no order. Cost per free user is one cached intent call — a fraction of a taka. Sustainable, and it fills the funnel.

**Payments.** bKash and Nagad first (they are the market, not an alternative to it), then cards via SSLCommerz / aamarPay / ShurjoPay, then **cash on delivery**, which is still the default expectation for physical goods here and must be supported from day one for print orders. Do not launch card-only.

**Delivery.** Pathao / Steadfast / RedX inside Dhaka (~৳60–90), Sundarban or courier partners outside (~৳120–170). Delivery cost is a material share of a ৳600 order — build it into the quote explicitly rather than absorbing it.

### 17.3 The pricing principle

**Charge at the moment of realised value — the file or the print — not for access to the tool.** The tool is cheap to run; the output is what the customer wanted. This also aligns you with the print-correct guarantee: you are paid when the thing works.

Unit economics sanity check at 1,000 cards, matte laminated, direct: revenue ~৳2,400 · press ~৳1,400 · delivery ~৳80 · payment gateway ~2% (~৳48) · engine cost under ৳1 → **~৳870 gross, about 36%**. Reprint reserve 2% of COGS.

The number that decides the business: **CAC must stay under roughly ৳400** for a customer whose 12-month reorder rate is 30%+. Direct-to-consumer paid acquisition in Bangladesh will not reliably hit that. The shop channel will, because the shop already owns the customer. That single arithmetic is the reason §1.2 puts print shops in row one.

---

## 18. Competitive Positioning

| | Canva | Adobe Express | VistaCreate | Vistaprint | **CARDWORKS** |
|---|---|---|---|---|---|
| Who designs | User | User | User | Template picker | **System** |
| Output correctness | User's risk | User's risk | User's risk | Partly checked | **Guaranteed and blocking** |
| Layouts | Templates (thousands of files) | Templates | Templates | Templates | **Composed from components** |
| Long names / Bangla | Overflows | Overflows | Overflows | Manual | **Fit ladder + per-script metrics** |
| Foil / letterpress / emboss | No | No | No | Catalogue only | **First-class, plate-aware** |
| Bangladesh trim + stock | US-centric | US-centric | US-centric | Not served | **Native — 89 × 51, local stocks** |
| Explains its choices | No | No | No | No | **Yes, from a real trace** |
| Bulk employee cards | Painful | Painful | No | Manual | **CSV → N specs → one order** |
| Mobile | Canvas on a phone | Canvas on a phone | Canvas on a phone | Catalogue | **Native — no canvas exists** |

### 18.1 The competitor that actually matters here

The table above is the international field. In Bangladesh your real competition is **the print shop's free design service** — you walk into Nilkhet, someone opens a CorelDRAW template, types your name, and prints it. It costs nothing extra, it takes an afternoon, and the result looks like everyone else's card.

| | Nilkhet shop | CARDWORKS |
|---|---|---|
| Price of design | Free (bundled) | Free to design; paid at the file or the print |
| Time | An afternoon, in person | Two minutes, on a phone |
| Result | A template with your name in it | Composed to your content, validated, unique |
| Bangla typesetting | Whatever the operator does by eye | Per-script floors, matra clearance, conjunct-safe sizing |
| Correctness | Discovered after 1,000 cards are printed | Blocking preflight before anything is printed |

**You cannot beat free on price, so do not compete — distribute.** Give the shop the tool, let it charge more, take a cut (§1.2, §17.2). The shop keeps the customer relationship it already has; you get 40,000 storefronts you did not have to acquire.

**Why we win:** the competitors sell tools and move the risk to a user who cannot evaluate it. We sell an outcome and absorb the risk into a constraint system.

**Why we are not a template tool:** a template is a file. A CARDWORKS design is a resolved composition — layout × palette × type × content × finish × market — assembled at request time under constraints. Twelve layout records produce more valid, correct designs than a thousand template files, and every one of them is print-validated by construction.

**Where we lose, honestly:** the user who wants to nudge an element 2 mm. We will never serve them, and pretending otherwise would cost us the guarantee. Also: brand recognition, asset breadth, and free-tier generosity. Compete on correctness and on markets they treat as an afterthought — not on features.

---

## 19. Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| **Print defect on a paid run** | Critical | Blocking preflight; physical proof on specials; press-specific profiles; 2% reprint reserve; recorded acceptance of advisory findings |
| **Bangla script failure** | Critical | Bangla in MVP scope, not V2. Per-script floors, line-height, tracking and optical sizing — already implemented in the reference engine. Native-speaker review of every layout, and a print test of conjuncts at 7.5 pt on the actual stock before launch. |
| **Print-shop channel rejects the product** | Critical to the model | Pilot with 5–10 Nilkhet/Fakirapool shops before building the channel. If shops will not adopt, the economics in §17.3 do not close and the plan needs rethinking, not more features. |
| **Price expectation anchored at free** | High | Never sell "design" as a line item to consumers. Sell the card, the file, or the shop's capability. |
| **Load-shedding / connectivity** | Medium | The composer is a pure function — ship it client-side so briefing and preview work offline; only export and order need the network. |
| **Layout engine underestimated** | High | It is the single hardest component. Budget 8–10 engineer-weeks for composer + fit ladder alone, and build the golden-file test suite first. |
| **Font licensing** | High | OFL-only policy, enforced in the component publish pipeline. Outline everything. Never embed. |
| **Trademark abuse via logo upload** | Medium | Terms, no proactive policing at MVP, documented takedown, retain uploads for dispute resolution |
| **Press concentration** | Medium | Two capable presses per market before scaling volume; capability data drives failover automatically |
| **LLM provider outage or price change** | Medium | Rules fallback that ships in MVP; intent is a small, portable task — model-agnostic by design |
| **Template explosion returns** | Medium | Enforce in CI: no visual markup outside the renderer; a lint rule that fails the build on layout-specific branches |
| **Subscription churn** | Medium | Transaction-led model (§17); subscriptions only where usage genuinely repeats |
| **Accessibility / procurement blocker** | Low–Medium | Fix contrast and focus states now (F12), while the surface is small |
| **Free-tier abuse** | Low | Per-org token budget, watermarked previews, export behind payment |

---

## 20. Failure Scenarios

| Scenario | Detection | Behaviour |
|---|---|---|
| LLM times out or returns invalid JSON | Schema validation, 3 s timeout | Retry once → rules-based resolver over the structured brief. **Generation always succeeds**; the intake is already structured, so degradation costs nuance, not function. |
| No candidates survive constraints | Engine returns 0 | The constraint-conflict screen — already designed. Show which constraint eliminated the most candidates, with three ranked relaxations and their cost consequences. |
| Content cannot fit any layout | Fit ladder exhausted on every candidate | Offer: shorten a field · portrait orientation · larger trim · move contact to the back. Never render an overflowing card. |
| Logo too low-resolution | Quality gate at upload | Reject **at upload**, with the measured numbers and three options: vector re-upload, monogram, text-only. Never at export time — that is where trust dies. |
| Render worker saturation | Queue depth alarm | Previews continue (cached/in-process); exports queue with an honest ETA; the UI says so plainly. |
| Press rejects the file | Press callback / ops flag | Auto-reprocess with that press's profile; escalate to ops within 4 h; customer notified before they notice. |
| Payment succeeds, order fails | Reconciliation job | Transactional outbox; auto-refund within 24 h; incident record on the order |
| Component publish breaks existing designs | Golden-file suite in CI | Impossible by construction — specs pin component versions. Publishing rolls candidate caches only. |
| Preflight passes but print is wrong | Customer report | Root-cause into the check suite as a new blocking rule + a regression golden file. Every defect must produce a test. |
| Tenant data exposure | RLS + integration tests per role | RLS at the database, not the application. Cross-tenant access tests run on every deploy. |

---

## 21. Improvements to the Provided Design File — the work list

Ordered by impact. Items marked **⛔** are prerequisites for anything else.

### Architecture
1. **⛔ Delete the twelve hardcoded layouts in `CardFace.dc.html`.** Replace with one renderer walking a `LayoutTemplate`. A working version is in `index.html` — 9 layouts + 4 back faces as data, one `renderSVG()`, verified to contain zero layout ids. *(F1)*
2. **⛔ Bind intake to the card.** The 78 inputs must reach `DesignSpec.content`. Remove every literal "Mohiuddin Ahmed" and "NOVA Technologies" from the renderer. *(F1)*
3. **⛔ Promote `SLOTS` from a demo to the runtime.** The layout builder already declares the right model — minimum sizes, fallback rules, grid positions. Make it the thing that renders. *(F1)*
4. **⛔ Build the fit ladder with real font metrics.** Implemented and tested in `index.html`: track → step → wrap → abbreviate → reduceRoutes → drop, measured via canvas metrics, with elimination when the ladder is exhausted. Nothing about correctness works without measurement. *(F2)*
5. ✅ **Reference implementation exists.** Script is resolved per slot; per-script floors, line-height, tracking bounds and optical sizing are in `index.html`. Port it, then add RTL mirroring only if you later take an Arabic market. *(F3)*
6. ✅ **Done, both halves.** Ranking, scoring and explanation: 360 candidates → real fit → preflight → four-dimension score → diversity → six, with the "why" generated from the decision trace. And the **edit grammar**: free text (English and Bangla) is classified into operations from a closed set, which re-select components and re-compose. `promoteSlot('name')` picks a layout that gives the name more room — it never scales type in place. Unmapped input returns zero operations and says so. *(F4)*
7. Split `renderVals()` — 120 keys in one function will not survive the second engineer. One view-model module per screen.
8. ✅ **Done in the reference engine.** State serialises to the URL hash (shareable link) and to localStorage (survives a refresh). Uploaded assets are deliberately excluded from the shareable state. Real routing and server-side persistence remain Phase 2.

### Correctness of what is shown
9. ✅ **Done.** `fit` is now computed from personality fit, industry fit, print safety and legibility headroom. Verified: changing the personality changes the winning concept and every score; changing the industry alone changes the ranking. *(F5)*
10. ✅ **Done, properly.** Orientation is now declared per layout, not asserted globally. The grid follows the trim (12×8 landscape, 8×12 portrait, 10×10 square) so cells stay roughly square, and portrait/square compositions are **authored, not stretched** — a test asserts the portrait boxes are not the landscape boxes reused. Five layouts declare portrait, three declare square; the rest are eliminated in those formats with a reason a UI can show. *(F6)*
11. Derive preflight counts from the check run; retire "16 of 19". *(F6)*
12. ✅ **Done, with an honesty rule worth keeping.** The explanation only says *"you asked for X"* about axes the user actually selected; when the preference came from an industry prior it says so and invites the user to state one. Attributing an inferred preference to the user is the same class of error as the hardcoded 91/100 — smaller, but the same kind. *(F4, §6)*
13. Compute `costNote` and press availability from `presses.capabilities_json`. *(F11)*
14. ✅ **Cost model implemented** (BDT): press base by quantity + per-finish setup and per-unit + delivery zone + margin, returning an itemised quote with unit price and gross margin. ⚠ The numbers are placeholders — **replace them with real Dhaka press quotes before showing a price to anyone.** VAT still to be added once the NBR treatment is confirmed. *(F11)*

### UX
15. Rail says seven steps and shows seven. Move post-generation stages to a separate indicator. *(F6)*
16. Fix the personality cap — replace-oldest or an explicit message. *(F8)*
17. Rename the shuffled step flags to match display order. *(F9)*
18. **Mobile-first rebuild.** The reference engine reflows cleanly to 320 px (single column, wrapping chip rows, no horizontal scroll) — but reflowing is not the same as being designed for a phone. Still needed: bottom-sheet controls, a thumb-reachable primary action, and one-question-per-screen briefing. This remains the largest UX gap relative to your actual market. *(F7)*
19. Add the missing states: empty, loading, error, offline, unsaved-changes, permission-denied. Only the constraint-conflict empty state exists today.
20. ✅ **Done for the reference engine**, and asserted in CI: every control has an associated `<label for=…>`, chip groups use `role="group"` with an accessible name, gallery tiles are `role="button"` + `tabindex="0"` with Enter/Space handlers and `aria-pressed`, and a visible `:focus-visible` ring exists. The product UI must repeat this — the tests in §33 of the suite are the pattern to copy. *(F12)*
21. Generating screen: show real stage counts, and if the work takes 400 ms, show the result in 400 ms.

### Product
22. Remove the Business tier until multi-tenancy exists, or build it. Do not sell what the architecture cannot deliver. *(F10)*
23. Restructure pricing per §17 — transaction-led, not subscription-first.
24. Cut mockups from MVP. *(F11)*
25. ✅ **Done.** `gradeLogo()` scores vector vs raster, computes effective dpi at the size the logo will actually be placed at, and rejects at upload with the measured numbers and three concrete options. A raster logo is always flagged as unfoilable. *(F11)*
26. ✅ **Done.** `bulkGenerate()` — CSV → one composed, individually preflighted card per row. Verified on a 200-row run; rows that cannot be printed are reported, never silently dropped.
27. Write down the OFL-only font policy and enforce it at component publish. *(F13)*

---

## 22. Build sequence

The blueprint says *what*. This says *in what order*, and *what must be true before the next phase starts*. Phases are gated: a failed gate means stop and re-plan, not continue and hope.

### Phase 0 — Validate the two assumptions that decide the business *(2–3 weeks, no code)*

Everything downstream depends on these, and both are cheap to test now and expensive to discover later.

| Test | Method | Gate |
|---|---|---|
| **Will print shops adopt it?** | Sit in 5–10 shops in Nilkhet / Fakirapool / Banglabazar. Show the engine on a laptop. Ask what they'd charge and whether they'd use it. | ≥ 3 of 5 say yes *and* name a price |
| **Will presses accept our files?** | Send the engine's print geometry to 3 presses. | ≥ 2 accept a PDF/X-4 without "fixing" it |
| **Do Bangla conjuncts hold at 7.5 pt?** | Print a test sheet: ক্ষ, ঙ্গ, ন্ত্র at 6.5 / 7 / 7.5 / 8 pt on 300 gsm art card. | A legible floor is identified — it is one constant in `SCRIPTS.bangla.minPt` |
| **What do things actually cost?** | Written quotes from 3 presses for 100/500/1000, with and without foil. | `PRESS_BASE` and `FINISH_COST` replaced with real numbers |

**If the shop gate fails, the §17 economics do not close.** That is a reason to change the model, not to build harder.

### Phase 1 — Productionise the engine *(4–6 weeks)*

Port `index.html` to the service shape in §2. Nothing here is new design work; it is the reference implementation made durable.

1. Extract the engine into a pure, dependency-free module — `compose`, `fitSlot`, `renderSVG`, `preflight`, `generate`, `classifyInstruction`. It already has no I/O; keep it that way so it can run server-side *and* in the browser for offline briefing (§19).
2. Move the library (layouts, palettes, type systems, slots) into versioned JSON, loaded as a snapshot. Keep the CI assertion that the renderer contains zero layout ids.
3. Replace canvas measurement with server-side font metrics (`opentype.js`) — same numbers, no DOM.
4. Build the real PDF/X-4 writer against the geometry the engine already emits: CMYK conversion, ICC per press, spot separations, **fonts outlined**. With the QR encoder, logo gate and bulk path now done, **this is the only genuinely new engineering task left in Phase 1** — budget it generously.
5. Stand up the QR redirect service. The engine already falls back to a short link when a vCard will not fit at a scannable size; that link needs somewhere to go, and it is also the scan-analytics loop from §16.
6. Golden-file suite: ~200 specs rendered on every commit; any geometry drift fails CI. The existing 141-assertion suite is the seed.

**Gate:** a card designed in the browser prints correctly from a partner press, twice, from two different presets.

### Phase 2 — The product around it *(6–8 weeks)*

Accounts, `design_specs` as an append-only table (§8), the API (§9), bKash/Nagad + cash-on-delivery, order flow with proof-before-charge, and a Bangla-first mobile UI. Build the mobile UI *first* and the desktop one as a widening of it, not the reverse.

**Gate:** 100 paid orders, ≥ 99% print-correct rate, median brief→export under 10 minutes.

### Phase 3 — The channel *(8–10 weeks)*

Shop accounts, operator-mode UI designed for a counter (large targets, one screen, works on a weak connection), per-shop pricing and settlement. This is the scale play from §1.2.

**Gate:** ≥ 3 of 5 pilot shops still using it unprompted after a month.

### Phase 4 — Leverage

Multi-tenant + corporate bulk (CSV → N specs → one invoice), then markets 2–4 per §15.

### What to resist

- Building the visual component-authoring tool before the library stops changing weekly. Author components in git until then.
- Adding layouts to fix a weak result. If six concepts feel wrong, the *ranker* is wrong — a tenth layout hides that.
- Photoreal mockups. They cost render time and sell nothing at this stage.
- An LLM before the rules resolver is genuinely the limiting factor. It is currently not.

---

## 22. Final principle

> **The user describes who they are. The system understands, assembles from validated components under explicit constraints, explains its reasoning honestly, proves the physical result, and only then takes payment.**

Every part of that sentence exists somewhere in the prototype already — as copy, as a screen, as a data structure. The work is to make the code mean what the interface already says.
