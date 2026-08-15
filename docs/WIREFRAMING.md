# CARDWORKS — Wireframing Document

Bangladesh Edition · v1.0 · 14 August 2026

Companion to the Master PRD and Technical Design Document. Covers information architecture, the primary user flow, and low\-fidelity screen layouts for the mobile\-first brief\-to\-order journey — annotated against what already exists in `index.html` versus what still needs building.

Table of Contents

* * *

## 1\. Method and how to read this

Every screen below is drawn as a low\-fidelity box wireframe — structure and hierarchy only, no visual styling, no colour, no type choices (the product already has a visual language, documented in the codebase as "Modernist": hairline rules, uppercase micro\-labels, zero corner radius; this document is deliberately not re\-litigating that). Each screen carries a status tag:

**\[BUILT\]** — exists in `index.html` today, verified by direct inspection. **\[BUILT — desktop\-first\]** — exists, but laid out for a wide viewport; needs a mobile\-first pass per Master PRD Epic A. **\[GAP\]** — required by the PRD but not present in the current build.

All wireframes are drawn at a 360px\-wide mobile frame, because Master PRD §3.1 and Technical Design Document §9 are explicit that this product's real device is a mid\-range Android phone, not a desktop — a wireframe drawn at desktop width would be documenting the wrong constraint.

* * *

## 2\. Information architecture

```
CARDWORKS
├── Start                              [entry point — one-line brief-by-example]
├── Brief (7 steps)                     [BUILT — the core funnel]
│   ├── 1. Identity                     required
│   ├── 2. Contact routes               skippable
│   ├── 3. Logo or monogram             skippable
│   ├── 4. Personality (max 3)          skippable
│   ├── 5. Language & script            skippable, defaults to bilingual
│   ├── 6. Physical feel & budget       skippable
│   └── 7. Review                       confirms before generating
├── Generating                          [BUILT — real stage counts, not theatre]
├── Concepts (six results)              [BUILT]
│   ├── Detail (open one)               [BUILT]
│   │   ├── Refine (typed instruction)  [BUILT]
│   │   └── Validate / Preflight        [BUILT]
│   ├── Compare (side-by-side)          not in MVP scope — PRD §5.2
│   └── No-results (constraint conflict)[BUILT — the empty state that matters most]
├── Export                              [BUILT UI — PDF output itself is a GAP, see Tech Design §6]
├── Order
│   ├── Quote                           [BUILT]
│   ├── Proof → Approve                 [BUILT — status machine only, no payment capture]
│   └── Tracking                        [BUILT]
├── My designs / Dashboard              [BUILT — but keyed to an anonymous browser, not an account]
├── Bulk (CSV → N cards)                [BUILT in UI — V2 per PRD §5.2, should not be customer-facing yet]
├── Library / Studio (component admin)  [BUILT — PRD §5.2 flags this as a cut that got built anyway]
├── Pricing, Sign-in, Settings, Profiles [BUILT]
└── /c/:code (QR landing page)          [BUILT — separate mobile page, not part of the app shell]
```

The gap between this tree and the Master PRD's MVP scope (§5.1–5.2) is the single most important finding this document exists to surface: **the build has more breadth (Bulk, Studio, Dashboard, four screens the PRD explicitly cuts) than the MVP calls for, while the primary funnel (Brief → Concepts → Order) is the one place still missing the mobile\-first pass that the product's own market makes mandatory.**

* * *

## 3\. Primary user flow

```
 Start
   │
   ▼
 Brief ──(steps 1-7, only step 1 required)──► Generating (real work, real counts)
                                                     │
                                                     ▼
                                            Six concepts
                                                     │
                       ┌─────────────────────────────┼──────────────────────────┐
                       ▼                             ▼                          ▼
                 Open one → Detail            Re-instruct all six        No candidates survived
                       │                    (typed operations only)     → constraint-conflict screen
                       ▼                                                  → 3 ranked resolutions
                Refine (typed text,                                       with cost consequences
                English or Bangla)
                       │
                       ▼
                Preflight ── blocking? ──► fix or accept ladder step ──► retry
                       │ (clear)
                       ▼
              ┌────────┴────────┐
              ▼                 ▼
        Export files       Order → quote → proof → APPROVE (charge here) → run → deliver
```

The rule this flow protects, stated once so every screen below can be checked against it: **nothing is charged before the customer has approved a physical proof**, and **no design that fails a blocking preflight check can reach Export or Order at all.** Every wireframe in §5 that touches money or a file download shows where that rule is enforced on\-screen.

* * *

## 4\. Global navigation pattern

**\[BUILT — desktop\-first, GAP for mobile\]** The current shell uses a fixed three\-column desktop grid (a 280px left rail, a flexible centre canvas, a 300px right inspector). Below roughly 1100px this collapses into overlapping content — confirmed by direct inspection of the CSS grid rules. Master PRD Epic A requires this to become a stacked, single\-column flow with a bottom sheet for secondary controls on the brief and detail screens. The wireframes in §5 are drawn to the *target* mobile layout, not the current desktop one, since that gap is exactly what this document exists to specify.

```
┌─────────────────────────────────┐
│ ← Back        CARDWORKS      ⋮  │  ← 48px header, always present
├─────────────────────────────────┤
│                                  │
│         (screen content)        │
│                                  │
├─────────────────────────────────┤
│   [ Primary action — full width │  ← thumb zone, bottom-anchored,
│     bar, thumb-reachable ]      │    never scrolls out of reach
└─────────────────────────────────┘
```

* * *

## 5\. Screen\-by\-screen wireframes

### 5\.1 Start \[BUILT\]

```
┌─────────────────────────────────┐
│           CARDWORKS             │
│                                  │
│   A card that is correct.       │
│   Seven questions. Six          │
│   print-ready designs.          │
│                                  │
│  ┌────────────────────────────┐ │
│  │  Start my brief          → │ │  primary action
│  └────────────────────────────┘ │
│                                  │
│  Have a code? [ Open a design ] │  secondary — loads a saved spec
│                                  │
│  বাংলা | English      (toggle)  │  language must be visible before
└─────────────────────────────────┘  the brief begins, not buried in it
```

**Note:** the language toggle sitting on the Start screen, not inside the brief, matters — Technical Design Document §5.1 and Master PRD §7 both treat Bangla as first\-class, and a UI that defaults to English before asking is itself a small English\-first bias worth removing.

### 5\.2 Brief — step 1 of 7, Identity \[BUILT — desktop\-first\]

```
┌─────────────────────────────────┐
│ ←              ●○○○○○○  1 / 7   │  rail shows the TRUE step count —
├─────────────────────────────────┤  PRD Epic A: this must never drift
│  Who is this card for?          │  from the actual number of steps
│                                  │
│  Full name *                    │
│  ┌────────────────────────────┐ │
│  │                            │ │
│  └────────────────────────────┘ │
│  Role / title                   │
│  ┌────────────────────────────┐ │
│  │                            │ │
│  └────────────────────────────┘ │
│  Company                        │
│  ┌────────────────────────────┐ │
│  │                            │ │
│  └────────────────────────────┘ │
│  Industry                       │
│  ┌────────────────────────────┐ │
│  │  Choose a preset        ▾  │ │  Doctor · RMG/Export · Advocate ·
│  └────────────────────────────┘ │  Shop/Service · Other (PRD Epic H)
│                                  │
├─────────────────────────────────┤
│  [        Continue        ]     │  disabled until name is filled;
└─────────────────────────────────┘  every field below name is optional
```

### 5\.3 Brief — step 4, Personality (max 3) \[BUILT, with a known defect\]

```
┌─────────────────────────────────┐
│ ←              ●●●●○○○  4 / 7   │
├─────────────────────────────────┤
│  Pick up to three words          │
│  that describe the feel.        │
│                                  │
│  (Premium)  (Modern)  (Bold)     │  selected chips shown filled;
│  (Friendly) (Minimal) (Warm)     │  a 4th tap while 3 are selected
│  (Traditional) (Playful) ...     │  must show:
│                                  │
│  ⚠ 3 of 3 selected —            │  ← this message is the fix for
│    tap one to deselect it        │    blueprint finding F8: a silent
│                                  │    no-op reads as "the app is
├─────────────────────────────────┤    broken," not as a limit
│  [ Skip ]      [  Continue  ]   │
└─────────────────────────────────┘
```

### 5\.4 Generating \[BUILT\]

```
┌─────────────────────────────────┐
│                                  │
│         ◐  Composing...         │
│                                  │
│   360 candidates enumerated      │  these numbers must be the REAL
│   96 survive your constraints    │  engine counts for THIS brief —
│   41 pass the fit ladder         │  never a fixed animation. If the
│   6 selected, ranked             │  engine finishes in 400ms, this
│                                  │  screen is on-screen for 400ms.
└─────────────────────────────────┘
```

### 5\.5 Concepts — six results \[BUILT\]

```
┌─────────────────────────────────┐
│ ←   Six designs      [Refine ⌨] │  Refine = typed-instruction box,
├─────────────────────────────────┤  applies to all six at once
│  ┌───────────┐  ┌───────────┐   │
│  │  [card 1] │  │  [card 2] │   │  2-up grid on a phone; each tile
│  │  Score 91 │  │  Score 88 │   │  shows a real, non-fabricated
│  └───────────┘  └───────────┘   │  score (Master PRD Epic B) —
│  ┌───────────┐  ┌───────────┐   │  never a static number that
│  │  [card 3] │  │  [card 4] │   │  survives changing the brief
│  │  Score 85 │  │  Score 83 │   │
│  └───────────┘  └───────────┘   │
│  ┌───────────┐  ┌───────────┐   │
│  │  [card 5] │  │  [card 6] │   │
│  │  Score 79 │  │  Score 79 │   │
│  └───────────┘  └───────────┘   │
├─────────────────────────────────┤
│  Format: [Landscape ▾]          │  switching format re-filters —
└─────────────────────────────────┘  layouts with no authored
                                      composition for it disappear
                                      with a stated reason, not a
                                      stretched result
```

### 5\.6 Detail — one concept, with "why" \[BUILT\]

```
┌─────────────────────────────────┐
│ ←         Concept 1     [Order] │
├─────────────────────────────────┤
│                                  │
│        [ card preview,          │
│          front / back toggle ]  │
│                                  │
├─────────────────────────────────┤
│  Why this design                │
│  Dark ground ranked 2.3× above  │  generated from the engine's
│  light palettes on your         │  decision trace (Tech Design §5.1
│  Premium + Powerful selection.  │  `trace.decisions`) — never
│  Foil area held to 6% to keep   │  static prose. Only cites axes
│  plating in the standard tier.  │  the user actually selected.
│                                  │
│  ┌────────────────────────────┐ │
│  │ Tell it what to change...  │ │  typed refinement, English or
│  └────────────────────────────┘ │  Bangla — never a canvas
│                                  │
│  [ Preflight ]     [ Export ]   │
└─────────────────────────────────┘
```

### 5\.7 Refine — typed instruction result \[BUILT\]

```
┌─────────────────────────────────┐
│ ←  "make my name bigger"        │  the literal instruction stays
├─────────────────────────────────┤  visible above the result, so the
│                                  │  user can see what was understood
│   [ updated card preview ]      │
│                                  │
│  ✓ Promoted "name" to a layout  │  states the operation performed,
│    with more room — the type    │  in plain language, not just
│    was not scaled in place.     │  "done"
│                                  │
├─────────────────────────────────┤
│  [ Undo ]          [ Keep it ]  │
└─────────────────────────────────┘
```

```
┌─────────────────────────────────┐
│ ←  "add a rainbow gradient"     │  UNMAPPED instruction case —
├─────────────────────────────────┤  must never silently do nothing
│                                  │  or guess
│  I can't do that. Here's what   │
│  I can change instead:          │
│                                  │
│  • Swap the palette              │
│  • Increase the foil area        │
│  • Try a bolder type pairing     │
│                                  │
├─────────────────────────────────┤
│  [ Back to concept ]            │
└─────────────────────────────────┘
```

### 5\.8 Validate / Preflight \[BUILT\]

```
┌─────────────────────────────────┐
│ ←            Preflight          │
├─────────────────────────────────┤
│  ✓ Passed          9 checks     │  counts are DERIVED from the
│  ⚠ Advisory        2 checks     │  actual check run for THIS spec
│  ✕ Blocking        0 checks     │  — never a hardcoded "16 of 19"
│                                  │
│  ⚠ Logo below recommended       │
│    reproduction size            │  advisory items require explicit
│    [ ] I accept this and        │  acceptance, checked and recorded
│        want to continue         │  with who/when against the order
│                                  │  (Tech Design §6.3)
├─────────────────────────────────┤
│  [   Continue to Export   ]     │  disabled while any BLOCKING
└─────────────────────────────────┘  item is unresolved — no override
```

**Blocking variant** — the same screen with a blocking finding present shows no path forward except fixing it:

```
│  ✕ Name overlaps the role line  │
│    at this type size.           │
│    [ Try a layout with more     │  the only actions offered are
│      room for the name ]        │  ones that actually resolve it —
│    [ Shorten the role text ]    │  never an "export anyway"
```

### 5\.9 Export \[BUILT UI — the PDF itself is a GAP, see Technical Design §6\]

```
┌─────────────────────────────────┐
│ ←              Export           │
├─────────────────────────────────┤
│  Preview                        │
│  [ card.png ]   [ card.svg ]    │  ✅ already real — client-side,
│                                  │     immediate
│  Print-ready                    │
│  [ card.pdf ]  ⚠ not yet built  │  ❌ GAP — this is the single
│  [ foil_gold.pdf ] ⚠ not built  │     highest-priority engineering
│                                  │     item in the whole roadmap
├─────────────────────────────────┤
│  [       Order instead      ]  │
└─────────────────────────────────┘
```

### 5\.10 No\-results — constraint conflict \[BUILT — the empty state that matters most\]

```
┌─────────────────────────────────┐
│         No designs fit          │
├─────────────────────────────────┤
│  Your name and both              │
│  qualifications don't fit any    │
│  layout at a legible size.       │
│                                  │
│  Here's what would fix it:       │
│                                  │
│  1. Move qualifications to the   │
│     back            (no cost)   │
│  2. Switch to portrait           │
│     orientation      (no cost)  │
│  3. Use a larger trim size       │
│     (+৳80 per 100 cards)         │
│                                  │
├─────────────────────────────────┤
│  [ Try option 1 ]               │  each option is a real, applied
└─────────────────────────────────┘  fix — not a dead-end error
```

### 5\.11 Order — quote → proof → approve \[BUILT — no real payment capture\]

```
┌─────────────────────────────────┐
│ ←              Order            │
├─────────────────────────────────┤
│  Quantity   [ 500        ▾ ]    │
│  Finish     [ Matte laminate ▾] │
│                                  │
│  Cards (500)          ৳1,300    │  itemised — never a lump sum
│  Foil setup              ৳220   │  (Master PRD §7, Epic F)
│  Delivery (Dhaka)          ৳80  │
│  ─────────────────────────────  │
│  Total                 ৳1,600   │
│                                  │
│  Pay with:                      │
│  ( ) bKash   ( ) Nagad          │  ❌ GAP — Technical Design §10
│  ( ) Cash on delivery           │  item 2: no provider is actually
│                                  │  wired up yet; this screen exists
├─────────────────────────────────┤  but cannot currently capture
│  [   Place order   ]            │  a real payment
└─────────────────────────────────┘
```

```
┌─────────────────────────────────┐
│         Your proof is here      │
├─────────────────────────────────┤
│  [ photo of the printed proof ] │
│                                  │
│  Nothing is charged until you   │  the trust mechanism from PRD §1
│  approve this exact card.       │  and §7 — must stay first-class,
│                                  │  never streamlined away
│  [ Request changes ]            │
│  [   Approve & pay    ]         │
└─────────────────────────────────┘
```

### 5\.12 Tracking \[BUILT\]

```
┌─────────────────────────────────┐
│ ←        Order ORD-02214        │
├─────────────────────────────────┤
│  ✓ Files locked                 │
│  ✓ Sent to press                │  a vertical, timestamped event
│  ✓ Proof printed                │  log — append-only on the server
│  ● Proof delivered   ← you are  │  (order_events table), so the
│    here                         │  history can never be silently
│  ○ Your approval                │  rewritten
│  ○ Run & delivery                │
│  ○ Delivered                    │
└─────────────────────────────────┘
```

### 5\.13 My designs / Dashboard \[BUILT — keyed to a browser, not a person\]

```
┌─────────────────────────────────┐
│ ←          My designs           │
├─────────────────────────────────┤
│  ⚠ Signed in as this device      │  until Epic G (real accounts)
│    only — designs won't follow   │  ships, this banner should be
│    you to a new phone            │  HONEST on-screen, not hidden
│                                  │
│  [card] Dr. Nasrin — chamber     │
│  [card] Rafiq — RMG export       │  each row opens the saved spec
│  ...                             │  directly via its short code
├─────────────────────────────────┤
│  [   Start a new brief   ]      │
└─────────────────────────────────┘
```

* * *

## 6\. Screens intentionally not detailed here

**Library / Component Studio, Bulk generation, Pricing (four tiers), Dashboard analytics.** These exist in the current build but are flagged in Master PRD §5.2 and §2.3 as scope that shipped ahead of validation. They are not wireframed here because doing so would document them as MVP\-ready when the PRD's position is the opposite: Bulk and multi\-tenant Library belong to V2, gated on the corporate\-demand signal (PRD §11); the four\-tier Pricing screen should collapse to two tiers per PRD §5.2 before it is shown to a real customer. Wireframing them now would be premature specification of features this document's own companion PRD says to hold back.

* * *

## 7\. States checklist

Per screen in §5, the following states must exist before that screen is considered done. This is the audit list — check off against `index.html` per screen rather than assuming "built" means "complete":

| State | Currently handled |
| --- | --- |
| Empty (no data yet) | Only the constraint\-conflict screen (§5.10) is a real, designed empty state |
| Loading | Generating screen (§5.4) only — other async actions (save, order placement) need a visible pending state |
| Error (network/server failure) | Not confirmed present outside the QR\-landing page's 404/503 handling (`card.mjs`) |
| Offline | Briefing/preview should work with no network per Technical Design §9 — not yet explicitly signalled to the user when offline |
| Unsaved changes | Not confirmed — a user leaving mid\-refinement should be warned if the design isn't saved |
| Permission\-denied | N/A until accounts exist (Epic G); becomes relevant once login is added |

* * *

## 8\. Handoff notes for high\-fidelity design

- Keep the existing "Modernist" visual language (hairline rules, uppercase micro\-labels, zero radius, one accent colour) — it already reads as deliberately not\-AI\-generated, which the Master PRD names as worth protecting.
- Every wireframe in §5 assumes the mobile\-first rebuild from Master PRD Epic A has happened; do not skin the current desktop\-first layout and call it done — the underlying grid needs to change, not just the paint.
- The two screens most worth prototyping in high fidelity first are §5.5 (Concepts) and §5.10 (No\-results) — they are the moments that make or break the product's central promise, more than any visual polish elsewhere.
