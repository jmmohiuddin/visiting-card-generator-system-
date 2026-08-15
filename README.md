# CARDWORKS — Bangladesh

**Live: https://cardworks-bd.netlify.app**
A scanned card resolves at `/c/<code>` — e.g. https://cardworks-bd.netlify.app/c/f08e40a3

| File | What it is |
|---|---|
| `index.html` | The application. Markup only; no build step. |
| `assets/engine.js` | The composer, fit ladder, single renderer and preflight. **Read-only by convention** — it is a pure function of `(brief, library, seed)`, and that is what makes the test suite possible. |
| `assets/ui-*.js` | The surface, one file per area of the funnel, so several people can work at once without editing the same 4,000 lines. Load order is declared in `index.html` and asserted by the test loader. |
| `lib/` | Server-side: the engine loaded into Node, the HTTP envelope, PDF writing, preflight, quotes, payments, auth. |
| `netlify/functions/` | The endpoints. |
| `WORKPLAN.md` | How the work was divided, and what file ownership each area has. |
| `Card Studio.html` | The original prototype. 21 screens, high-fidelity, no working engine. Kept as the design reference — its visual language and several of its product decisions are good and should survive. |
| `CARDWORKS-PRODUCT-BLUEPRINT.md` | The audit and the full production blueprint. Superseded on scope by the Master PRD, but §21 is still the prioritised work list. |

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
- **Bangla as a script, not a font swap.** Per-script print floors (7.5 pt vs 6.0 pt), line-height, tracking bounds that never go negative, 1.12× optical compensation, Bengali numerals. Width is measured **by cluster, not by codepoint**: a halant joins the consonants either side of it into one conjunct, so it subtracts rather than adds, and a vowel sign costs a quarter of a consonant rather than a whole one. A flat per-codepoint charge runs 44–54% wide on real Bangladeshi names and place names, which cost type size on every Bangla card.
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
- **A real PDF/X-4 writer.** CMYK with a FOGRA-class OutputIntent, TrimBox and BleedBox exact to the millimetre, 3 mm bleed, crop marks, and **fonts outlined rather than embedded** — glyph contours are read out of the vendored OFL faces and emitted as paths, which removes licensing exposure and rendering drift in one decision. One separation per special, choked 0.3 mm, and a plate the choke would consume is refused with the percentage that survived. Output is byte-identical for a repeated spec, so golden-file regression testing works.
- **Two ways in.** The Start screen offers the seven-question brief *and* "already have a card?" — because the customer this product was described for arrives holding one a shop already printed, and a feature reachable only from a nav menu is a feature nobody finds. Both routes are offered in Bangla and English.
- **Enhance a card you already have.** Upload the card from the shop, and get back the same card able to print. Findings are specific — 4.5 pt type, content in the guillotine's path, 1.9:1 contrast — and the fixes are split into repairs (objectively correct, applied by default, and they do not change how the card looks) and improvements (opinions, always optional, always declinable). Declining every improvement still yields a card with zero blocking findings.
- **Take a card apart.** An uploaded card is decomposed into its parts, and each part's colour, type, size, weight, case, alignment and slot can be changed. Every change re-composes through the engine and re-runs preflight, so the finding count on screen is the count for what you are looking at. There is deliberately **no position control**: geometry stays the composer's output, which is what keeps the result printable. A colour that fails contrast is refused with its measured ratio; the type floor refuses with the reason it exists.
- **A free tier that is actually free, and actually a tier.** Unlimited briefs, six concepts, full refinement and the whole preflight report, with no signup — because the customer this serves is deciding whether the thing works before she pays for it. What it withholds is the print file and the print run. The preview carries a watermark; the print path never does, and a test asserts the marker reaches neither a PDF nor a separation plate. The gate lives on the endpoint rather than only on the screen, and it fails closed only where a paywall exists: a deploy with no database cannot take a payment either, so refusing exports there would protect no revenue and break local development.
- **Numbers the PRD's own exit criteria can be read from.** Brief started, concept reached, export completed, order placed — content-free, append-only, and joined by a random per-brief key rather than anything identifying. The north star is the honest part: whether a delivered card was print-correct cannot come from telemetry, so it is a verdict recorded against the order by whoever handled the delivery, attributed to a cause, and only *preflight-attributable* defects count against the product. An unexplained defect counts against it too, because a defect that improves the metric by being unexplained is the one way this number could quietly start measuring something else. Below the sample floor it reports that it does not know, rather than a confident 100% from four orders.
- **Component versions pinned into every saved design.** A spec names its components by slug, and a slug is not a version — so republishing a palette used to repaint every saved design that referenced it, *while the spec hash stayed identical*. Hash stability was never the guarantee; pinning is. Technical Design §7.1 calls this non-negotiable for a product people order five hundred physical copies from, and it now holds: a saved design re-renders byte-identically from its pins after the library moves under it.
- **Server-side preflight.** The same engine file the browser loads, run in a Node VM rather than reimplemented, so there is one fit ladder and not two. Blocking findings refuse an order outright; advisory findings require an acceptance recorded with who and when.
- **Real money and real accounts.** bKash, Nagad and cash on delivery, charged only at proof approval. Quotes are re-derived server-side from the quote the customer accepted — a client-supplied total is compared and reported, never trusted. Phone-based sessions carry work across devices, and anonymous browsing still works without one.

## What is deliberately not implemented

**No LLM — by decision, not by omission.** Everything an LLM was scoped for is implemented in rules: intent resolution, the edit grammar, and explanations. What that costs, what it buys, and exactly where a model would slot in later are in blueprint §7. The short version: the product is deterministic, free per brief, works offline, and its explanations cannot claim a reason the ranker did not use.

Multi-tenancy is still deliberately unbuilt. Master PRD §5.2 gates orgs, roles and brand-locked libraries on a paying customer asking for them, and nobody has.

**Bangla is shaped and outlined.** `lib/pdf/bengali.mjs` implements the OpenType `bng2` cluster model against each face's own GSUB and GPOS, rather than against any table written into this repository — the four vendored Bangla families disagree about which conjuncts they form and by which mechanism, so asking the font is the only answer that is correct for all of them. `tests/shaping.test.mjs` checks it against headless Chromium across a 36×36 conjunct matrix per face with zero disagreement, and advances matching to a fraction of a pixel; the browser's verdict is committed to a golden file so a machine with no browser still runs against it.

Four refusals remain, all named and all narrow: text that is not a well-formed orthographic syllable (a stray vowel sign or halant — a text editor answers that with a dotted circle, but a press file has nobody to tell), and three shapes of "this face carries no usable Bengali rules". A subtable this reader cannot parse refuses the whole face rather than shaping around it, because a rule that silently does not fire is a conjunct that does not form.

The engine exists to prove the hard part is tractable and to pin its contract, not to be the product.

## Running it

```
npm test           # every suite: engine, pdf, payments, auth, quotes, engine-parity
npm run db:setup   # schema.sql + every numbered migration, from a clean database
npm run dev        # netlify dev
```

`npm test` is the Netlify build command, so a failing assertion anywhere blocks the deploy. **928 assertions across six suites**, including a Reed–Solomon syndrome check on every QR block, a 200-row bulk run, a rendered-glyph collision sweep across every format × preset × layout, byte-identical PDF output for a repeated spec, and a parity suite asserting the server reaches the same verdict as the browser for every preset × layout × script.

`db:schema` alone leaves the numbered migrations unapplied — use `db:setup`. Every migration is re-runnable.

## Three things to fix before anyone sees a price

None of these are engineering. Master PRD §8.1 asks for them **before** further product work, and they are the reason every quote this system returns carries a machine-readable flag saying the numbers are unvalidated. Nobody has called a Dhaka press yet.


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

### Already deployed

Site `cardworks-bd` is live and linked, and `DATABASE_URL` is set as a secret
environment variable for the production and deploy-preview contexts. To ship a
change:

```bash
netlify deploy --build --prod
```

`netlify.toml` runs `npm test` as the build command, so a failing assertion
fails the deploy rather than shipping a broken card.

**Optional — continuous deployment.** The site was created from the CLI, so it
is not yet linked to GitHub. To make every push to `main` deploy automatically,
open the site in Netlify → *Project configuration → Build & deploy → Link
repository*, and pick `jmmohiuddin/visiting-card-generator-system-`. That step
needs GitHub authorisation, so it has to be done from the browser.

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
