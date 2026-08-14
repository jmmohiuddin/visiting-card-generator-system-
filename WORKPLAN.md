# CARDWORKS — work division

Derived from the Master PRD, the Technical Design Document and the Wireframing
Document, against the code that is already deployed. Two groups, six subgroups
each. The division is by **file ownership**, so twelve people can work at once
without two of them editing the same line.

## The rule that makes this work

`assets/engine.js` is **read-only for everyone**. It is a pure function of
`(brief, library, seed)` (Technical Design §3.3) and it is what the 162-assertion
suite protects. The server does not reimplement it — `lib/engine-node.mjs`
loads that exact file into a Node VM, so there is one fit ladder, not two.

`assets/ui-shell.js` and `lib/http.mjs` are **contracts**: written first, then
frozen. Everything else has exactly one owner.

---

## Group A — the correctness spine (server, print, money)

Ordered by Technical Design §10, which ranks by what blocks revenue.

| # | Owns | Delivers |
|---|---|---|
| **A1** | `lib/pdf/**`, `netlify/functions/render-print.mjs` | PDF/X-4 writer — CMYK, outlined fonts, 3mm bleed, TrimBox/BleedBox, spot separations per finish. Tech Design §6. **The single largest gap.** |
| **A2** | `netlify/functions/preflight.mjs`, `tests/engine-parity.test.mjs` | Server-side preflight mirror. The print-correct guarantee stops depending on the client not being bypassed. Tech Design §10.3 |
| **A3** | `netlify/functions/payments.mjs`, `db/migrations/003_payments.sql` | bKash + Nagad + cash-on-delivery capture, `payments` table, charge **only** at proof approval. PRD Epic F, Tech Design §10.2 |
| **A4** | `netlify/functions/quotes.mjs`, `db/migrations/002_presses.sql` | `presses` + `price_rules` tables; server-computed quotes. The client stops supplying its own total. PRD §7, Tech Design §10.4 |
| **A5** | `netlify/functions/auth.mjs`, `db/migrations/004_users.sql` | Phone-based lightweight accounts replacing the anonymous `owner_key`; designs and orders survive a device change. PRD Epic G |
| **A6** | `netlify/functions/v1.mjs`, `db/migrations/001_idempotency.sql` | The versioned `/v1/*` surface from Tech Design §8, with `Idempotency-Key` on every mutating call and one error envelope. |

## Group B — the product surface (the funnel the market actually uses)

The Wireframing Document is drawn at 360px because the real device is a
mid-range Android phone. The current shell is a fixed three-column desktop
grid that collapses into overlapping content below 1100px.

| # | Owns | Delivers |
|---|---|---|
| **B1** | `assets/app.css`, `index.html` | Mobile-first shell: single column, 48px header, bottom-anchored action bar, bottom sheet for secondary controls, clean reflow to 320px. Wireframing §4. **Sole owner of the markup.** |
| **B2** | `assets/ui-brief.js` | Start (language toggle before the brief), the seven steps, rail count that cannot drift from the real step count, the 3-of-3 personality message, vertical presets. PRD Epics A + H |
| **B3** | `assets/ui-concepts.js` | Six concepts 2-up on a phone with real scores, detail with a trace-derived "why", typed refinement including the honest "I can't do that". PRD Epics B + C |
| **B4** | `assets/ui-validate.js` | Preflight with derived counts, recorded advisory acceptance, no override on a blocking finding; the constraint-conflict screen with three costed resolutions. PRD Epic D |
| **B5** | `assets/ui-order.js` | Export (wired to A1), itemised quote (wired to A4), payment selection (wired to A3), proof-before-charge, tracking. PRD Epics E + F |
| **B6** | `assets/ui-misc.js` | Flags the four cut screens off (PRD §5.2), collapses pricing to two lines, and fills in the states checklist — empty, loading, error, offline, unsaved. Wireframing §7 |

---

## Sequencing

1. **Wave 0 (done)** — split the monolith, freeze the contracts, 162/162 green.
2. **Wave 1** — A1–A5 and B1–B6 in parallel. No two touch the same file.
3. **Wave 2** — A6 wraps the endpoints A3/A4/A5 produced in the `/v1` surface.
4. **Wave 3** — verification: the engine suite, an API suite, and a Playwright
   run over the funnel end to end.

## What cannot be done in code

Master PRD §8.1 asks for four Phase 0 tests before further product engineering:
shop adoption, press file acceptance, the Bangla conjunct floor on real stock,
and real cost quotes. Those need shoe leather in Nilkhet, not a sprint. The
cost constants and the 7.5pt Bangla floor stay marked as unvalidated in the
code until someone has printed the test sheet.
