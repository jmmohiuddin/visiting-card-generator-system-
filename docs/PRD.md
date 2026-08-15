# CARDWORKS — Master Product Requirements Document

Bangladesh Edition · v1.0 · 14 August 2026

Status: **Draft for owner review** · Author: Claude, compiled from the founder's product vision, the existing `CARDWORKS-PRODUCT-BLUEPRINT.md` (9 Aug 2026), and a direct audit of the deployed codebase at `cardworks-bd.netlify.app`.

Table of Contents

* * *

## 0\. Read this first

This PRD governs a product that is **already partly built and live**. That changes what a PRD is for here: it is not a blank\-page spec, it is the single source of truth that reconciles three things that currently disagree with each other — the founder's original verbal vision, the technical blueprint an earlier session wrote, and what the deployed code actually does. Two decisions the founder made explicitly during this audit are locked in below and drive every section that follows:

**Decision 1 — Editing model.** CARDWORKS generates designs from a guided brief; it never offers a free\-form drag\-and\-drop canvas. Refinement happens through typed instructions ("make my name bigger") that the system maps to a closed set of operations, never through nudging elements by hand.

**Decision 2 — Market.** The MVP targets Bangladesh only — Bangla \+ English, BDT pricing, Dhaka presses, bKash/Nagad payments, 89×51 mm trim. Other markets are a funded V2/V3 decision, not a day\-one requirement.

Section 1 explains why the drag\-and\-drop question mattered enough to ask, and Section 2 is the audit — what is actually shipped today versus what the blueprint assumed, because that gap is the most important input into everything else in this document.

* * *

## 1\. Why "no canvas" is the whole product

### 1\.1 The problem, precisely

The founder's own framing — *"people spend so much time in the shop to design a visiting card"* — names the symptom. The actual disease is sharper: **a non\-designer cannot tell whether a design is good, and cannot tell whether a file will print correctly, and both mistakes are only discovered after paying for a run of cards.** A blank canvas (Canva's model) hands that risk to the user and calls it freedom. It gives someone who does not know that 5pt type disappears under office light, or that gold foil 1mm from the trim will drift, exactly the tool most likely to let them make those mistakes with confidence.

A guided brief that composes from a validated component library removes the risk instead of relocating it. That is the actual bet this product makes, and it is the reason the codebase already contains zero drag\-and\-drop code four days into the build. Decision 1 above ratifies a choice the engineering already made; this PRD is not proposing something new, it is making an implicit architectural decision explicit and binding so future work does not quietly reverse it.

### 1\.2 What "no canvas" costs, honestly

Users who want to nudge one element 2mm to the left will never be satisfied by this product, and pretending otherwise would cost the thing that makes it defensible. This is a deliberate exclusion, not an oversight — see §5.4.

### 1\.3 Positioning statement

> For professionals and organisations in Bangladesh who need a visiting card that is correct, CARDWORKS turns a seven\-question brief into six print\-ready designs. Unlike Canva, you never touch a canvas and the output cannot be wrong — because every design is assembled from print\-validated components under explicit constraints, not drawn freehand.

* * *

## 2\. Audit — what is actually built, as of 14 August 2026

The founder asked for an audit before enhancement. This is it, verified directly against the code and a live test run, not against README claims.

### 2\.1 What's real and working

| Claim | Verified how | Result |
| --- | --- | --- |
| Rules\-based generation engine (no LLM) | Read `index.html` engine code | Confirmed — 360 candidates enumerated, scored on 4 dimensions, 6 returned |
| Fit ladder (track→step→wrap→abbreviate→reduce→drop) | Read engine \+ test file | Confirmed — measured against real font metrics, not approximated |
| Bangla\-specific typography (matra clearance, conjunct floor, optical compensation) | Read `SCRIPTS` table in engine | Confirmed — 7.5pt Bangla floor vs 6.0pt Latin, 1.12× optical compensation |
| QR encoder is a real implementation, not a library call | Read encoder \+ test assertions | Confirmed — byte mode, ECC M, Reed–Solomon syndrome check per block |
| Automated test suite | **Ran it live**\: `node cardworks-engine.test.cjs` | **162/162 assertions pass**, 0 failures |
| All 21 screens from the original prototype | Grepped section markers in `index.html` | Confirmed — Brief, Generating, Concepts, Detail, Validate, Export, Library, Bulk, Start, Order, Tracking, Dashboard, Profiles, Mockups, Pricing, Sign\-in, Settings, Studio, New Component all exist |
| Live, deployed site with a database | Read `README.md`, `netlify/functions/*.mjs` | Confirmed — `cardworks-bd.netlify.app`, Neon Postgres, 3 working API endpoints |
| Design persistence, content\-addressed | Read `designs.mjs`, `db/schema.sql` | Confirmed — specs are hashed, immutable, append\-only; saving the same design twice is idempotent |
| QR\-scan → contact page \+ vCard download | Read `card.mjs` | Confirmed — working `/c/:code` resolver with scan analytics |
| Basic order flow with status tracking | Read `orders.mjs`, `db/schema.sql` | Confirmed — proof\-before\-charge status machine exists as an append\-only event log |

This is a materially stronger starting position than "an idea and some sketches." The engine — the hardest, most defensible part of the product — is real, tested, and the single most important architectural bet (constraint\-based composition instead of a template library) is proven out in working code.

### 2\.2 What the README/blueprint claim that isn't there yet

| Gap | Evidence | Why it matters |
| --- | --- | --- |
| **No real payment integration.** | `orders.mjs` accepts a client\-computed `total` and sets status straight to `awaiting_approval` — there is no bKash/Nagad/SSLCommerz call anywhere in the codebase. | Revenue cannot be collected today. This is not a V2 item — it is the biggest hole in the current MVP. |
| **No accounts/auth.** | `owner_key` is a random string generated client\-side and stored in `localStorage`; there is no login, password, or identity verification. | "My designs" works per\-browser, not per\-person. A user who clears their browser or switches devices loses everything, including order history. |
| **No real print output (PDF/X\-4).** | README states this explicitly: *"the engine emits the geometry a PDF writer consumes, not the PDF."* | Nobody can currently download a file a press can print from. This is correctly flagged in the blueprint as the largest remaining engineering task — the audit confirms it is still open. |
| **Press integration is a text field.** | `orders.mjs`\: `press` is stored as a free string (`'Unassigned'` default); `presses.capabilities_json` from blueprint §8 does not exist as a table. | No routing, no capability gating, no real quote. |
| **Cost numbers are placeholders**, by the blueprint's own admission. | README §"Two things to fix before anyone sees a price." | Nobody has called a Dhaka press yet. Quoting today would be quoting fiction. |
| **Bangla conjuncts are reasoned, not print\-tested.** | README: *"reasoned from how conjuncts stack, not measured on a Dhaka press."* | The single most defensible technical claim in the whole product (7.5pt Bangla floor) has not been validated on paper. |
| **No multi\-tenancy**, despite `orgs`/`memberships` appearing in blueprint §8. | `db/schema.sql` (the live schema) contains none of those tables. | Correctly not built yet — see §5.2, this is intentionally V2. |

### 2\.3 The finding that matters most: breadth before validation

The blueprint's own §22 "Build sequence" is explicit that **Phase 0 — a 2–3 week, no\-code validation of the two assumptions the business model depends on — should happen before any production engineering.** Those four tests are: will print shops adopt this, will presses accept the output files, do Bangla conjuncts actually hold at 7.5pt on real stock, and what do things actually cost. None of the four appear to have been run — there is no evidence in the repository of shop visits, press conversations, a print test sheet, or real quotes.

Instead, engineering went the other direction: **all 21 screens of the original prototype now exist**, including several the blueprint explicitly recommended cutting from MVP for exactly this reason — Mockups, the component Studio, four pricing tiers, a Dashboard. Building screen breadth is legible progress and feels productive, but none of it de\-risks the two things that actually decide whether this business works: will a Nilkhet shop pay for this, and will a Dhaka press print from this file without "fixing" it in CorelDRAW first.

**This PRD's single strongest recommendation:** stop adding screens. Run the four Phase 0 tests in §8.1 before writing another line of product code. They cost roughly three weeks and some shoe leather, not an engineering sprint — and every subsequent number in this document (pricing, the shop\-channel thesis, the Bangla type floor) is currently an assumption that only those four tests can confirm or kill.

* * *

## 3\. The customer

### 3\.1 Segments, ranked by realistic near\-term value

| Segment | Volume in Bangladesh | What they pay for | Est. annual value |
| --- | --- | --- | --- |
| **Print shops** (Nilkhet, Fakirapool, Banglabazar, upazila towns) | \~40,000\+ outlets | A front\-end that removes their design labour and lets them charge the walk\-in customer more | ৳2,000–15,000 per shop |
| **Corporate card programmes** (banks, RMG groups, pharma, NGOs) | Low count, high value | Brand governance \+ bulk generation for 500\+ staff on one invoice | ৳3–25 lakh |
| **Professionals** (doctors, advocates, engineers, brokers, tutors) | High | A card that signals credibility; reorders on chamber/role change | ৳1,500–5,000 per order |
| **SMB owners** (shops, restaurants, service trades) | Highest count | Speed, and not having to go to Nilkhet in person | ৳500–2,500 per order |

**The MVP builds for rows three and four — professionals and SMB owners are the direct users of the guided brief. The leverage, and the reason unit economics work in a low\-ARPU market, is row one: print shops are a distribution channel with 40,000 existing storefronts and existing customer trust, not a competitor.** Every architectural decision (a machine\-readable `DesignSpec`, an API) is chosen so all four rows are unlocked by the same primitive later, without a rebuild.

### 3\.2 Personas

**Dr. Nasrin — chamber physician, Dhanmondi.** Needs a new card after moving chambers. Her card must carry `MBBS (DMC), FCPS (Medicine), MRCP (UK)`, two mobile numbers, and chamber hours — content a Western template has no field for. She currently gets this done at a local press in twenty minutes with zero input into how it looks. Success looks like: she fills a two\-minute brief on her phone between patients, picks from six designs that already handle her long qualification string without asking her to abbreviate anything, and a shop nearby prints it that afternoon.

**Rafiq — owner, RMG buying house, Gulshan.** Needs 40 export\-facing bilingual cards for his sales team before a European trade fair in three weeks. He currently has an assistant email a designer, wait four days, and get back one static template that everyone's card looks identical to. Success looks like: one approved design, a CSV of 40 names and titles, one order, one invoice.

**Hasan — counter operator, a print shop in Nilkhet.** Currently opens CorelDRAW, finds last week's template, and retypes a name over someone else's old job. He is not the end customer paying CARDWORKS — he is the channel. Success looks like: a tablet\-friendly tool that produces something better than his template library in two minutes, letting him charge ৳50 more per job for a result his customer visibly prefers, for a small cut to CARDWORKS.

**Farhana — university student running a small tutoring business.** Wants a card mostly for a Facebook post announcing she's expanded to a second subject. Price\-sensitive, mobile\-only, metered data. Success looks like: the free tier gets her to a watermarked preview she can screenshot and post in under two minutes, with no signup required to get there.

* * *

## 4\. What we deliberately do not do

- No free canvas, no drag\-and\-drop, no arbitrary element placement — see §1. Users who want pixel control are not this product's customer.
- No AI\-generated imagery on the card. Generated imagery cannot be colour\-managed, cannot be a clean vector, cannot be foil\-separated.
- No logo *design* — only a quality gate and monogram generation for the logo a customer already has. Logo design is an adjacent product with a different constraint system.
- No posters, flyers, letterheads, or "anything else" at MVP. The constraint system is card\-specific; that specificity is a large part of the advantage over a generic design tool (the format becomes a parameter later — see §11).

* * *

## 5\. MVP scope

### 5\.1 In scope

- **Guided brief**, mobile\-first, 7 steps, only step 1 (identity) required: identity → contact routes → logo or monogram → personality (max 3) → language & script → physical feel & budget → review.
- **Bangla \+ English bilingual**, first\-class, not an afterthought — per\-script minimum sizes, line\-height, tracking rules and optical sizing. This is the market chosen; without it the MVP does not address it.
- **Deterministic generation** — six ranked concepts per brief, real scores, real "why" explanations generated from the engine's decision trace, never fabricated numbers.
- **Typed\-instruction refinement** — free text (English or Bangla) mapped to a closed set of operations; unmapped input returns an honest "I can't do that" plus close alternatives, never a silent no\-op or a hallucinated change.
- **Blocking \+ advisory preflight** — hard failures (overlap, below type floor, TAC exceeded, unscannable QR) block export outright; soft failures require an explicit, recorded acceptance.
- **Export**\: preview PNG/SVG immediately; PDF/X\-4 print file plus foil/spot\-UV separations (this is currently the single largest open engineering item — see Technical Design Document §6).
- **Order flow**\: quote → proof → customer approves → run, exactly the proof\-before\-charge sequence already modelled in the database. Two Dhaka presses minimum at launch, never one (§7.3).
- **Real payments**\: bKash and Nagad first (they are the market), then cash\-on\-delivery for print orders, then card rails (SSLCommerz/aamarPay/ShurjoPay) once volume justifies the integration cost.
- **Accounts**\: lightweight — phone\-number\-based, no heavy KYC — replacing the current anonymous browser key so "my designs" and order history survive a device change.
- **Vertical presets**\: doctor, RMG/export business, advocate, shop/service trade — as first\-class starting points in the brief, not generic industry dropdown entries.

### 5\.2 Deliberately out of scope for MVP

| Cut | Why |
| --- | --- |
| Multi\-tenant orgs, teams, roles, brand\-locked libraries | Real feature, wrong sequencing — no customer has asked for it yet; premature for a single\-founder product |
| Bulk employee\-card generation (CSV → N cards) | The enterprise wedge, correctly sequenced to V2 once one org has actually asked to pay for it |
| Visual layout\-builder / component\-studio UI | Author components in git until the library stops changing weekly; the UI is a V2 internal tool, not a customer\-facing one |
| Photoreal mockups | Render\-cost sink that sells nothing at this stage — already correctly cut once in the blueprint; the audit found it was built anyway (§2.3) and should be removed again or hidden behind a flag |
| Four pricing tiers | Collapse to two (§9); a subscription model is the wrong shape for an 18\-month purchase cycle in a market where recurring card billing has thin penetration |
| Markets beyond Bangladesh | V2/V3 — see §11 |
| Raster\-logo auto\-vectorisation | Accept SVG/PDF/EPS at upload; reject low\-quality raster with a clear, specific reason at the point of upload, not at export |

### 5\.3 MVP exit criteria — the numbers that decide whether to build V2 at all

- 100 paid orders completed end\-to\-end (brief → payment → delivered card)
- ≥ 99% print\-correct rate (zero preflight\-attributable defects on delivered orders)
- ≥ 40% of started briefs reach a concept view
- Median brief\-to\-export time under 10 minutes
- Engine cost per brief under ৳1 (should be near\-zero given the no\-LLM decision)
- **At least 3 of 5 pilot print shops still using it unprompted after one month** — this is the number that validates or kills the entire distribution thesis in §3.1

### 5\.4 Explicitly acknowledged limitation

The product will never serve the customer who wants to move one element by hand. This is not a gap to close later; treating it as one would unwind the guarantee that makes the product defensible. If user research surfaces this complaint repeatedly from paying customers, the correct response is to examine whether the *composition options* are too narrow (add more layout/palette/type records), not to open a canvas.

* * *

## 6\. Feature requirements

Organised as epics. Priority follows MoSCoW; "Have" epics are what MVP exit criteria in §5.3 are measured against.

### Epic A — Guided brief \[Must\]

- Seven\-step flow, mobile\-first, single\-column, one question group per screen.
- Only Step 1 (name, role, company, industry) is required; every later step has a sensible default and is skippable.
- The step rail displays exactly as many steps as exist (audit finding F6 in the blueprint: the prototype claimed twelve, delivered seven — this must never recur; the rail count and the actual step count are asserted equal in CI).
- Personality selection caps at three; a fourth tap either replaces the oldest selection or shows an explicit "3 of 3 — deselect one first" message. Silent no\-ops are a defect (blueprint F8), not a design choice.
- Language/script step defaults to bilingual (Bangla \+ English), not English\-only — this is what most of the addressable market actually wants.

### Epic B — Generation & explanation \[Must\]

- Six concepts per brief, generated deterministically from `(brief, library snapshot, seed)` — same inputs, same six outputs, forever.
- Every concept's fit score is computed from real signals (personality match, industry fit, print safety, legibility headroom) and changes when the brief changes. A static or fabricated score is a shipped defect.
- Every "why this concept" explanation is generated from the engine's decision trace. It may only cite preferences the user actually stated; an inferred preference (from an industry prior) must say so explicitly rather than being attributed to the user.
- If the generating step genuinely finishes in 400ms, the result is shown in 400ms. No artificial delay for the sake of perceived effort.

### Epic C — Typed refinement \[Must\]

- Free\-text input, English and Bangla, classified into a closed set of operations (`promoteSlot`, `swapPalette`, `tightenTracking`, etc.).
- An operation never scales type in place or repositions an element freehand — it always re\-selects a component and re\-composes, preserving the print guarantee.
- Unmapped input returns zero operations and an honest message naming what the system *can* do, rather than guessing.

### Epic D — Preflight \[Must\]

- Blocking checks (overlap on rendered glyph extents — not just slot boxes, per the collision bug the existing test suite already caught — below type floor, TAC exceeded, foil crossing trim clearance, unscannable QR) refuse export outright.
- Advisory checks (marginal contrast, logo below recommended size, five\-plus contact routes) require an explicit "accept and continue," recorded with the accepting user and timestamp against the order.
- Preflight counts shown to the user are always derived from the actual check run for that design — never a hardcoded "16 of 19."

### Epic E — Export \[Must\]

- Preview PNG and SVG, immediately, client\-side.
- PDF/X\-4 print file: CMYK, outlined fonts, 3mm bleed, correct safe area, spot separations for foil/UV/emboss named per\-special. **Currently not implemented — this is the single highest\-priority engineering task in the entire roadmap** (Technical Design Document §6).

### Epic F — Ordering & payment \[Must\]

- Quote → proof → customer approval → run → deliver, matching the state machine already modelled in `orders`/`order_events`.
- Charge only at approval, never before — this is the strongest trust mechanism in the product and must not be traded away for a faster checkout.
- bKash, Nagad, and cash\-on\-delivery at launch; card rails deferred until volume justifies the gateway integration cost.
- Delivery cost shown itemised in the quote (Pathao/Steadfast/RedX inside Dhaka, courier partners outside), never absorbed silently.

### Epic G — Accounts & persistence \[Must\]

- Phone\-number\-based lightweight account, replacing the current anonymous localStorage key.
- Saved designs and order history survive a device change and app reinstall.
- No heavy KYC at this stage; corporate invoicing (trade licence, BIN) is collected only when a corporate order is placed.

### Epic H — Vertical presets \[Should\]

- Doctor, RMG/export, advocate, and shop/service\-trade presets pre\-fill industry, personality defaults, and content fields specific to that vertical (e.g. chamber hours for doctors, a Facebook\-page contact route for shops).

### Epic I — Print\-shop channel \[Won't — MVP; Must — V2, gated by §5.3's shop\-adoption criterion\]

- Outlet accounts, operator\-mode UI built for a shop counter (large targets, minimal steps, tolerant of a weak connection), per\-shop settlement.

### Epic J — Multi\-tenant & bulk \[Won't — MVP; V2\]

- Orgs, roles, brand\-locked template libraries, CSV → N\-cards bulk generation for corporate staff programmes.

* * *

## 7\. Print & fulfilment requirements

- **Trim**\: 89×51mm standard (3.5×2in), 90×50mm secondary; portrait supported for chamber cards.
- **Bleed/safe area**\: 3mm bleed; 4mm safe area (5mm for foil, 6mm for die\-cut).
- **Colour**\: CMYK, FOGRA39 assumed as the safe default until a per\-press ICC profile is confirmed; **hold each press's actual profile once obtained** in the press capability record.
- **Type floor**\: 6.0pt Latin coated / 7.5pt Bangla coated (unvalidated on paper — see §2.2) — never lower.
- **Fonts**\: SIL OFL only, always outlined in output, never embedded. This is a hard rule enforced at component\-publish time, not a style guideline (blueprint F13).
- **QR**\: ECC ≥ M, module ≥ 0.5mm, quiet zone ≥ 4 modules; falls back to a short link when a full vCard will not fit at a scannable size; emits no QR at all if even the short link will not fit legibly.
- **Proof\-before\-charge**\: mandatory for foil, letterpress, emboss, and edge\-paint finishes. Optional (with a stated delay trade\-off) for plain matte/gloss lamination where the risk is low.
- **Press onboarding**\: two presses minimum before launch, in the same city, so a single press's rejection or delay never blocks an order. Each press must state: colour profile (or confirm none), plate/block setup cost, minimum run, lead time in working days, and — critically — whether it will accept a PDF/X\-4 as\-is or insist on "fixing" it in CorelDRAW first. That last answer is a stronger signal than the quoted price.

* * *

## 8\. Validation plan

### 8\.1 Phase 0 — before any further product engineering (2–3 weeks)

| Test | Method | Pass bar |
| --- | --- | --- |
| Will print shops adopt it? | Sit in 5–10 shops across Nilkhet, Fakirapool, Banglabazar; show the live engine on a laptop; ask what they'd charge for it and whether they'd use it | ≥ 3 of 5 say yes **and** name a price |
| Will presses accept our files? | Send the engine's print geometry to 3 candidate presses | ≥ 2 accept a PDF/X\-4 without needing to "fix" it |
| Do Bangla conjuncts hold at 7.5pt? | Print a test sheet — ক্ষ, ঙ্গ, ন্ত্র at 6.5 / 7 / 7.5 / 8pt — on the actual 300gsm stock | A legible floor is confirmed or the constant in the engine is raised |
| What do things actually cost? | Written quotes from 3 presses for 100/500/1000 runs, with and without foil | Placeholder cost constants replaced with real numbers before any price is shown to a customer |

If the shop\-adoption test fails, the monetisation model in §9 does not close, and that is a signal to rethink the model — not a signal to build more screens to compensate.

### 8\.2 Phase 1 gate — engine productionisation

A card designed in the browser must print correctly from a partner press, twice, from two different presets, before Phase 2 (accounts, payments, order flow polish) begins in earnest.

### 8\.3 Phase 2 gate — the product

100 paid orders, ≥ 99% print\-correct rate, median brief\-to\-export under 10 minutes — see §5.3.

### 8\.4 Phase 3 gate — the channel

≥ 3 of 5 pilot shops still using the tool unprompted after one month, unlocking the V2 investment in the shop\-channel product (Epic I).

* * *

## 9\. Monetization

**What's wrong with a subscription model here**\: an individual buys visiting cards roughly once every 18 months. Monthly billing guarantees churn right after the single moment of value, and card\-based recurring billing has thin penetration in Bangladesh — bKash and Nagad are built for one\-off pushes, not silent monthly pulls. A subscription\-first product fails at the payment layer before it fails at the value layer.

**Recommended model — transaction\-led.** All figures below are estimates to validate against real press quotes (§8.1) before committing to a public price list.

| Line | Price | Est. margin | Rationale |
| --- | --- | --- | --- |
| Shop channel (white\-label per outlet) | ৳500–1,500/mo, or ৳20–40 per card design | 80%\+ | The scale play — 40,000 outlets, zero CAC per end\-customer |
| Print orders (direct) | ৳600/100 · ৳1,300/500 · ৳2,400/1,000 | 30–40% gross | Customer already intends to buy; we route to a partner press |
| File pack (design only) | ৳199–499 one\-off | \~98% | Priced below what a shop charges for design, so it's never the expensive option |
| Corporate/bulk | ৳3–25 lakh/yr | \~85% | CSV → 500 staff cards → one invoice |
| Teams (agencies, coaching chains) | ৳400–600/seat/mo | \~90% | Brand governance, locked templates — V2, gated by multi\-tenancy shipping |
| Pro (individual, optional) | ৳1,200/yr, annual only, never monthly | \~95% | Only for genuinely repeat designers; annual matches how bKash/Nagad are actually used |

**Free tier**\: unlimited briefs, six concepts, watermarked previews, no export, no order. Cost per free user is near\-zero given the no\-LLM decision.

**Pricing principle**\: charge at the moment of realised value (the file or the physical print), never for access to the tool itself. This aligns revenue with the print\-correct guarantee — payment happens when the thing demonstrably works.

* * *

## 10\. Success metrics

**North star: Print\-Correct Rate** — orders delivered with zero preflight\-attributable defects, as a percentage. Target ≥ 99.5%. Every requirement in this document is subordinate to this number; revenue follows it, not the reverse.

Supporting metrics: brief→first\-concept p95 latency (\< 6s); concept→order conversion rate; 12\-month reorder rate; engine cost per brief (\< ৳1); pilot shop retention at 30 days (the gate in §5.3).

* * *

## 11\. Roadmap beyond MVP

**V2 (post shop\-pilot success, months 4–9)**\: the print\-shop channel productised (operator\-mode UI, per\-shop settlement); multi\-tenant orgs with brand\-locked libraries; bulk employee\-card generation; markets 2–4 (West Bengal/India reusing the Bangla work plus Devanagari, then the Bangladeshi diaspora in the UK/Middle East); a real logo pipeline (vector ingest, monogram generation); a press marketplace routing orders to the cheapest capable press within a lead\-time constraint.

**V3 (months 10–24)**\: the insight that `DesignSpec` is not card\-specific — it is content \+ slots \+ constraints \+ print rules. Changing the format record lets the same engine produce letterheads, compliment slips, envelopes, email signatures, name badges, and door signs. That is the path from "card maker" to **small\-business identity system**, reachable specifically because no one was ever allowed to freehand a layout in V1.

* * *

## 12\. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Print defect on a paid run | Critical | Blocking preflight, physical proofing on specials, press\-specific colour profiles, recorded acceptance of every advisory finding |
| Bangla script failure | Critical | In MVP scope, not deferred; native\-speaker review of every layout; print\-test conjuncts before launch (§8.1) |
| Print\-shop channel rejects the product | Critical to the business model | Pilot before building the channel (§8.1, §8.4) — if shops won't adopt it, the model needs rethinking, not more features |
| Scope creep toward breadth over validation | High (audit finding, §2.3) | Freeze new screens until Phase 0 (§8.1) is complete |
| Price expectation anchored at free | High | Never sell "design" as a line item to consumers — sell the card, the file, or the shop's capability |
| Layout/print engine underestimated | High | Budget generously for the PDF/X\-4 writer (§6, Epic E) — it is the single largest remaining engineering task |
| Font licensing exposure | High | OFL\-only, enforced at component publish, always outlined never embedded |
| Payment/order reconciliation failure | Medium | Transactional handling with auto\-refund on failure; every failure produces an incident record |
| Load\-shedding / connectivity | Medium | The composer is a pure function and can run client\-side — briefing and preview work offline; only export/order need a network |
| Subscription\-shaped churn | Medium | Transaction\-led model (§9); subscriptions only where usage genuinely repeats |

* * *

## 13\. Open questions for the founder

1. **Payments integration order** — bKash first, or bKash and Nagad simultaneously? This affects the Phase 1/2 engineering estimate materially.
2. **Press relationships** — do any exist yet, even informally? If not, who owns making the first three calls in §8.1?
3. **Account model** — is phone\-OTP acceptable, or is there a preference for email\-based accounts given some corporate buyers may prefer that?
4. **Team/runway** — is this still a solo or near\-solo build? The roadmap gating in §11 assumes limited engineering capacity; a funded or team scenario would change the pacing, not the sequence.

* * *

## 14\. Companion documents

This PRD defines *what* and *why*. Two companion documents, delivered alongside it, define *how*\:

- **CARDWORKS — Technical Design Document**\: system architecture, `DesignSpec` schema, database design, API surface, the fit\-ladder algorithm, print pipeline, and a gap analysis against the currently deployed code.
- **CARDWORKS — Wireframing Document**\: information architecture, user flow diagrams, and screen\-by\-screen low\-fidelity layouts for the mobile\-first brief\-to\-order journey, annotated against what is already built.
