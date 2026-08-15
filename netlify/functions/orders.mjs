/* Orders, and the list behind "My designs".
 *
 * The prototype's best product decision was proof-before-charge: a printed
 * proof is made first, and the run only starts once the customer has held it.
 * That is encoded here as an append-only event log — the order's history of
 * who approved what and when can never be overwritten.
 *
 * Three things this endpoint used to take on trust, and no longer does.
 *
 * It accepted a `total` computed by the browser, which meant the price was
 * whatever the client said it was. The amount now comes from the quote the
 * customer was actually shown, re-derived server-side through
 * `lib/quote-server.mjs`; a client-supplied total is read only to be compared
 * and reported when it disagrees.
 *
 * It placed an order for any saved design, whether or not that design could
 * be printed. Preflight ran in the browser, so skipping the JS skipped the
 * guarantee. `lib/preflight-gate.mjs` now re-runs the same engine server-side
 * and refuses a design with a blocking finding, or with an advisory nobody
 * has accepted on the record.
 *
 * And it identified a customer by a random string their own browser minted.
 * A real session is used when one is present (`lib/auth.mjs`); the anonymous
 * owner key still works, because Technical Design §9 keeps briefing usable
 * without an account, but it no longer decides anything a session can.
 */
import {
  handler, ok, ERR, readJson, db, OWNER_RE, REF_RE,
  idempotencyKey, replay, remember
} from '../../lib/http.mjs';
import { assertPrintable } from '../../lib/preflight-gate.mjs';
import { amountForOrder, loadPresses, PROOF_MANDATORY_FINISHES } from '../../lib/quote-server.mjs';
import { authenticate } from '../../lib/auth.mjs';
import {
  createStore, beginApprovalPayment, chargeability, paymentState, PaymentError
} from '../../lib/payments/index.mjs';

/* The stages a customer sees on the tracking screen. Wireframing §5.12 draws
   this as a vertical, timestamped log, which is exactly what `order_events`
   holds — the labels live here so the client never invents its own. */
const FLOW = [
  ['files_locked',      'Files locked',        'Preflight passed with no blocking finding'],
  ['at_press',          'Sent to press',       'Plates and any foil block prepared'],
  ['proof_printed',     'Proof printed',       'One card, on the exact stock and finish of the run'],
  ['proof_delivered',   'Proof delivered',     'Courier handover'],
  ['awaiting_approval', 'Your approval',       'The run does not start, and nothing is charged, until you approve'],
  ['printing',          'Run and delivery',    'Four working days after approval'],
  ['delivered',         'Delivered',           '']
];

/* Who is asking. A verified session outranks the browser key, and when both
   are present the session's own owner keys are what the listing uses — which
   is how a customer who signs in on a second phone sees the work they did on
   the first. */
async function actorFor(req, sql, bodyOwner) {
  /* `authenticate` resolves to `[user, refusal]`, mirroring `readJson` — not
     to a user or null. Reading `.userId` off the array made every signed-in
     customer look anonymous, and it failed in the reassuring direction:
     people still saw their own browser's work, so nothing looked broken while
     the one thing accounts exist to deliver quietly did not happen.

     The catch stays, for a different reason than it looks: an absent or
     invalid token never rejects, but the revocation query inside will on a
     deploy that has not run migration 004, because `auth_sessions` is not
     there yet. It only has to yield a tuple.

     That catch is also what makes it safe for this endpoint to name
     `user_id` on the INSERT below. The `sql` argument is load-bearing:
     `sessionFrom(req)` and `authenticate(req)` without sql verify by
     signature and clock alone, so they would hand back a live user on a
     deploy where that column does not exist yet. Any path that names
     `user_id` authenticates with `sql`. */
  const [user] = await authenticate(req, sql).catch(() => [null, null]);
  const url = new URL(req.url);
  const raw = (url.searchParams.get('owner') || bodyOwner || '').trim();
  return { session: user, owner: OWNER_RE.test(raw) ? raw : null };
}

const label = (a) => a.session ? `user:${a.session.userId}` : (a.owner ? 'browser' : 'anonymous');

export default handler('orders', async (req) => {
  const sql = db();
  if (!sql) return ERR.unavailable();

  const url = new URL(req.url);

  /* ── list designs + orders for this browser or account ── */
  if (req.method === 'GET' && url.searchParams.get('list') === '1') {
    const a = await actorFor(req, sql, null);
    if (!a.session && !a.owner) return ok({ designs: [], orders: [], identity: 'anonymous' });

    /* A signed-in customer's work is whatever their claimed browser keys
       point at, plus anything already attributed to the account. */
    const uid = a.session ? a.session.userId : null;
    const keys = uid
      ? (await sql`SELECT owner_key FROM owner_claims WHERE user_id = ${uid}`
          .catch(() => [])).map(r => r.owner_key)
      : [];
    if (a.owner && !keys.includes(a.owner)) keys.push(a.owner);
    if (!uid && !keys.length) return ok({ designs: [], orders: [], identity: label(a) });

    /* Both predicates, always. Work made before signing in is reachable only
       through a claimed owner key; work made after is stamped with the user
       id at insert. Someone who signs in on a fresh browser and orders has
       an unclaimed key and would see nothing at all if this asked for only
       one of the two. `design_specs.user_id` can only ever be set at INSERT,
       because the append-only trigger raises on UPDATE — which is precisely
       why pre-account work has to come back through `owner_claims`. */
    const designs = await sql`
      SELECT short_code, label, created_at,
             spec_json->'content'->>'name'    AS name,
             spec_json->>'layout'             AS layout,
             spec_json->>'palette'            AS palette
      FROM design_specs
      WHERE user_id = ${uid} OR owner_key = ANY(${keys})
      ORDER BY created_at DESC LIMIT 24`;
    const orders = await sql`
      SELECT ref, short_code, qty, press, total, status, created_at
      FROM orders
      WHERE user_id = ${uid} OR owner_key = ANY(${keys})
      ORDER BY created_at DESC LIMIT 24`;
    return ok({ designs, orders, identity: label(a) });
  }

  /* ── one order, with its event history ── */
  if (req.method === 'GET') {
    const ref = (url.searchParams.get('ref') || '').trim().toUpperCase();
    if (!REF_RE.test(ref)) return ERR.badRequest('That is not an order reference.', { field: 'ref' });
    const rows = await sql`SELECT * FROM orders WHERE ref = ${ref} LIMIT 1`;
    if (!rows.length) return ERR.notFound('No order with that reference.');
    const events = await sql`
      SELECT type, actor, note, created_at FROM order_events
      WHERE order_ref = ${ref} ORDER BY created_at`;

    /* The client should never have to infer whether the approve button does
       anything — the server says so, in the same shape the payment module
       reasons in. */
    const charge = chargeability(rows[0].status);
    const payment = await paymentState(createStore(sql), ref).catch(() => null);
    return ok({ order: rows[0], events, flow: FLOW, charge, payment });
  }

  if (req.method !== 'POST') return ERR.badRequest('Method not allowed.');

  const [b, bad] = await readJson(req, 16 * 1024);
  if (bad) return bad;

  const key = idempotencyKey(req);
  const scope = b.ref ? 'orders:advance' : 'orders:place';
  const replayed = await replay(sql, key, scope);
  if (replayed) return replayed;

  const a = await actorFor(req, sql, typeof b.owner === 'string' ? b.owner : null);

  /* ── advance an existing order ── */
  if (b.ref) {
    const ref = String(b.ref).toUpperCase();
    if (!REF_RE.test(ref)) return ERR.badRequest('That is not an order reference.', { field: 'ref' });

    const action = String(b.action || '');
    if (!['approve', 'reproof', 'cancel'].includes(action))
      return ERR.badRequest('Unknown action.', { field: 'action',
        remediation: 'The order can be approved, sent back for another proof, or cancelled.' });

    const cur = await sql`SELECT status FROM orders WHERE ref = ${ref} LIMIT 1`;
    if (!cur.length) return ERR.notFound('No order with that reference.');
    if (cur[0].status === 'delivered' || cur[0].status === 'cancelled')
      return ERR.conflict('This order is closed.', {
        remediation: 'Start a new order from the saved design.' });

    /* Approval is the moment money moves, and it is the only one. Everything
       else is a status change; this is a payment, so it goes through the
       payment module rather than an UPDATE here — that module owns the
       "cannot charge twice" guarantee and the partial unique index behind it.
       It also decides where the customer comes back to after typing their
       PIN: an earlier version of this function forwarded a `callbackURL`
       straight off the request body, which let a caller choose the page a
       paying stranger lands on — a phishing hop that looks like a completed
       payment to everyone watching. The callback is the money module's to
       resolve against PUBLIC_BASE_URL, and nothing here supplies one. */
    if (action === 'approve') {
      const provider = String(b.provider || '');
      if (!provider) return ERR.badRequest('Choose how you want to pay.', {
        field: 'provider', remediation: 'bKash, Nagad, or cash on delivery.' });
      try {
        const res = await beginApprovalPayment(createStore(sql), {
          orderRef: ref, provider, actor: label(a), idemKey: key,
          claimedAmount: b.total === undefined ? undefined : Number(b.total),
          payerReference: b.payerReference || null, sql
        });
        await sql`INSERT INTO order_events (order_ref, type, actor, note)
                  VALUES (${ref}, 'approve', ${label(a)}, ${String(b.note || '').slice(0, 400) || null})`;
        const body = { ref, status: res.orderStatus, payment: res.payment,
                       redirectURL: res.redirectURL, replayed: !!res.replayed };
        await remember(sql, key, scope, 200, body);
        return ok(body);
      } catch (err) {
        /* A PaymentError carries its next step in `detail`, not on the error
           itself; reading `err.remediation` here silently dropped it and the
           customer got a refusal with nothing to do about it. */
        if (err instanceof PaymentError)
          return ERR.conflict(err.message, { code: err.code, ...(err.detail || {}) });
        throw err;
      }
    }

    const next = action === 'reproof' ? 'proof_printed' : 'cancelled';
    await sql`UPDATE orders SET status = ${next} WHERE ref = ${ref}`;
    await sql`INSERT INTO order_events (order_ref, type, actor, note)
              VALUES (${ref}, ${action}, ${label(a)}, ${String(b.note || '').slice(0, 400) || null})`;
    const body = { ref, status: next };
    await remember(sql, key, scope, 200, body);
    return ok(body);
  }

  /* ── place a new order ── */
  const code = String(b.shortCode || '').trim();

  /* The design has to be printable before it can be ordered. This is the
     server-side half of the print-correct guarantee: the browser runs the
     same checks, but a request that never ran the browser reaches here. */
  const gate = await assertPrintable(sql, { shortCode: code });
  if (!gate.ok) return gate.refusal;

  const qty = Math.max(1, Math.min(100000, Number(b.qty) || 500));
  const finishes = Array.isArray(b.finishes) ? b.finishes : [];
  const zone = b.zone === 'outside' ? 'outside' : 'dhaka';

  /* The price is the one the customer was quoted, re-derived from the quote
     reference rather than taken from the request. A quote that has expired or
     been repriced is a conflict for the customer to see, not a difference to
     absorb quietly in either direction. */
  const presses = await loadPresses(sql).catch(() => null);
  const priced = await amountForOrder({
    sql, presses, quoteId: b.quoteId, press: b.press, qty, finishes, zone
  });
  if (!priced.ok)
    return ERR.conflict(priced.message, { code: priced.code, remediation: priced.remediation });

  const claimed = b.total === undefined ? null : Math.round(Number(b.total) || 0);
  if (claimed !== null && claimed !== priced.amount)
    return ERR.conflict('The price changed since this order was quoted.', {
      code: 'price_moved', quoted: priced.amount, claimed,
      remediation: 'Review the updated quote before placing the order.' });

  /* The reference comes from a dedicated Postgres sequence (see
     db/schema.sql). An earlier version derived it from a row count and
     truncated to a fixed width, which silently collapsed ten consecutive
     orders onto the same reference — the second one then failed on the unique
     index. A sequence is also race-safe. */
  const ins = await sql`
    INSERT INTO orders (owner_key, user_id, short_code, qty, press, finishes, zone,
                        subtotal, total, status, recipient)
    VALUES (${a.owner}, ${a.session ? a.session.userId : null}, ${code}, ${qty},
            ${String(priced.option?.name || b.press || 'Unassigned').slice(0, 80)},
            ${JSON.stringify(finishes)}::jsonb, ${zone},
            ${priced.quote?.subtotal ?? priced.amount}, ${priced.amount},
            'files_locked', ${JSON.stringify(b.recipient || {})}::jsonb)
    RETURNING ref`;
  const ref = ins[0].ref;

  /* Pin the quote to the order so the payment charges the same number the
     customer accepted. The column is added by A4's migration; a deploy that
     has not run it yet still takes the order rather than refusing it. */
  await sql`UPDATE orders SET quote_id = ${b.quoteId} WHERE ref = ${ref}`.catch(() => {});

  /* Specials cannot be approved from a photograph — PRD §7 makes a physical
     proof mandatory for foil, letterpress, emboss and edge paint. Recording
     it on the order is what lets the tracking screen say why the wait exists. */
  const needsProof = finishes.some(f => PROOF_MANDATORY_FINISHES.includes(f));

  for (const [type, , note] of FLOW.slice(0, 5)) {
    await sql`INSERT INTO order_events (order_ref, type, actor, note)
              VALUES (${ref}, ${type}, ${type === 'files_locked' ? label(a) : 'press'}, ${note || null})`;
  }
  if (needsProof)
    await sql`INSERT INTO order_events (order_ref, type, actor, note)
              VALUES (${ref}, 'proof_required', 'system',
                      'A physical proof is mandatory for this finish and cannot be waived')`;

  await sql`UPDATE orders SET status = 'awaiting_approval' WHERE ref = ${ref}`;
  await sql`INSERT INTO usage_events (type, short_code, meta)
            VALUES ('order.placed', ${code},
                    ${JSON.stringify({ ref, qty, total: priced.amount,
                                       unvalidatedCosts: priced.unvalidatedCosts })}::jsonb)`;

  /* The same fact, recorded a second time and deliberately so. `usage_events`
     is the operational log; `metric_events` is what PRD §5.3 and §10 are
     computed from, and it is append-only at the database with a narrower,
     content-free shape. Deriving the exit criteria from the operational log
     instead would mean either widening that log or narrowing the metric, and
     both end with the north star quietly measuring something else.

     Failure here never fails an order. A customer's card does not depend on
     our being able to count it. */
  try {
    const { record } = await import('../../lib/metrics.mjs');
    await record(sql, 'order.placed', { orderRef: ref, shortCode: code,
      briefKey: typeof b.briefKey === 'string' ? b.briefKey : null,
      meta: { qty, zone, format: priced.option?.slug || null } });
  } catch (e) { console.error('metric emit failed:', e && e.message); }

  const body = {
    ref, status: 'awaiting_approval', total: priced.amount, currency: priced.currency,
    unvalidatedCosts: priced.unvalidatedCosts, proofRequired: needsProof,
    preflight: { status: gate.report.status, advisory: gate.report.advisory.length }
  };
  await remember(sql, key, scope, 201, body);
  return ok(body, 201);
});

export const config = { path: '/api/orders' };
