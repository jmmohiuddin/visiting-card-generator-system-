/* The payment endpoint.
 *
 * All of the judgement lives in lib/payments; this file is the edge — it
 * parses, it authorises, it maps a PaymentError onto a status code, and it
 * hands the provider's redirect back to the browser. The one thing it does
 * that matters on its own is what it refuses to read: there is no code path
 * here that takes an amount out of a request body and charges it. A `total`
 * in the body is passed along as a claim to be logged and discarded, which is
 * the whole point of the exercise (Technical Design §10 item 2).
 *
 * The flow, as the order screen will drive it:
 *
 *   POST { ref, action: 'begin', provider }   at `awaiting_approval` only.
 *        bKash and Nagad return a redirectURL; cash on delivery returns none
 *        and the order is already at `printing` when the reply lands.
 *   GET  ?callback=bkash&paymentID=…&status=success
 *        where the customer comes back to. We ask the provider what happened
 *        rather than believing the query string, then redirect into the app.
 *   POST { ref, action: 'complete', provider, providerRef }
 *        the same capture for a caller that is not a browser.
 *   POST { ref, action: 'settle' }            cash handed over at delivery.
 *   POST { ref, action: 'refund' }            staff only.
 *
 * Every mutating call honours `Idempotency-Key`. That header is also what
 * becomes the payment's capture_key, so a retry is the same attempt all the
 * way down to the unique index rather than only at this layer.
 */
import {
  handler, ok, ERR, readJson, db, REF_RE, idempotencyKey, replay, remember
} from '../../lib/http.mjs';
import {
  createStore, beginApprovalPayment, completePayment, settleCashOnDelivery,
  refundOrder, paymentState, paymentMethods, PaymentError, QuoteError
} from '../../lib/payments/index.mjs';

/* A payment failure is not one status code. Splitting them out here is what
   lets the order screen tell "you have not approved yet" apart from "bKash
   said no" apart from "we owe you a refund" without parsing prose. */
const STATUS_FOR = {
  order_not_found: 404, payment_not_found: 404,
  payment_too_early: 409, already_started: 409, order_cancelled: 409,
  order_not_payable: 409, not_capturable: 409, order_moved: 409,
  cash_settlement_conflict: 409, no_cash_intent: 409, nothing_to_refund: 409,
  amount_drift: 409, too_many_attempts: 409,
  unknown_provider: 400, bad_refund_amount: 400, cod_needs_courier: 403,
  /* Refusals that come out of lib/quote-server.mjs, passed through with its
     own codes so the order screen can offer the remediation it wrote. The
     list is A4's, read off that module rather than guessed: a code missing
     from here still answers, but as a bare 402, which loses the difference
     between "your quote expired" and "the rail said no". */
  quote_unavailable: 422, bad_quote: 400, bad_request: 400, unknown_finish: 400,
  quote_expired: 409, quote_stale: 409, press_unavailable: 409,
  finish_unavailable: 409, no_capable_press: 409,
  provider_unconfigured: 503, callback_unconfigured: 503,
  provider_unreachable: 502, provider_bad_response: 502,
  payment_reconciliation: 502
};

const asError = (err) => {
  const status = STATUS_FOR[err.code] || 402;
  return new Response(
    JSON.stringify({ error: { code: err.code, message: err.message, ...(err.detail || {}) } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  );
};

/* Settlement and refunds move money in the customer's favour or out of the
   till, so they are not customer actions. Real staff accounts arrive with A5;
   until then a shared token is the honest placeholder, and a deploy that has
   not set one refuses these two actions outright rather than leaving them
   open. */
const staffAuthorised = (req) => {
  const expected = (process.env.CARDWORKS_STAFF_TOKEN || '').trim();
  if (!expected) return false;
  const got = (req.headers.get('x-cardworks-staff') || '').trim();
  return got.length === expected.length && got === expected;
};

const appURL = (path) => {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return base ? base + path : path;
};

export default handler('payments', async (req) => {
  const sql = db();
  if (!sql) return ERR.unavailable();
  const store = createStore(sql);
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      /* Where bKash and Nagad send the customer back. The query string is a
         hint about what happened, never the evidence — completePayment asks
         the provider directly, which is the only version of this that a
         hand-edited redirect cannot lie its way through. */
      const callback = url.searchParams.get('callback');
      if (callback) return await handleCallback(store, url, callback, sql);

      if (url.searchParams.get('methods') === '1') return ok({ methods: paymentMethods() });

      const ref = (url.searchParams.get('ref') || '').trim().toUpperCase();
      if (!REF_RE.test(ref)) return ERR.badRequest('A valid order reference is required.', { field: 'ref' });
      return ok(await paymentState(store, ref));
    }

    if (req.method !== 'POST') return ERR.badRequest('Method not allowed.');

    const [body, bad] = await readJson(req);
    if (bad) return bad;

    const key = idempotencyKey(req);
    const scope = 'payments';
    /* `replay` reads idempotency_keys, which arrives with A6's migration 001
       and is not in every deploy yet. Without this guard a missing table turns
       every keyed POST into a 500 — and it would do it at the one moment the
       customer is trying to pay. Losing the response cache is survivable
       because it is not the only defence: the same key is the payment's
       capture_key, unique per order in the database, so a retry still finds
       the first attempt rather than opening a second charge. `remember` is
       already best-effort for the same reason. */
    let replayed = null;
    try { replayed = await replay(sql, key, scope); }
    catch (e) { console.error('idempotency replay unavailable:', e && e.message); }
    if (replayed) return replayed;

    const ref = String(body.ref || '').trim().toUpperCase();
    if (!REF_RE.test(ref)) return ERR.badRequest('A valid order reference is required.', { field: 'ref' });
    const action = String(body.action || 'begin');

    let payload, status = 200;

    if (action === 'begin') {
      const res = await beginApprovalPayment(store, {
        orderRef: ref,
        provider: body.provider,
        actor: 'customer',
        idemKey: key,
        payerReference: typeof body.payerReference === 'string' ? body.payerReference : null,
        callbackURL: appURL(`/api/payments?callback=${encodeURIComponent(String(body.provider || ''))}&ref=${encodeURIComponent(ref)}`),
        /* Read only so the divergence can be recorded. Never charged. */
        claimedAmount: body.total,
        clientIp: req.headers.get('x-nf-client-connection-ip') || null,
        sql
      });
      payload = {
        ref, paymentRef: res.payment.ref, provider: res.payment.provider,
        amount: res.payment.amount, currency: res.payment.currency,
        redirectURL: res.redirectURL || null, orderStatus: res.orderStatus,
        simulated: !!res.payment.simulated, replayed: !!res.replayed
      };
      status = res.replayed ? 200 : 201;

    } else if (action === 'complete') {
      const res = await completePayment(store, {
        orderRef: ref, provider: body.provider, providerRef: body.providerRef,
        actor: 'customer', sql
      });
      payload = {
        ref, paymentRef: res.payment.ref, status: res.payment.status,
        amount: res.payment.amount, orderStatus: res.orderStatus,
        incident: res.incident || null, replayed: !!res.replayed
      };

    } else if (action === 'settle') {
      if (!staffAuthorised(req))
        return ERR.forbidden('A cash settlement is recorded by the courier or the shop.');
      const res = await settleCashOnDelivery(store, { orderRef: ref, actor: 'courier', idemKey: key });
      payload = { ref, paymentRef: res.payment.ref, status: res.payment.status, replayed: !!res.replayed };

    } else if (action === 'refund') {
      if (!staffAuthorised(req)) return ERR.forbidden('Refunds are issued by staff.');
      const res = await refundOrder(store, {
        orderRef: ref, amount: body.amount === undefined ? null : body.amount,
        reason: body.reason || 'requested', actor: 'staff', idemKey: key
      });
      payload = { ref, refund: res.refund.ref, refundStatus: res.refund.status,
                  paymentStatus: res.payment ? res.payment.status : null };

    } else {
      return ERR.badRequest('Unknown action.', { field: 'action' });
    }

    await remember(sql, key, scope, status, payload);
    return ok(payload, status);

  } catch (err) {
    if (err instanceof PaymentError || err instanceof QuoteError) return asError(err);
    throw err;
  }
});

/* The browser leg. bKash appends paymentID and status; Nagad appends
   payment_ref_id and status. We capture on the way through and then send the
   customer to the order page either way, because a payment page is a dead end
   and the order is what they came for. */
async function handleCallback(store, url, providerId, sql) {
  const ref = (url.searchParams.get('ref') || '').trim().toUpperCase();
  const providerRef = url.searchParams.get('paymentID')
    || url.searchParams.get('payment_ref_id')
    || url.searchParams.get('paymentRefId');
  const declared = (url.searchParams.get('status') || '').toLowerCase();

  const back = (state, extra = '') =>
    new Response(null, {
      status: 303,
      headers: {
        location: appURL(`/?order=${encodeURIComponent(ref)}&payment=${state}${extra}`),
        'cache-control': 'no-store'
      }
    });

  /* A cancel is the customer changing their mind, not a failure. Nothing was
     charged, the order is still at `awaiting_approval`, and they can start
     again from the same screen. */
  if (declared && declared !== 'success') return back(declared === 'cancel' ? 'cancelled' : 'failed');
  if (!REF_RE.test(ref) || !providerRef) return back('failed');

  try {
    const res = await completePayment(store, { orderRef: ref, provider: providerId, providerRef, sql });
    return back(res.orderStatus === 'printing' ? 'ok' : 'pending',
      res.incident ? `&incident=${encodeURIComponent(res.incident)}` : '');
  } catch (err) {
    if (err instanceof PaymentError && err.detail && err.detail.incident)
      return back('refunded', `&incident=${encodeURIComponent(err.detail.incident)}`);
    console.error('payment callback failed:', err && err.code, err && err.message);
    return back('failed');
  }
}

export const config = { path: '/api/payments' };
