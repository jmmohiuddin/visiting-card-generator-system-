# CARDWORKS — Bangladesh

Three files.

| File | What it is |
|---|---|
| `Card Studio.html` | Your original prototype. 21 screens, high-fidelity, no working engine. Kept as the design reference — its visual language and several of its product decisions are good and should survive. |
| `CARDWORKS-PRODUCT-BLUEPRINT.md` | The audit and the full production blueprint, Bangladesh edition. Read §0.4 (findings) and §0.5 (market) first; §21 is the prioritised work list. |
| `index.html` | A working reference implementation of the parts that did not exist. Open it in any browser — no build, no server. |

## What the engine actually does

Open `index.html`. Two modes, top right.

**Generate** — a brief (industry + personality + finishes) produces six ranked concepts. The pipeline counts are real: 360 candidates enumerated, composed with true text metrics, preflighted, scored on four dimensions, filtered for diversity, six returned. Every score is computed. Every "why" is generated from the decision trace.

**All layouts** — the same content composed into every layout in the library, so you can see the guarantee working. Load *Stress test — very long name* in Bangla and watch layouts get **eliminated** rather than drawn badly.

**Bulk** — paste a CSV (or press *Load sample*), get one composed, individually preflighted card per person. The enterprise wedge, and the thing Canva handles worst.

Switch **Format** to portrait or square to watch layouts without an authored composition for that shape get eliminated rather than squeezed into it.

Then, on the right: preflight findings, the fit-ladder trace, an itemised quote in BDT, and downloadable print output with bleed and trim marks plus a foil separation.

## What is implemented

- **Layouts are data.** 9 front + 4 back faces as records; one renderer. Adding a layout is adding a record — a test asserts the renderer contains zero layout ids.
- **The fit ladder.** track → step → wrap → abbreviate → reduceRoutes → drop, measured against real font metrics. Exhausted on a required field ⇒ the layout is eliminated.
- **Bangla as a script, not a font swap.** Per-script print floors (7.5 pt vs 6.0 pt), line-height, tracking bounds that never go negative, 1.12× optical compensation, Bengali numerals.
- **Geometric preflight.** Safe area, overlap, type floor, hierarchy ratio, contrast against the ground each element actually sits on, ink coverage, QR module size.
- **Ranking and explanation.** Rules-based intent resolution, four-dimension scoring, hard industry exclusions, diversity enforcement, trace-generated reasoning.
- **The edit grammar.** Free text in English or Bangla → operations from a closed set → components re-selected → geometry re-composed. *"Make my name bigger"* becomes `promoteSlot('name')`, which picks a layout that can carry a larger name; it never scales type in place. Unmapped input returns zero operations and says so.
- **A real QR encoder.** Byte mode, ECC M, versions 1–10, mask selection by penalty — verified by Reed–Solomon syndrome check, not by looking at it. Encodes a vCard, with a ladder that drops fields as the slot gets smaller and falls back to a short link. If nothing scannable fits, it emits **no QR at all**.
- **Logo quality gate at upload.** Vector vs raster, effective dpi at the placed size, colour count, transparency. Rejects with the measured numbers and three options — never at export.
- **Bulk generation.** CSV → N composed, individually preflighted cards. Tested to 200 rows.
- **Portrait and square, declared not stretched.** The grid follows the trim (12×8 / 8×12 / 10×10) so cells stay roughly square. Five layouts have authored portrait compositions, three have square; the rest are eliminated in those formats with a stated reason.
- **Keyboard and screen-reader access, and session persistence.** Every control is labelled, tiles are operable by keyboard, and state round-trips through the URL hash (shareable) and localStorage (survives a refresh).
- **Content-addressed identity.** `specHash()` — same design, same hash, same render, forever. This is what makes caching and "reproduce what the customer saw" possible.
- **Cost model and print output.** Itemised BDT quote; document geometry with bleed and trim marks; 100% K separations for foil and spot UV.

## What is deliberately not implemented

**No LLM — by decision, not by omission.** Everything an LLM was scoped for is implemented in rules: intent resolution, the edit grammar, and explanations. What that costs, what it buys, and exactly where a model would slot in later are in blueprint §7. The short version: the product is deterministic, free per brief, works offline, and its explanations cannot claim a reason the ranker did not use.

Also not implemented: persistence, accounts, tenancy, orders, payments, and the PDF/X-4 writer — the engine emits the *geometry* a PDF writer consumes, not the PDF. That needs font-outlining and ICC conversion, which need libraries this single file deliberately does not have. It is now the only genuinely new engineering task left in Phase 1 (blueprint §22).

The demo harness UI is a developer tool and is English-only. The **product** UI must be Bangla-first — that is Phase 2 work, not something to fake here.

The engine exists to prove the hard part is tractable and to pin its contract, not to be the product.

Run the tests: `node cardworks-engine.test.cjs` — **162 assertions**, including a Reed–Solomon syndrome check on every QR block, a 200-row bulk run, and a rendered-glyph collision sweep across every format × preset × layout.

## Two things to fix before anyone sees a price

1. **The cost numbers are placeholders.** Get real quotes from two or three Dhaka presses and replace `PRESS_BASE` and `FINISH_COST`. Ask each press for its colour profile, plate/block setup cost, minimum run, lead time, and whether it will accept a PDF/X-4 without "fixing" it first — that last answer matters more than the price.
2. **Print-test Bangla conjuncts at 7.5 pt** on the actual 300 gsm stock before trusting the floor. The value is reasoned from how conjuncts stack, not measured on a Dhaka press. If they collapse, raise it — the number is one constant in `SCRIPTS.bangla.minPt`.
3. **Scan-test a printed QR.** The encoder is verified mathematically (every block is a valid RS codeword) and structurally, but it has not been photographed off paper. Print one at 0.5 mm modules and scan it with a cheap Android phone before trusting `MIN_MODULE`. That constant is deliberately conservative and may be loosened per press.

---

## Deploying

The site is a static `index.html` plus two Netlify Functions backed by Neon Postgres.

**The database schema is already applied.** To re-apply after a change:

```bash
npm run db:schema
```

### Netlify setup (one-time, needs your login)

```bash
netlify login
netlify init
```

Choose *Connect to an existing GitHub repository* and pick
`jmmohiuddin/visiting-card-generator-system-`. Netlify reads `netlify.toml`,
so build settings are already correct: publish `.`, functions in
`netlify/functions`, and `npm test` runs on every build — a failing assertion
fails the deploy.

Then set the one secret:

```bash
netlify env:set DATABASE_URL "postgresql://…"   # the Neon pooled connection string
netlify deploy --build --prod
```

After that, every push to `main` deploys automatically.

### Local development

```bash
cp .env.example .env    # add your DATABASE_URL
netlify dev             # http://localhost:8888
```

### Endpoints

| Route | Purpose |
|---|---|
| `/` | The engine |
| `/?c=CODE` | Open a saved design |
| `POST /api/designs` | Save a spec, get a short code (idempotent — same design, same code) |
| `GET /api/designs?code=…` | Load a spec |
| `/c/CODE` | Where a scanned QR lands: card page + *Save to contacts* |
| `/c/CODE?vcf` | vCard download |

### A note on secrets

`DATABASE_URL` is **only** ever a Netlify environment variable and a local
`.env` (gitignored). It is not in this repository and must not be added to it.
If it is ever pasted into a chat, an issue, or a commit, rotate it in the Neon
console immediately.
