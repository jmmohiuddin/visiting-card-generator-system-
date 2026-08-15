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
2. **Wave 1 (done)** — A1–A5 and B1–B6 in parallel. No two touch the same file.
3. **Wave 2 (done)** — `orders.mjs` and `designs.mjs` rewired onto the new
   modules: server-derived prices, the preflight gate, payment capture at
   approval, and sessions. A6's `/v1` surface is **not built** — the endpoints
   it would wrap all exist and carry the envelope and idempotency already, so
   versioning them is a rename, not a risk. Left deliberately.
4. **Wave 3 (done)** — verification, in three layers because each catches what
   the others cannot: 928 assertions across six Node suites; a real Postgres 16
   run proving the module SQL and the migrations agree; and a Chromium walk
   over all 22 screens at five widths against live function handlers.

## What the division actually bought

Worth recording, because the failures were more instructive than the successes.
Every serious bug found this session was found **at a seam between two owners**,
by the owner on the other side — a quote id whose digest and transported value
disagreed below the second, a payment callback taken off the request body, a
tuple read as an object so every signed-in customer looked anonymous, and a
machine token rendered onto a customer's screen in four separate places.

None of them were found by the subgroup that wrote the code. All of them were
found because someone else had to integrate against it and checked rather than
assumed. That is the argument for the ownership split, and it is a stronger one
than "people can work in parallel".

The recurring anti-pattern was assertions that grep source **by shape**: three
subgroups wrote one, and all three broke on unrelated edits while looking like
real failures. Where a property can be asserted behaviourally, do that instead;
where it genuinely cannot, find the subject by name rather than by the
punctuation around it.

## Two house rules, both bought with a bug

**An extractor that finds nothing must fail, not pass.** Twice in one session an
assertion reported success while verifying nothing — once returning
`promise.then(...) && true`, truthy regardless, with the real check in a
microtask the runner exited before; once slicing between two markers where the
end index preceded the start, so `slice` returned `''` and zero fields were
compared. Both were green. The asymmetry is what makes this a rule rather than
a note: every other kind of test bug announces itself, but **the failure mode of
a broken extractor is silence, and silence reads as a pass.** So any assertion
that pulls its subject out of source must refuse outright when the extraction
comes back empty or implausibly small.

**A citation is a snapshot, so re-read before re-sending.** The human half of
the rule above, and it recurred more often than the assertion version: three
people this session reported a file:line that had been true when they captured
it and had moved by the time they sent it, each costing the recipient a
verification round. A stale line number fails exactly like a shape-grep — both
encode *where something sat* rather than *what it is*, and both keep being
right until the file moves underneath them. Cite by name and re-read the file
before repeating a claim about it, for the same reason an assertion should find
its subject by name rather than by the punctuation around it.

**A guarantee is asserted from the far side of the seam it protects.** The
checks that actually caught things were written by the party that would be hurt
if the other side broke it: the accounts module asserts that the shell's
remediation table covers every token the endpoints emit, and the shell asserts
that every field set on a thrown error survives into `net.lastError`. Each fails
the build of the person who can fix it, at the moment they break it, rather than
failing quietly in the file that got it wrong.

## The one deferred piece of test infrastructure

Two checks are still source-shaped because there is no seam to observe them
through, and both say so in their own comments rather than pretending
otherwise: whether `net.lastError` copies a given field, and whether a handler
that names `user_id` authenticated with `sql`.

The second has a behavioural form — invoke each handler with a `sql` that
throws `relation "auth_sessions" does not exist` and assert it degrades to
anonymous rather than returning 500, which is the property that actually
matters — but `db()` in `lib/http.mjs` reads `DATABASE_URL` and returns a real
client, so there is nowhere to inject. A `db()` that honours an injected client
under test would open that seam, and would likely let several other subgroups
replace source-greps with behaviour.

It is deliberately **not** built. Adding an injection point to a frozen contract
ahead of the consumer that needs it is the same speculative-capability mistake
Master PRD §2.3 documents. Do it when something asks for it.

## Round two — the two features the founder asked for

| # | Owns | Delivers |
|---|---|---|
| **C1** | `lib/enhance/**`, `netlify/functions/enhance.mjs`, `assets/ui-enhance.js` | Upload a card you already have; get it printable. Two tiers, kept apart on screen: **repair** is objectively correct and changes nothing about how the card looks; **improve** is a matter of taste and is always optional. |
| **C2** | `lib/ingest/**`, `netlify/functions/destructure.mjs`, `assets/ui-destructure.js` | Take an uploaded card apart and restyle its pieces — colour, type, size, weight, case, alignment, slot, include/drop. |

Both were built in-session rather than by subagents: the fleet hit its rate
limit before writing a line, and waiting would have cost more than doing.

### The line this feature does not cross

Master PRD Decision 1 forbids a canvas, and §5.4 says the product will never
serve someone who wants to move an element by hand. Per-part restyling sounds
like it crosses that. It does not, and `lib/ingest/contract.mjs` states the
rule the whole feature is built on:

> An operation changes what a part **is**. It never changes where a part **sits**.

Uploaded geometry is recorded as `observed` — evidence about the file — and is
never passed to `compose()`. That is asserted rather than promised: the test
poisons every `observed` box with an absurd value and requires the composed
output to be byte-identical.

### What this round cost the engine, and why it was worth it

Five of the seven editing operations were **silent no-ops** when first wired
up. The editor accepted the change, recorded it on the part, reported nothing,
and the card did not move — because the composer re-derives everything from
content plus a design record and had no per-slot style channel. A silent no-op
reads as the app being broken; blueprint finding F8 names it as a defect.

So `assets/engine.js` gained one optional input: `spec.slotStyle`, merged onto
a slot **before** `box()` and `fitSlot()`, so an overridden size or weight is
measured and laddered like any other rather than painted on afterwards at a
width nothing checked. Absent, it is a no-op — proved by composing all 156
preset × layout × format combinations against the previous engine and
requiring byte-identical output.

## Round three — the PRD gaps

| # | Delivered |
|---|---|
| **D1** | Bengali GSUB/GPOS shaping. Bangla now exports; before this, no bilingual card could produce a print file at all, in a product whose only market is Bangladesh. |
| **D2** | The component library as versioned, immutable database records, plus the `/v1` surface. 108 of 108 cards compose identically from the database as from the built-in literals. |
| **D3** | `generate()` from ~88 ms to **2.8 ms** — 32× — with 312 renders and 96 generations byte-identical to before, and a `PERF.caches = false` switch so "did the cache change the answer" is answerable rather than arguable. |

### The bug the parity suite was structurally unable to see

D1 handed back something worth recording. `lib/engine-node.mjs` warns in its own
header that the browser and server metric tables must move together. There were
**four** copies of that table, not two — the server, the engine suite's harness,
the parity suite's harness, and the perf suite's harness — and `engine-parity`
compares two of them **to each other**. So it stayed green while all four were
wrong in the same direction.

They charged a flat 0.62 em per Bangla codepoint. Shaping makes one conjunct out
of three codepoints, so the estimate ran 44–54% wide on real names and place
names — চট্টগ্রাম was measured at more than double its printed width. Never
dangerous, because over-estimating width sets type smaller and narrower never
leaves the safe area, but it drove Bangla toward the unvalidated 7.5 pt floor a
third earlier than the text required.

The model now measures by cluster: a halant subtracts 0.50 em because it joins
its neighbours, a vowel sign costs 0.25, a sign 0.10. Mean absolute error against
the real shaper falls from ~54% to ~9%. D3's assertion that its harness measures
text exactly as the server does is what caught the fourth copy when the other
three moved — a good example of the house rule about asserting a guarantee from
the far side of the seam it protects.

## Round four — the second PRD audit

The first audit read the epics. The second read the document line by line
against the code, and found six things the first missed — five of them in
sections that are easy to skim because they are prose rather than a checklist.

| # | Gap | Where it hid |
|---|---|---|
| **—** | Component versions never pinned into a saved design | §7.1 of the Technical Design, in a paragraph about caching |
| **E1** | Safe area flat at 4 mm; §7 specifies 5 mm foil, 6 mm die-cut | one clause inside a bullet |
| **E2** | Free tier described on the pricing screen, enforced nowhere | §9, which reads like positioning rather than a requirement |
| **E3** | The north star was uncomputable | §10, which asserts the metric rather than asking for it |
| **—** | Logo upload rejected PDF and EPS | §5.2, in a line about what is *out* of scope |
| **—** | OFL rule not enforced at publish time | §7, in a sentence that says where to enforce it |

**The pinning one is the lesson.** It was invisible to every existing test
because the spec hash does not move when a component is republished — so a
check asserting "publishing does not change an existing spec_hash" passed, was
true, and was measuring the wrong thing. Both halves of the mechanism existed:
`pinsFor` computed pins and `resolvePins` consumed them. Nothing wrote them, so
the consumer was dead code and the guarantee was absent while looking present.

Worth carrying into the next audit: **a requirement stated as prose is easier
to miss than one stated as a list**, and the requirements most likely to be
skipped are the ones inside a sentence about something else.

## What cannot be done in code

Master PRD §8.1 asks for four Phase 0 tests before further product engineering:
shop adoption, press file acceptance, the Bangla conjunct floor on real stock,
and real cost quotes. Those need shoe leather in Nilkhet, not a sprint. The
cost constants and the 7.5pt Bangla floor stay marked as unvalidated in the
code until someone has printed the test sheet.
