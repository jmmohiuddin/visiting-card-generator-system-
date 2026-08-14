# CARDWORKS — Technical Design Document

Bangladesh Edition · v1.0 · 14 August 2026

Companion to the Master PRD. Defines *how* the product in that document gets built, starting from what is already deployed at `cardworks-bd.netlify.app` rather than from a blank slate.

Table of Contents

* * *

## 1\. Scope and how to read this

This document has three layers, and they are kept visually distinct throughout: **what is deployed today** (verified by reading the code and running the test suite), **what the architecture requires at maturity** (the target state), and **the gap between them** (§10 — the actual engineering backlog). Do not treat the target\-state sections as already built; every one of them is cross\-referenced against §2's audit.

* * *

## 2\. Current implementation — verified snapshot

**Verified by direct inspection, 14 Aug 2026**\: `node cardworks-engine.test.cjs` → **162 passed, 0 failed**. The engine is real, not aspirational.

| Layer | Current state |
| --- | --- |
| Client | One `index.html` (4,240 lines), no build step, no framework — the engine, renderer, and all 21 screens run as a single static file |
| Compute | Client\-side only. `compose`, `fitSlot`, `renderSVG`, `preflight`, `generate`, `classifyInstruction` all run in the browser; nothing server\-side touches design logic |
| Server | 3 Netlify Functions (`designs.mjs`, `card.mjs`, `orders.mjs`) — thin CRUD over Postgres, no business logic beyond validation |
| Database | Neon Postgres (serverless). Tables: `design_specs`, `preflight_reports`, `usage_events`, `orders`, `order_events`. No `orgs`, `users`, `memberships`, `presses`, or `components` tables — those are target\-state only (§5) |
| Identity | None. `owner_key` is a random string minted client\-side and stored in `localStorage` — not an account |
| Hosting | Netlify, static \+ Functions, deployed from CLI, not yet linked to GitHub for CI/CD |
| Tests | 162 assertions in one file, run as the Netlify build command (`npm test`) — a failing assertion blocks deploy |

This is a **client\-heavy, server\-light** system: the hard, defensible part (the composition engine) runs entirely in the browser and has no network dependency for briefing or preview, which is deliberate and correct for a metered\-mobile\-data market (Master PRD §7). The server exists only to persist specs, resolve QR scans, and track orders.

* * *

## 3\. Target architecture

### 3\.1 The one idea the whole system is built around

```
Brief ──► IntentResolver ──► BriefVector ──► CandidateEngine ──► DesignSpec ──► Renderer ──► Preflight ──► Export/Print
        (rules, no LLM —     (typed,        (deterministic:    (immutable,    (pure fn,     (geometric,
         see PRD §1)          no prose)      filter→compose     content-       cacheable)    blocking)
                                             →score)           addressed)
```

`DesignSpec` is the atom of the product — a JSON document that fully determines a card: geometry, slots, resolved content, type scale, palette, finishes, colour space. Everything downstream is a pure function of it. That single property is what makes determinism, caching, versioning, and golden\-file regression testing all fall out of the data model instead of needing to be engineered separately (§7).

### 3\.2 Services — target vs. current

| Service | Responsibility | Current state |
| --- | --- | --- |
| `engine` | Filter → compose → score → six specs. **Pure, no I/O, no network.** | ✅ Built, tested, runs client\-side |
| `render-preview` | Spec → SVG/PNG | ✅ Built, in\-process with the engine |
| `api` | REST, persistence, idempotency | ⚠ Partial — 3 endpoints exist (save/load spec, resolve QR, orders), no auth, no versioned API surface |
| `render-print` | Spec → PDF/X\-4 \+ separations | ❌ **Not built — the single largest gap, see §6** |
| `preflight` | Geometric \+ colorimetric validation | ✅ Built client\-side; not yet mirrored server\-side, so nothing stops a client\-bypassed request |
| `orders` | Quotes, press routing, proofs, fulfilment | ⚠ Partial — status machine exists; no real quote calculation server\-side, no payment capture |
| `intent` | N/A — decision made not to use an LLM (PRD §1) | N/A by design |
| `library` | Component CRUD, versioning, publishing | ❌ Not built — components are currently hardcoded JS objects in `index.html`, not database records |

**Why not render in a browser server\-side.** Do not put headless Chromium in the print\-render path. At scale it costs roughly 300MB and 800ms per instance for a job that is geometrically trivial. Compose the PDF directly (`pdf-lib`, or a Rust `printpdf` worker) for full control over colour space, spot channels, overprint, and font outlining, at roughly 40ms and 10MB. This is a target\-state decision, not yet implemented (§6).

### 3\.3 Non\-negotiable engine property

`engine` must remain a pure function of `(BriefVector, LibrarySnapshot, seed)` — no database calls, no clock, no unseeded randomness. This is what has made the 162\-assertion test suite possible at all, what will make golden\-file regression testing possible once print rendering exists, and what allows the engine to keep running fully offline client\-side even after a server\-side mirror is added for preflight enforcement.

* * *

## 4\. The composition engine — how a design actually gets made

### 4\.1 The rule that prevents template explosion

> Nothing visual is ever written as markup. Everything visual is a record in a library, and there is exactly one renderer.

This is already true in the current build — the test suite includes an explicit assertion that the renderer contains **zero layout ids** (i.e., no `if (layoutId === 'split-panel')` branching). Confirmed present and passing.

The alternative — twelve hand\-authored HTML layouts, as the original prototype (`Card Studio.html`) shipped — means adding a 13th layout requires new markup, and every layout must be separately re\-authored for portrait, for bilingual, for a four\-line address. The data model instead scales combinatorially: **12 `LayoutTemplate` records \+ 8 `Palette` records \+ 5 `TypeSystem` records \+ 6 `SlotDefinition` records → 480\+ valid compositions**, with orientation, script, and logo\-presence handled as renderer parameters rather than new files.

### 4\.2 The six engines

1. **Grid engine** — a canonical 12×8 grid on the trim box; all geometry expressed in grid units, resolved to millimetres at render. Portrait transposes to 8×12 with slot positions remapped by the layout's declared portrait variant; square uses 10×10. A layout with no authored composition for a given orientation is *eliminated from candidacy for that orientation*, never stretched.
2. **Slot engine** — six slots (`mark`, `company`, `name`, `role`, `contact`, `qr`), each with minimum sizes and fallback rules (e.g. name overflow falls back toward the mark slot).
3. **Typography engine** — a `TypeSystem` declares family, weights, and scale as *ratios*, never absolute pixels; absolute sizes are derived at fit time from measured content. Enforces ≥3 hierarchy steps and a ≥1.6× ratio between name and role, with a 6.0pt absolute floor (6.5pt uncoated, 7.5pt Bangla — see PRD §7).
4. **Colour engine** — a `Palette` declares `{bg, fg, accent, muted, hair, panel}` in Lab colour space, with per\-market CMYK conversion cached per ICC profile. Validates contrast at *rendered physical size* and computes total ink coverage before a file is ever built.
5. **Composition engine** — given a layout, slot set, resolved content, and density, produces final geometry. Owns the fit ladder (§4.3). Never produces overlap — asserted as an invariant in code, not checked after the fact.
6. **Print engine** — bleed, safe area, registration clearance, separations, overprint, TAC. Maps finish intent ("gold foil on the monogram") to plate geometry (a 1\-bit vector separation with 2mm trim clearance and 0.3mm choke). **This is the engine least built out today** — see §6.

### 4\.3 The fit ladder

Every text slot declares an ordered degradation ladder, measured with real font metrics (`canvas.measureText` client\-side today; `opentype.js` server\-side once print rendering exists — both against the same embedded metrics table so numbers agree):

1. **Track** — tighten letter\-spacing within a bounded range (−1.5% to \+0.5%).
2. **Step** — drop one step on the type scale, never below the slot's declared minimum.
3. **Wrap** — allow an additional line, up to `maxLines`, if vertical room exists.
4. **Abbreviate** — a typed, culturally\-correct rule ("Chief Executive Officer" → "CEO"; never an invented abbreviation).
5. **Shrink box** — borrow horizontal space from a lower\-priority neighbouring slot.
6. **Drop** — remove the slot if `required: false`, and record the drop in the decision trace so it can be explained to the user.

If the ladder is exhausted and content still doesn't fit, **the layout is eliminated from the candidate set** — it is not rendered badly. This is why 360 candidates are enumerated to return 6: most die on fit, and dying quietly rather than rendering an overflow is the actual product guarantee. This mechanism is implemented and covered by the "rendered glyph collision" test category (33 assertions in the current suite check composed text against final case and inter\-element collision, not just slot\-box overlap — a real bug class the suite caught: uppercase slots measured in mixed case but rendered in caps run \~12% wider than their reserved box).

### 4\.4 A `LayoutTemplate`, as data

```jsonc
{
  "id": "lay.front.split-panel",
  "version": "3.0",
  "grid": { "cols": 12, "rows": 8 },
  "orientations": {
    "landscape": { "supported": true },
    "portrait":  { "supported": true, "variant": "lay.front.split-panel@portrait" }
  },
  "scripts": ["latin", "bangla"],
  "regions": [{ "id": "panel", "x": 0, "y": 0, "w": 4, "h": 8, "fill": "palette.panel" }],
  "slots": [
    { "ref": "name", "x": 5, "y": 3, "w": 6, "h": 2, "priority": 1, "required": true,
      "maxLines": 2, "fit": ["track", "step", "wrap", "shrinkBox"] },
    { "ref": "role", "x": 5, "y": 5, "w": 6, "h": 1, "priority": 2, "required": false,
      "maxLines": 1, "fit": ["track", "step", "abbreviate", "drop"] }
  ],
  "compat": { "requires": ["palette.hasPanel"], "incompatible": ["fin.letterpress"] }
}
```

This record is renderable, validatable, portrait\-capable, and authorable by a designer without touching code — a direct improvement over the current state, where these 12 layouts exist as JS object literals inside `index.html` rather than as versioned, independently publishable records (§10, item 2).

* * *

## 5\. Data model

### 5\.1 `DesignSpec` — the atom

```jsonc
{
  "specVersion": "1.0",
  "specHash": "sha256:...",
  "briefId": "brf_...", "parentSpecId": "spec_...",
  "format": { "market": "BD", "trim": { "w": 89, "h": 51, "unit": "mm" },
              "orientation": "landscape", "bleed": 3, "safe": 4, "sides": 2 },
  "content": {
    "primary":   { "script": "bangla", "name": "...", "role": "...", "routes": [...] },
    "secondary": { "script": "latin",  "name": "...", "role": "..." },
    "asset": { "logoId": "ast_...", "kind": "vector", "colorCount": 2 }
  },
  "design": {
    "layoutFront": "lay.front.split-panel@3.0", "layoutBack": "lay.back.qr-forward@3.2",
    "typeSystem": "typ.pairing.grotesk-tight@2.1", "palette": "pal.duo.black-gold@1.0",
    "density": "balanced", "finishes": ["fin.laminate.soft-touch@1.0", "fin.foil.gold@2.0"]
  },
  "composed": { "front": [ /* final geometry — OUTPUT of the composer, never hand-authored */ ] },
  "color": { "space": "cmyk", "profile": "FOGRA39", "spots": [{ "name": "FOIL-GOLD" }], "tac": 218 },
  "trace": {
    "candidatesConsidered": 360, "survivedFit": 41,
    "score": { "total": 0.91, "personality": 0.94, "printSafety": 1.0 },
    "decisions": [{ "why": "dark ground ranked 2.3× on premium+powerful", "chose": "pal.duo.black-gold" }]
  }
}
```

`composed` and `trace` are what make everything downstream honest: `composed` is what preflight measures and the renderer draws — no layout logic at render time — and `trace` is what every "why this concept" explanation is generated from, which is what makes that copy true rather than plausible\-sounding.

### 5\.2 Database — current vs. target

**Currently deployed** (`db/schema.sql`, verified):

```sql
design_specs(id, spec_hash UNIQUE, short_code UNIQUE, spec_json, parent_spec_id,
             label, engine_version, owner_key, created_at)   -- append-only, trigger-enforced
preflight_reports(id, spec_hash, status, blocking, advisory, findings, created_at)
usage_events(id, type, short_code, meta, created_at)
orders(id, ref, owner_key, short_code, qty, press, finishes, zone, currency,
       subtotal, total, status, recipient, created_at)
order_events(id, order_ref, type, actor, note, created_at)   -- append-only
```

Two things worth calling out as already correct and worth preserving exactly as\-is: **`design_specs` is genuinely append\-only**, enforced by a Postgres trigger that raises on `UPDATE`/`DELETE` rather than relying on application discipline — this is the right way to build it, not just a convention. And **`orders.ref` is generated from a dedicated Postgres sequence**, not derived from a row count — the schema's own comment notes an earlier version that truncated a row\-count\-derived reference to a fixed width and silently collided after ten consecutive orders. That fix should be treated as a pattern: anywhere else an identifier is derived rather than sequence\-generated is a latent version of the same bug.

**Target\-state additions** (not yet built, needed per PRD phase):

```sql
-- Accounts (PRD §5, Epic G — replaces the anonymous owner_key)
users(id, phone, name, locale, created_at)

-- Library, as real records instead of JS literals (§10 item 2)
components(id, slug, kind, org_id NULL, status, created_at)
component_versions(id, component_id, version, payload_json, status, published_at)

-- Presses (PRD §7 — currently a free-text string on `orders`)
presses(id, name, capabilities_json, lead_days, min_qty, active)
price_rules(id, press_id, rule_json, valid_from, valid_to)

-- Payments (PRD §6 Epic F — currently absent entirely)
payments(id, order_ref, provider, provider_ref, amount, status, created_at)

-- Multi-tenant (V2 — PRD §11, do not build before the shop pilot gates)
orgs(id, name, plan, created_at)
memberships(org_id, user_id, role)
```

Each tenant\-scoped table added later should carry `org_id` and be protected by Postgres row\-level security, not application\-layer filtering — RLS does not get forgotten in one endpoint the way an application filter eventually does. This is a target\-state principle to design in from the first multi\-tenant table, not a retrofit.

### 5\.3 Component taxonomy (target state — library not yet built)

```
lay.  Layout          front | back | universal        ~120 at maturity
typ.  Type system     header | body | pairing          ~40
pal.  Palette         2-colour | 3-colour | duotone     ~90
bg.   Ground          flat | pattern | mark | gradient  ~60
mrk.  Logo treatment  symbol | wordmark | monogram      ~30
cnt.  Contact block   stacked | inline | iconed         ~24
qr.   QR style        framed | bleed | inverted         ~12
fin.  Finish          laminate | foil | uv | emboss     ~20
fmt.  Format          per-market trim, orientation      ~14
```

Every component should carry `personality` as **weights**, not string tags (so ranking is arithmetic), and `compat` as an evaluable expression, not prose — the current in\-code components already lean this way informally; formalising them as published records is item 2 of the gap list (§10).

* * *

## 6\. Print system — the critical gap

This is the section to read most carefully. Everything else in the current build is either done or explicitly deferred by choice. The PDF/X\-4 writer is neither — it is the one piece of Phase 1 engineering the blueprint and this audit agree is both mandatory and unstarted.

### 6\.1 Output contract

| Property | Requirement |
| --- | --- |
| Format | PDF/X\-4:2010 |
| Colour | CMYK, FOGRA39 default until a per\-press profile is confirmed |
| Bleed | 3mm all edges |
| Safe area | 4mm inside trim (5mm foil, 6mm die\-cut) |
| Resolution | Vector throughout; any raster ≥300dpi at placed size, ≥600dpi for 1\-bit |
| Fonts | Outlined — never embedded (eliminates licensing exposure and rendering drift in one decision) |
| TAC | ≤300% coated, ≤280% uncoated |
| Separations | One PDF per special (`foil_gold`, `spot_uv`, `emboss`) — 100% K on white, spot\-named, overprint off |

### 6\.2 What exists vs. what's needed

The engine already emits `composed` geometry — exact positions, sizes, and colours for every element — because that's what the client\-side renderer draws from. **What's missing is the layer that turns that geometry into an actual PDF/X\-4 file**\: font outlining, CMYK/ICC conversion, and spot\-separation generation. This needs a library the current single\-file client cannot include (no build step exists today), which is why this task also forces the first real server\-side rendering component (`render-print`, §3.2) into existence — it cannot be done as a client\-side\-only feature.

Recommended approach: `pdf-lib` or a `printpdf` (Rust) worker, isolated in its own queue\-backed worker pool (not inline in the request path), given PDF composition is the one genuinely CPU/IO\-heavy step in an otherwise cheap pipeline (§8).

### 6\.3 Preflight severity model

- **Blocking** — overlap (measured on rendered glyph extents, not slot boxes — see §4.3), outside bleed, below type floor, TAC exceeded, foil crossing trim clearance, missing required field, unscannable QR. Export is refused outright.
- **Advisory** — marginal contrast, logo below recommended reproduction size, empty tagline, five\-plus contact routes. Requires explicit acceptance, recorded with the accepting user and timestamp — this record is the product's defence if a customer disputes a completed run.
- **Informational** — cost implications, press availability, lead\-time impact.

* * *

## 7\. Caching and scalability

### 7\.1 The scaling property that makes this cheap

The expensive operation is the rare one. Previews — generated constantly — are cheap SVG strings servable from a CDN by content hash. PDFs — expensive — only happen when someone pays. Determinism (`seed = sha256(briefId ‖ libraryVersion ‖ rankerVersion)`) is what makes this caching model possible at all: the same brief returns the same six concepts permanently, until a library change is published, which correctly (and only then) invalidates the cache.

| Layer | Key | TTL | Notes |
| --- | --- | --- | --- |
| Candidate set | `sha256(vector, libraryVersion, seed)` | 7 days | Currently moot — generation is client\-side and re\-runs each time; becomes real once library moves server\-side |
| Preview render | `spec_hash + variant` | Immutable, 1 year | `renders` table already models this key shape |
| Print render | `spec_hash` | Immutable | Re\-orders and proof→run reuse the same render |
| Explanation | `spec_hash` | 30 days | Generated from `trace`, which is already stored in `spec_json` |

Publishing a component version bumps a `libraryVersion` and rolls candidate caches — **it never invalidates existing specs**, because a spec pins the exact versions it was built from. A customer's saved design cannot silently change under them. This guarantee is non\-negotiable in a product people order physical goods from, and it falls directly out of `design_specs` already being append\-only.

### 7\.2 Estimated unit costs at scale (target, 1M designs/month)

| Stage | Driver | Per\-unit | At 1M/mo |
| --- | --- | --- | --- |
| Generation | CPU, pure function | \~15ms | A few core\-hours/day |
| Preview render | SVG, in\-process | \~8ms, \~40KB | Trivial; CDN absorbs delivery |
| Print render | PDF composition (once built) | \~40ms, \~4MB | Only on paid export, \~50k/mo at this scale |
| Storage | Specs \+ renders | \~8KB \+ \~4MB | \~200GB/mo, lifecycle to cold storage at 90 days |

### 7\.3 Load\-shedding order under stress

Disable bulk generation → serve cached previews only → queue exports with an honest ETA shown in the UI → (if an intent\-resolution service is ever added later) degrade to rules only. The product should stay usable at every step of this ladder; a slightly less nuanced result is a far better failure mode than an error page.

* * *

## 8\. API design (target state)

The current API surface is 3 unversioned Netlify Functions. The target is a versioned, idempotent REST API — the same one both the web client and any future print\-shop/partner integration use, with no private endpoints:

```
POST   /v1/briefs                     { input }                    → { briefId, vector }
POST   /v1/briefs/:id/generate        { count=6, seed? }           → { specs[], trace[] }
POST   /v1/specs/:id/instruct         { text | ops[] }             → { specId, ops[], unmapped[] }
GET    /v1/specs/:id/render?variant=preview                        → 302 → CDN
POST   /v1/specs/:id/preflight                                     → { status, findings[] }
POST   /v1/specs/:id/export           { formats[] }                → { jobId } → webhook
POST   /v1/quotes                     { specId, qty }              → { options[] }
POST   /v1/orders                     { specId, quoteId, address } → { orderId, status }
POST   /v1/payments/:orderId/capture  { provider, token }          → { status }
```

Every mutating call accepts an `Idempotency-Key`. Generation and export are async with webhooks; preview and preflight are synchronous. Errors return `{ code, message, field?, remediation? }`, where `remediation` is a UI\-renderable next step — this is what lets the "no candidates survived" empty state (already designed in the current screens) work generically rather than needing bespoke handling per error type.

* * *

## 9\. Non\-functional requirements

- **Offline\-tolerant briefing.** The composer must remain a pure function runnable client\-side with no network call, so briefing and preview work under load\-shedding or on a metered connection with no signal. Only export and order placement require connectivity.
- **Accessibility.** Every control has an associated `<label for=…>`; grouped chip controls use `role="group"` with an accessible name; gallery tiles are keyboard\-operable (`role="button"`, `tabindex="0"`, Enter/Space handlers, `aria-pressed`); a visible `:focus-visible` ring exists everywhere. **Already implemented and covered by 6 passing assertions in the current suite** — the standard to hold as the product surface grows, not a future goal.
- **Mobile\-first.** Reflow cleanly to 320px — single column, wrapping chip rows, no horizontal scroll. Confirmed working in the current build; the remaining gap is UX\-level (bottom\-sheet controls, thumb\-reachable primary actions), not a technical one — tracked in the Wireframing Document.
- **Session persistence without accounts.** State round\-trips through the URL hash (shareable) and `localStorage` (survives a refresh); an uploaded logo asset is deliberately excluded from the shareable state (it never left the browser to begin with). Already implemented; superseded by real accounts once Epic G ships, but the URL\-hash share mechanism should be kept even after login exists.

* * *

## 10\. Engineering gap list — ordered by what blocks revenue

1. **⛔ PDF/X\-4 print writer.** Nothing can be sold as a finished, printable file without this. See §6.
2. **⛔ Real payment capture** (bKash/Nagad). `orders.mjs` currently accepts a client\-supplied total with no verification and no capture step. This is a trust and revenue blocker, not a nice\-to\-have.
3. **Server\-side preflight mirror.** Today, a client that skips the JS engine (or a modified request) can reach the `orders` endpoint with no server\-side validation that the design actually passes preflight. Low likelihood of abuse at current scale, but the print\-correct guarantee (PRD §10) should not depend entirely on client\-side enforcement.
4. **Press capability records.** Move `press` from a free\-text field to a real `presses` table with `capabilities_json`, so quotes and finish availability are computed, not typed in by whoever built the order screen.
5. **Component library as data**, not JS literals in `index.html` — needed before a designer can extend the library without an engineer, and before publishing a component version can safely roll caches (§7.1) without a deploy.
6. **Real accounts** (phone\-based), replacing the anonymous `owner_key`.
7. **Multi\-tenancy** — deliberately last, and gated on the shop\-pilot and corporate\-demand signals in PRD §8, not built speculatively ahead of a paying customer asking for it.

* * *

## 11\. Testing strategy

The existing 162\-assertion suite (`cardworks-engine.test.cjs`) is the right shape and should be the template, not replaced: it already covers layout\-id purity (zero hardcoded layouts in the renderer), the fit ladder against real font metrics, portrait/square composition authoring vs. stretching, QR encoding verified by Reed–Solomon syndrome check rather than visual inspection, a 200\-row bulk\-generation run, and rendered\-glyph collision (not just slot\-box overlap) across every format × preset × layout combination. As server\-side rendering is added (§6, §10 item 1), the same discipline applies: a golden\-file suite of rendered PDFs, with any pixel/geometry drift failing CI, exactly as the client\-side suite already fails the Netlify build on any assertion failure today.
