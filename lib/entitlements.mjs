/* What a caller is allowed to take away — and the watermark that says so.
 *
 * Master PRD §9 defines the free tier exactly: unlimited briefs, six concepts,
 * watermarked previews, no export, no order. Until this file existed the
 * pricing screen described that tier and nothing enforced it, so every visitor
 * got the print file for nothing. This is the enforcement.
 *
 * ── Why an entitlement is attached to a spec hash, not to a user ───────────
 *
 * §9 rejects a subscription for this market: an individual buys visiting cards
 * about once every eighteen months, so monthly billing guarantees churn
 * immediately after the single moment of value, and bKash and Nagad are built
 * for one-off pushes rather than silent monthly pulls. The model it recommends
 * instead is transaction-led, and its pricing principle is to charge at the
 * moment of realised value — the file or the printed card — and never for
 * access to the tool.
 *
 * A monthly flag on a user is the subscription shape wearing different
 * clothes: it says "this person may export", which is access, and it is
 * unbounded in a way nobody paid for. What the customer actually bought is
 * *this design's file*. So the record is `(kind, spec_hash, holder)`, and the
 * ৳199 file pack unlocks exactly the design it was bought against. Buying the
 * file for one card does not release the other five concepts, and that is not
 * meanness — it is the same content-addressing that makes a saved design
 * immutable and a print render cacheable forever (Technical Design §7.1).
 *
 * ── The free tier is generous on purpose ──────────────────────────────────
 *
 * PRD §3.2's Farhana is a student running a tutoring business, price-sensitive
 * and mobile-only on metered data, and her success case is that the free tier
 * gets her to a watermarked preview she can screenshot and post in under two
 * minutes with no signup. So nothing in this file gates briefing, generation,
 * refinement or preflight, and nothing here asks anyone to sign in to see a
 * concept. Cost per free user is near-zero given the no-LLM decision, which is
 * what makes that affordable. What the free tier withholds is the two things
 * that cost real money to honour: a press file, and a print run.
 *
 * ── The surface other endpoints use ───────────────────────────────────────
 *
 *   const gate = await assertEntitled(sql, 'export', { specHash, ownerKey });
 *   if (!gate.ok) return gate.refusal;
 *
 * Two lines, deliberately, so that `render-print.mjs` and `orders.mjs` gate
 * identically rather than each inventing a rule. `entitlementsFor` is the
 * read; `assertEntitled` is the read plus the refusal in the house envelope.
 *
 * ── The grant is not an argument ──────────────────────────────────────────
 *
 * `grantFromPayment` takes a payment reference and nothing else. Every column
 * of the row it writes — the spec hash, the holder, the amount — is read out
 * of the database by the INSERT's own SELECT, joining the captured payment to
 * its order to the design that order names. There is no parameter a caller
 * could set that reaches a stored column, and a payment that is not captured
 * selects no rows, so the statement inserts nothing. That is the whole of the
 * anti-forgery argument, and it is a property of the SQL rather than of every
 * caller remembering to check something first.
 */
import { ERR, fail, OWNER_RE, CODE_RE } from './http.mjs';
import { authenticate } from './auth.mjs';

/* ── The price list ────────────────────────────────────────────────────────
   §9's figures, with §8.1's caveat attached rather than dropped: no Dhaka
   press has quoted yet, so the print line is a model output. The file pack is
   the one line that does not depend on a press quote — it is our own margin
   on a file we already produce — so it is the number a refusal names. The
   band is ৳199–499; ৳199 is the single-design entry and the one a customer
   meets when they are refused, because quoting a range at the moment someone
   wants to buy is how a price stops being a price. */
export const FILE_PACK = Object.freeze({
  kind: 'file_pack',
  amount: 199,
  currency: 'BDT',
  band: Object.freeze([199, 499]),
  label: 'File pack',
  what: 'the print-ready PDF/X-4 for this design, plus a separation plate for every foil and spot-UV finish on it'
});

/* What the free tier gives, stated once so the pricing screen, the gates and
   the tests all read the same record rather than three descriptions of it. */
export const FREE_TIER = Object.freeze({
  briefs: 'unlimited',
  concepts: 6,
  refine: true,
  preflight: true,
  signupRequired: false,
  preview: 'watermarked',
  export: false,
  order: false
});

/** The kinds of thing a customer can hold. `file_pack` is the ৳199 one-off.
 *  `print_order` is what a paid print run leaves behind, so a customer who
 *  bought 500 cards is never asked to buy the file separately. `shop_channel`
 *  is the white-label outlet line of §9, and `comp` is a staff grant — a
 *  support case, a press test, a founder demo — which exists so that those
 *  never happen by someone editing a row by hand. */
export const KINDS = Object.freeze(['file_pack', 'print_order', 'shop_channel', 'comp']);

/** What a holder may do, per kind. Every paid kind releases the file, because
 *  the file is what all of them are ultimately buying; only a print line
 *  releases a run. */
const UNLOCKS = Object.freeze({
  file_pack:    Object.freeze({ export: true,  order: true }),
  print_order:  Object.freeze({ export: true,  order: true }),
  shop_channel: Object.freeze({ export: true,  order: true }),
  comp:         Object.freeze({ export: true,  order: true })
});

export const ACTIONS = Object.freeze(['export', 'order']);

export const SPEC_HASH_RE = /^[0-9a-f]{8,64}$/;

/* ── The watermark ─────────────────────────────────────────────────────────
   A watermark baked into the renderer is a watermark that eventually reaches
   a plate: `printDocSVG` in assets/engine.js builds the press document by
   stripping the outer <svg> off `renderSVG`'s output and re-wrapping the rest,
   so anything the renderer drew inside that body travels into the print path
   untouched. The safe construction is the opposite one — leave the renderer
   alone and wrap what it returned — which is why this is a function over an
   SVG string rather than an option on the renderer.

   Wrapping alone is not enough on its own, though, because "wrap the preview"
   depends on every future call site knowing which of its two SVGs is the
   preview. So the function identifies its subject rather than trusting the
   caller: it marks only a string carrying `class="card"`, the preview
   renderer's own signature, and refuses anything wearing the print document's
   millimetre page size or its <desc>. Called on a press file by mistake, it
   hands the press file back unchanged.

   What it draws is deliberately not destructive. Farhana is meant to
   screenshot this and post it (PRD §3.2), so a diagonal bar across the card
   would not protect anything — the gates below do that, on the server — it
   would only make her crop it or not post it. A corner pill reading CARDWORKS
   says where the card came from, which is the only thing a preview watermark
   can honestly be for, and a single faint wordmark across the card survives a
   crop of the corner. Both are drawn in mid grey so they read against a dark
   palette and a light one without the function having to know which. */

/** The attribute every watermark carries. Idempotency is checked against it,
 *  and the tests assert its absence from every print byte by this name. */
export const WATERMARK_MARKER = 'data-cardworks-watermark';

/** The wordmark itself, in one place so the pill and the diagonal cannot
 *  drift and so a test can look for the same string the renderer wrote. */
export const WATERMARK_TEXT = 'CARDWORKS';

/** True when this string is the preview renderer's output and not a press
 *  document. Positive identification, not an absence of red flags: a string
 *  that is neither is refused, which is what makes a new print path that has
 *  never heard of this function safe by default. */
export function isPreviewSVG(svg) {
  if (typeof svg !== 'string' || svg.length < 32) return false;
  const head = svg.slice(0, 400);
  if (!/^\s*<svg\b/.test(head)) return false;
  if (!/\bclass="card"/.test(head)) return false;
  /* The two print producers in assets/engine.js both size their page in
     millimetres and both open with a <desc> naming what they are. Either is
     enough to refuse on. */
  if (/\b(width|height)="[\d.]+mm"/.test(head)) return false;
  if (/<desc>[^<]*(print document|separation)/i.test(svg.slice(0, 800))) return false;
  return true;
}

export const isWatermarked = (svg) =>
  typeof svg === 'string' && svg.includes(WATERMARK_MARKER);

/** Wrap a preview SVG with the CARDWORKS mark. Returns the input unchanged
 *  for anything that is not a preview, and for a preview that already carries
 *  one, so calling it twice — or calling it on the wrong thing — is safe.
 *
 *  Geometry is derived from the viewBox, which the renderer writes in
 *  millimetres, so the mark is the same relative size on a 90×50 card as on a
 *  55×85 portrait one and does not have to be tuned per format. */
export function watermarkPreviewSVG(svg, opts = {}) {
  if (!isPreviewSVG(svg) || isWatermarked(svg)) return svg;
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) return svg;
  const w = Number(vb[1]), h = Number(vb[2]);
  if (!(w > 0) || !(h > 0)) return svg;
  const close = svg.lastIndexOf('</svg>');
  if (close < 0) return svg;

  const text = String(opts.text || WATERMARK_TEXT);
  const family = String(opts.fontFamily || 'ui-sans-serif, system-ui, sans-serif');

  /* The pill: bottom-right, one twelfth of the card's height, inset by the
     same amount so it never sits on the trim edge. A white ground with a grey
     hairline reads on a dark palette and still has an edge on a white one. */
  const padY = h * 0.055;
  const pillH = h * 0.105;
  const pillFont = pillH * 0.52;
  const pillW = pillFont * (text.length * 0.66 + 3.4);
  const pillX = w - padY - pillW;
  const pillY = h - padY - pillH;

  /* The diagonal: one wordmark corner to corner at a sixth opacity, which is
     visible enough to be a claim and light enough that no line of type on the
     card becomes hard to read under it. It exists so that cropping the pill
     out does not remove every trace of where the card came from. */
  const diagFont = h * 0.30;
  const angle = -(Math.atan2(h, w) * 180 / Math.PI).toFixed(2);

  const mark =
    `<g ${WATERMARK_MARKER}="1" aria-label="CARDWORKS preview" pointer-events="none">` +
      `<text x="${(w / 2).toFixed(3)}" y="${(h / 2 + diagFont * 0.34).toFixed(3)}"` +
      ` transform="rotate(${angle} ${(w / 2).toFixed(3)} ${(h / 2).toFixed(3)})"` +
      ` font-family="${family}" font-weight="800" font-size="${diagFont.toFixed(3)}"` +
      ` letter-spacing="${(diagFont * 0.06).toFixed(3)}"` +
      ` fill="#808080" fill-opacity="0.16" text-anchor="middle">${text}</text>` +
      `<rect x="${pillX.toFixed(3)}" y="${pillY.toFixed(3)}"` +
      ` width="${pillW.toFixed(3)}" height="${pillH.toFixed(3)}"` +
      ` rx="${(pillH / 2).toFixed(3)}" ry="${(pillH / 2).toFixed(3)}"` +
      ` fill="#ffffff" fill-opacity="0.88" stroke="#808080" stroke-opacity="0.55"` +
      ` stroke-width="${(h * 0.004).toFixed(3)}"/>` +
      `<text x="${(pillX + pillW / 2).toFixed(3)}" y="${(pillY + pillH * 0.68).toFixed(3)}"` +
      ` font-family="${family}" font-weight="700" font-size="${pillFont.toFixed(3)}"` +
      ` letter-spacing="${(pillFont * 0.10).toFixed(3)}"` +
      ` fill="#1a1a1a" text-anchor="middle">${text}</text>` +
    `</g>`;

  return svg.slice(0, close) + mark + svg.slice(close);
}

/* ── Reading what a caller holds ───────────────────────────────────────────
   A holder is an account, or the anonymous browser key that stands in for one
   before signup. Both are accepted because §3.2's whole point is that no
   signup is required to get to a preview, and a customer who pays by bKash
   without ever signing in must still get the file they paid for.

   The browser key is not an authenticated identity — lib/auth.mjs says so
   plainly: possession of the key is already the whole of the anonymous
   authority, and `/api/orders?list=1&owner=KEY` will list against it today. So
   holding an entitlement by key grants a thief nothing they could not already
   reach with the same key, and signing in claims the key onto the account
   through `owner_claims`, after which the account is the durable holder. */

/** Normalise the holder, dropping anything that is not the shape it claims.
 *  A malformed key is treated as absent rather than passed to the query, so a
 *  caller cannot smuggle a predicate through it. */
export function holderFrom({ userId = null, ownerKey = null } = {}) {
  const uid = Number.isInteger(userId) && userId > 0 ? userId : null;
  const key = OWNER_RE.test(String(ownerKey || '')) ? String(ownerKey) : null;
  return { userId: uid, ownerKey: key, anonymous: uid === null };
}

/** Who is asking, on the same terms as `orders.mjs`: a verified session
 *  outranks the browser key, and the key still works because Technical Design
 *  §9 keeps the funnel usable without an account.
 *
 *  It exists here rather than being copied into each endpoint because of the
 *  rule in lib/auth.mjs's header — a path whose statements name `user_id` must
 *  authenticate with `sql`, since the signature-only readers hand back a live
 *  user on a deploy where migration 004 never ran and the column is not there.
 *  The read this feeds names `e.user_id`. One copy of that decision means one
 *  place it can be got wrong. */
export async function actorFrom(req, sql = null, bodyOwner = null) {
  const [user] = await authenticate(req, sql).catch(() => [null, null]);
  let raw = String(bodyOwner || '');
  if (!raw && req && req.url) {
    try { raw = String(new URL(req.url).searchParams.get('owner') || ''); } catch { raw = ''; }
  }
  return { userId: user ? user.userId : null, ownerKey: OWNER_RE.test(raw.trim()) ? raw.trim() : null };
}

/** The free-tier answer, which is also the answer whenever nothing is held.
 *  It is a value rather than a null so that no call site has to remember that
 *  "no rows" means "free" — the shape is the same either way. */
export function freeEntitlement(specHash = null) {
  return {
    specHash,
    tier: 'free',
    grants: [],
    may: { export: false, order: false },
    watermark: true
  };
}

/** Fold a set of grant rows into what they permit. Pure, so the policy is
 *  testable without a database and so the endpoint and the screen cannot
 *  disagree about what a row means. */
export function entitlementFrom(specHash, rows = []) {
  const grants = (rows || []).filter(r => r && KINDS.includes(r.kind) && !r.revoked_at);
  if (!grants.length) return freeEntitlement(specHash);
  const may = { export: false, order: false };
  for (const g of grants) {
    const u = UNLOCKS[g.kind];
    if (u.export) may.export = true;
    if (u.order) may.order = true;
  }
  return {
    specHash,
    tier: 'paid',
    grants: grants.map(g => ({ ref: g.ref, kind: g.kind, source: g.source,
                               sourceRef: g.source_ref, grantedAt: g.granted_at })),
    may,
    /* A customer who has paid for this design's file sees it clean. The
       watermark is a statement about the tier, not about the picture. */
    watermark: !may.export
  };
}

/** What this holder may do with this design. Never throws for a missing table:
 *  a deploy that has not applied migration 008 has no entitlements to read, so
 *  the honest answer is the free tier and a flag saying the read failed — the
 *  caller turns that into a 503 rather than into a sale it cannot record. */
export async function entitlementsFor(sql, opts = {}) {
  const { specHash, shortCode = null, userId = null, ownerKey = null } = opts;
  /* A short code is the public name of a design and is what a screen and the
     order endpoint have to hand, so it is accepted — and resolved through
     `design_specs` rather than trusted. A code naming nothing is a design
     nobody has saved, which is the free tier and not an error. */
  let hash = String(specHash || '').toLowerCase();
  if (!hash && sql && CODE_RE.test(String(shortCode || ''))) {
    try {
      const found = await sql`SELECT spec_hash FROM design_specs WHERE short_code = ${shortCode} LIMIT 1`;
      hash = found.length ? String(found[0].spec_hash).toLowerCase() : '';
    } catch (e) { console.error('spec lookup failed:', e && e.message); }
  }
  if (!SPEC_HASH_RE.test(hash)) return { ...freeEntitlement(null), unreadable: 'bad_spec_hash' };
  const holder = holderFrom({ userId, ownerKey });
  if (!sql) return { ...freeEntitlement(hash), unreadable: 'no_database' };
  if (!holder.userId && !holder.ownerKey) return freeEntitlement(hash);

  let rows;
  try {
    rows = await sql`
      SELECT e.ref, e.kind, e.source, e.source_ref, e.granted_at, r.revoked_at
      FROM entitlements e
      LEFT JOIN entitlement_revocations r ON r.entitlement_id = e.id
      WHERE e.spec_hash = ${hash}
        AND r.id IS NULL
        AND ( (${holder.userId}::bigint IS NOT NULL AND e.user_id = ${holder.userId}::bigint)
           OR (${holder.ownerKey}::text IS NOT NULL AND e.owner_key = ${holder.ownerKey}::text) )
      ORDER BY e.granted_at`;
  } catch (e) {
    console.error('entitlement read failed:', e && e.message);
    return { ...freeEntitlement(hash), unreadable: 'migration-008-not-applied' };
  }
  return entitlementFrom(hash, rows);
}

/* ── Refusals ──────────────────────────────────────────────────────────────
   `remediation` in the envelope is a machine token, never a sentence: a screen
   has to branch on the next step and cannot branch on the code, and a
   server-written English sentence cannot be shown to a Bangla reader
   (lib/http.mjs). `buy_file_pack` is a new token, so it travels with a
   `remediationText` fallback in the same object — assets/ui-shell.js's table
   does not know it yet, and `remedyText` renders an unrecognised token as
   nothing rather than as itself, which would leave the customer reading a
   blank next step. §11 of tests/auth.test.mjs enforces the pairing.

   402 rather than 403. The request was well formed and the caller is not
   forbidden from anything — there is a price, and paying it is the next step.
   That distinction is what lets the screen show a purchase panel instead of an
   error it cannot act on, exactly as render-print.mjs's 422-not-400 does for a
   design that is well formed and unprintable. */

export const REFUSAL_CODE = 'payment_required';

const price = () => ({ amount: FILE_PACK.amount, currency: FILE_PACK.currency,
                       kind: FILE_PACK.kind, band: FILE_PACK.band.slice() });

/** The refusal for an action nobody has paid for. Names the price and the next
 *  step, because a gate that only says no teaches the customer nothing about
 *  how to get past it. */
export function refuse(action, { specHash = null, unreadable = null } = {}) {
  if (unreadable === 'no_database' || unreadable === 'migration-008-not-applied')
    return ERR.unavailable(
      'Purchases are not configured for this deploy, so nothing can be unlocked here.',
      { remediation: 'contact_support',
        remediationText: 'This is a deployment gap on our side, not something you can fix. Nothing you have designed is affected.' });

  if (action === 'order')
    return fail(402, REFUSAL_CODE,
      `A print run sends this design's file to a press, and the file pack is ৳${FILE_PACK.amount} for this design. It is credited against the print order, so you never pay for it twice.`,
      { remediation: 'buy_file_pack',
        remediationText: `The file pack is ৳${FILE_PACK.amount} for this design — ${FILE_PACK.what}. It is credited against the price of a print run, so the design costs the same either way. Briefing, six concepts, refining them and the preflight report stay free, and your card stays exactly as you designed it.`,
        price: price(), specHash });

  return fail(402, REFUSAL_CODE,
    `The print file is the file pack — ৳${FILE_PACK.amount} for this design, one payment, no subscription.`,
    { remediation: 'buy_file_pack',
      remediationText: `The file pack is ৳${FILE_PACK.amount} for this design — ${FILE_PACK.what}. Briefing, six concepts, refining them and the preflight report stay free for as long as you want them.`,
      price: price(), specHash });
}

/** The two-line gate every endpoint adopts. Returns `{ ok, entitlement,
 *  refusal }` and never throws for a caller who simply has not paid. */
export async function assertEntitled(sql, action, opts = {}) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown entitlement action: ${action}`);
  const ent = await entitlementsFor(sql, opts);
  if (ent.unreadable === 'bad_spec_hash')
    return { ok: false, entitlement: ent,
             refusal: ERR.badRequest('A design has to be saved before it can be unlocked.',
               { field: 'specHash' }) };
  if (ent.may[action]) return { ok: true, entitlement: ent, refusal: null };
  return { ok: false, entitlement: ent,
           refusal: refuse(action, { specHash: ent.specHash, unreadable: ent.unreadable }) };
}

/* ── Granting ──────────────────────────────────────────────────────────────
   The only route by which a row appears in `entitlements` outside a staff
   grant. It takes a payment reference and derives everything else, so there is
   no field a caller could set that ends up stored: the spec hash comes from
   the design the order names, the holder comes from the order, and the amount
   comes from the payment. A reference that names a payment which is not
   captured selects nothing and inserts nothing.

   That is deliberately stronger than checking the payment first and inserting
   second. Two requests racing a capture would both pass a read-then-write
   check; an INSERT … SELECT is one statement, and the unique index on
   (source, source_ref, spec_hash) makes the second one a no-op rather than a
   duplicate grant. It is the same reasoning db/migrations/003_payments.sql
   gives for deciding a double capture in the database rather than in the
   application. */

/** Statuses that mean money actually moved. A partially refunded payment still
 *  paid for the file; a fully refunded one is withdrawn by `revokeForRefund`
 *  rather than by being excluded here, so the history says what happened. */
const PAID = ['captured', 'partially_refunded', 'refunded'];

/** Turn a captured payment into an entitlement. `paymentRef` is the only
 *  argument that is not the database handle, and it is used solely to find a
 *  row — never to fill one. Returns the grants written, which is empty when
 *  the payment is not captured, does not exist, or has already granted. */
export async function grantFromPayment(sql, paymentRef, opts = {}) {
  if (!sql) return { granted: [], reason: 'no_database' };
  const ref = String(paymentRef || '').trim().toUpperCase();
  if (!/^PAY-[0-9A-Z]{4,12}$/.test(ref)) return { granted: [], reason: 'bad_payment_ref' };
  const kind = KINDS.includes(opts.kind) ? opts.kind : 'print_order';

  const rows = await sql`
    INSERT INTO entitlements (kind, spec_hash, user_id, owner_key, source, source_ref, amount, currency)
    SELECT ${kind}, d.spec_hash, o.user_id, o.owner_key, 'payment', p.ref, p.amount, p.currency
    FROM payments p
    JOIN orders o        ON o.ref = p.order_ref
    JOIN design_specs d  ON d.short_code = o.short_code
    WHERE p.ref = ${ref}
      AND p.status = ANY(${PAID})
    ON CONFLICT (source, source_ref, spec_hash) DO NOTHING
    RETURNING ref, kind, spec_hash, granted_at`;
  return { granted: rows, reason: rows.length ? 'granted' : 'not_captured_or_already_granted' };
}

/** Withdraw what a refund undid. A revocation is its own row rather than an
 *  edit, for the reason db/schema.sql gives for design specs and 003 gives for
 *  payments: the record of what was granted is evidence, and a refund that
 *  quietly deleted it would leave nothing to reconcile against. */
export async function revokeForRefund(sql, paymentRef, reason = 'refunded') {
  if (!sql) return { revoked: [] };
  const ref = String(paymentRef || '').trim().toUpperCase();
  if (!/^PAY-[0-9A-Z]{4,12}$/.test(ref)) return { revoked: [] };
  const rows = await sql`
    INSERT INTO entitlement_revocations (entitlement_id, reason, source_ref)
    SELECT e.id, ${String(reason).slice(0, 120)}, p.ref
    FROM entitlements e
    JOIN payments p ON p.ref = e.source_ref
    WHERE e.source = 'payment' AND e.source_ref = ${ref} AND p.status = 'refunded'
    ON CONFLICT (entitlement_id) DO NOTHING
    RETURNING entitlement_id`;
  return { revoked: rows };
}
