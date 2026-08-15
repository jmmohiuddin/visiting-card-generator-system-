/* Payment capture, and the one rule the whole product is built on.
 *
 * PRD Epic F: charge only at proof approval, never before. That is not a
 * checkout preference, it is the strongest trust mechanism CARDWORKS has —
 * the customer holds a printed card on the exact stock before any money
 * moves — and it is encoded here as a precondition rather than a convention.
 * A capture is attempted against exactly one order status, `awaiting_approval`,
 * and it is what unlocks exactly one transition, to `printing`. Every other
 * status is refused with a code the UI can render, including the ones earlier
 * in the flow, which is how the state machine is prevented from skipping
 * approval by a caller that simply asks it to.
 *
 * Four properties this file exists to keep, in the order they cost money if
 * they break:
 *
 * A retried capture is not a second charge. The caller's idempotency key
 * becomes the payment's capture_key, unique per order, and the database also
 * holds a partial unique index that allows at most one captured payment per
 * order regardless of key. The first defence covers retries; the second covers
 * two different keys racing, which the first cannot.
 *
 * A charge that exists at the provider always has a local trace. The intent
 * row is opened before the provider is called, never after, so the worst case
 * is a local row with no upstream charge — recoverable — rather than an
 * upstream charge nobody here knows about.
 *
 * A mismatch is never silent. Provider says paid and we could not record it,
 * or we recorded it and the provider says otherwise: both open an incident row
 * (PRD §12) and the first also issues an automatic refund. Nothing is allowed
 * to end in a shrug.
 *
 * The amount is never the client's. It comes from lib/payments/quote.mjs,
 * which prefers A4's server-side quote engine and falls back to the order's
 * own stored total. A claimed amount in the request is compared, logged, and
 * discarded.
 */
import * as bkash from './bkash.mjs';
import * as nagad from './nagad.mjs';
import * as cod from './cod.mjs';
import { PaymentError } from './provider.mjs';
import { StoreConflict } from './store.mjs';
import { amountFor, claimDiffers, QuoteError } from './quote.mjs';

export { PaymentError } from './provider.mjs';
export { StoreConflict, createStore, createMemoryStore } from './store.mjs';
export { amountFor, QuoteError } from './quote.mjs';

/* bKash and Nagad are the market; cash on delivery is how a large share of it
   actually pays. Card rails — SSLCommerz, aamarPay, ShurjoPay — are deferred
   until volume justifies the integration cost (PRD Epic F). The seam for them
   is this object and the provider contract in provider.mjs: a card gateway is
   another `kind: 'redirect'` module with the same four methods, and nothing in
   this file would need to change to admit one. */
export const PROVIDERS = { bkash, nagad, cod };

export const ORDER_FLOW = [
  'files_locked', 'at_press', 'proof_printed', 'proof_delivered',
  'awaiting_approval', 'printing', 'delivered'
];

/** The only status a charge may be attempted from, and the only one it opens. */
export const CHARGE_AT = 'awaiting_approval';
export const CHARGE_TO = 'printing';

export function getProvider(id) {
  const p = PROVIDERS[String(id || '').toLowerCase()];
  if (!p) throw new PaymentError('unknown_provider',
    'That payment method is not offered.', { offered: Object.keys(PROVIDERS) });
  return p;
}

/** What the order screen should show as available, and whether each is live. */
export const paymentMethods = () => Object.values(PROVIDERS).map((p) => ({
  id: p.id, label: p.label, kind: p.kind, simulated: p.simulated()
}));

/* The precondition, as a value rather than a thrown error, so the order screen
   can grey a button out for the same reason the endpoint would refuse it. */
export function chargeability(orderStatus) {
  if (orderStatus === CHARGE_AT) return { ok: true };
  if (orderStatus === 'cancelled')
    return { ok: false, code: 'order_cancelled', message: 'This order was cancelled.' };
  if (orderStatus === CHARGE_TO || orderStatus === 'delivered')
    return { ok: false, code: 'already_started',
             message: 'This run has already started; it cannot be paid for again.' };
  const i = ORDER_FLOW.indexOf(orderStatus);
  if (i >= 0 && i < ORDER_FLOW.indexOf(CHARGE_AT))
    return { ok: false, code: 'payment_too_early',
             message: 'Nothing is charged until you have held the printed proof and approved it.' };
  return { ok: false, code: 'order_not_payable', message: 'This order cannot be paid for.' };
}

export function assertChargeable(orderStatus) {
  const c = chargeability(orderStatus);
  if (!c.ok) throw new PaymentError(c.code, c.message, { orderStatus });
  return true;
}

/* Without a caller-supplied key, every unkeyed attempt on an order collapses
   onto one key, which is the safe default: a client that forgot the header
   gets idempotency it did not ask for rather than a second charge. An honest
   retry after a *failed* attempt still needs a fresh slot, so the failed key
   is suffixed rather than reused — and the partial unique index means even a
   mistake here cannot produce a second capture. */
const baseKey = (idemKey, orderRef, providerId) =>
  String(idemKey || `auto:${orderRef}:${providerId}`).slice(0, 128);

const log = (store, orderRef, paymentId, type, detail, actor = 'system') =>
  store.addEvent({ paymentId, orderRef, type, actor, detail });

/* Where the customer lands after paying.
 *
 * This is deliberately not the caller's choice to make freely. The callback is
 * the URL bKash and Nagad send a paying customer to, so a value that reaches
 * here off a request body is a redirect a stranger picked for someone who has
 * just typed a PIN — the exact shape of a payment phishing hop, and it looks
 * like a successful payment to everyone involved. `orders.mjs` currently
 * forwards `b.callbackURL` straight from the body, so the check belongs here,
 * in the module that owns the money, rather than in each caller that might
 * remember it.
 *
 * A requested URL is honoured only when it is on our own origin, which still
 * allows the order screen to choose where in the app to return to. Anything
 * else is replaced with the canonical callback and recorded. */
function resolveCallback(orderRef, provider, requested) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const canonical = base
    ? `${base}/api/payments?callback=${encodeURIComponent(provider.id)}&ref=${encodeURIComponent(orderRef)}`
    : null;
  if (!requested) return { url: canonical, rejected: null };
  if (!base) return { url: canonical, rejected: 'no_public_base_url' };
  try {
    const u = new URL(requested, base);
    if (u.origin === new URL(base).origin) return { url: u.toString(), rejected: null };
    return { url: canonical, rejected: 'foreign_origin' };
  } catch {
    return { url: canonical, rejected: 'unparseable' };
  }
}

/**
 * Raise a payment at the moment of approval.
 *
 * For a redirect provider this creates the payment upstream and hands back the
 * URL the customer is sent to; the order stays at `awaiting_approval` because
 * no money has moved yet. For cash on delivery there is nothing to redirect
 * to, the intent is the customer's commitment to pay the courier, and the run
 * starts immediately — which is still proof-before-charge, because the cash
 * arrives after the cards do.
 */
export async function beginApprovalPayment(store, opts) {
  const {
    orderRef, provider: providerId, actor = 'customer', idemKey = null,
    payerReference = null, callbackURL = null, claimedAmount = undefined,
    clientIp = null, sql = null
  } = opts;

  const order = await store.getOrder(orderRef);
  if (!order) throw new PaymentError('order_not_found', 'That order does not exist.', { orderRef });

  /* Already paid is not an error. A customer who taps approve twice, or whose
     callback arrives twice, should see the payment they already have. */
  const already = await store.capturedPayment(orderRef);
  if (already) return { payment: already, redirectURL: null, orderStatus: order.status, replayed: true };

  assertChargeable(order.status);

  const provider = getProvider(providerId);
  const quote = await amountFor(store, orderRef, sql);

  /* The client's number is evidence, not instruction. Recording the divergence
     is worth more than rejecting it: a UI that has drifted out of date looks
     identical to an attempt to underpay until you can see how often it
     happens and to whom. */
  if (claimedAmount !== undefined && claimDiffers(claimedAmount, quote.amount))
    await log(store, orderRef, null, 'amount.claim_ignored',
      { claimed: Math.round(Number(claimedAmount)), charged: quote.amount, source: quote.source }, actor);

  const { payment, replayedIntent } =
    await openIntentSlot(store, { orderRef, provider, quote, idemKey, actor });
  if (replayedIntent) {
    const prior = await lastRedirect(store, orderRef, payment.id);
    return { payment, redirectURL: prior, orderStatus: order.status, replayed: true };
  }

  const callback = resolveCallback(orderRef, provider, callbackURL);
  if (callback.rejected)
    await log(store, orderRef, payment.id, 'callback.replaced',
      { requested: String(callbackURL).slice(0, 200), reason: callback.rejected }, actor);
  if (provider.kind === 'redirect' && !callback.url && !provider.simulated()) {
    await store.markFailed(payment.id, 'callback_unconfigured');
    throw new PaymentError('callback_unconfigured',
      'This deploy has no PUBLIC_BASE_URL, so there is nowhere safe to return the customer to after paying.',
      { orderRef });
  }

  let created;
  try {
    created = await provider.createIntent({
      orderRef, amount: quote.amount, currency: quote.currency,
      payerReference: payerReference || orderRef, callbackURL: callback.url, clientIp
    });
  } catch (err) {
    await store.markFailed(payment.id, err.code || 'intent_failed');
    await log(store, orderRef, payment.id, 'intent.failed',
      { provider: provider.id, code: err.code || 'intent_failed', message: err.message });
    throw err instanceof PaymentError ? err
      : new PaymentError('intent_failed', 'The payment could not be started.', {});
  }

  const withRef = await store.attachProviderRef(payment.id, created.providerRef);
  const row = withRef || payment;
  /* `unvalidatedCosts` is A4's flag for a price built on the cost constants
     PRD §8.1 says nobody has checked against a real press quote yet. It is
     carried into the ledger rather than dropped, so a charge made against an
     unvalidated number is identifiable afterwards instead of looking exactly
     like a charge made against a real one. */
  await log(store, orderRef, row.id, 'intent.opened', {
    provider: provider.id, providerRef: created.providerRef, amount: quote.amount,
    quoteSource: quote.source, unvalidatedCosts: !!quote.unvalidatedCosts,
    proofRequired: !!quote.proofRequired,
    simulated: provider.simulated(), redirectURL: created.redirectURL || null
  }, actor);

  /* An offline method has no second leg to wait for, so approval starts the
     run here. A redirect method must not: the order stays put until the
     provider has actually confirmed the debit in completePayment. */
  if (provider.kind === 'offline') {
    const moved = await store.advanceOrder(orderRef, CHARGE_AT, CHARGE_TO);
    if (!moved) {
      await store.markCancelled(row.id);
      throw new PaymentError('order_moved',
        'This order changed while the payment was being raised. Try again.', { orderRef });
    }
    await store.addOrderEvent(orderRef, 'approve', actor,
      `${provider.label} — collected on delivery`);
    await log(store, orderRef, row.id, 'order.advanced', { from: CHARGE_AT, to: CHARGE_TO }, actor);
    return { payment: row, redirectURL: null, orderStatus: CHARGE_TO, replayed: false };
  }

  return { payment: row, redirectURL: created.redirectURL, orderStatus: order.status, replayed: false };
}

/* Opening the local row before the provider is called is deliberate: the only
   tolerable failure is a local intent with no upstream charge. On a duplicate
   key the existing row is the answer — captured means replay, an open intent
   means the customer is mid-flow, and a dead one means the key is spent and
   the next honest attempt needs its own slot. */
async function openIntentSlot(store, { orderRef, provider, quote, idemKey, actor }) {
  const root = baseKey(idemKey, orderRef, provider.id);
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = attempt === 0 ? root : `${root}#${attempt + 1}`;
    try {
      const payment = await store.openIntent({
        orderRef, provider: provider.id, providerRef: null,
        amount: quote.amount, currency: quote.currency,
        captureKey: key, simulated: provider.simulated()
      });
      return { payment, replayedIntent: false };
    } catch (err) {
      if (!(err instanceof StoreConflict) || err.code !== 'duplicate_capture_key') throw err;
      const existing = await store.paymentByKey(orderRef, key);
      if (!existing) continue;
      if (existing.status === 'intent' || existing.status === 'captured'
          || existing.status === 'partially_refunded' || existing.status === 'refunded')
        return { payment: existing, replayedIntent: true };
      /* failed or cancelled — that attempt is over, take the next slot */
    }
  }
  throw new PaymentError('too_many_attempts',
    'This order has too many failed payment attempts. Someone needs to look at it.', { orderRef });
}

const lastRedirect = async (store, orderRef, paymentId) => {
  const events = await store.eventsFor(orderRef);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'intent.opened' && e.payment_id === paymentId && e.detail && e.detail.redirectURL)
      return e.detail.redirectURL;
  }
  return null;
};

/**
 * Complete a redirect payment: the customer has come back from bKash or Nagad
 * and we now ask the provider — not the browser — what actually happened.
 *
 * This is the only place an order reaches `printing` through a card rail, and
 * it re-checks the approval precondition rather than trusting that it held
 * when the intent was raised, because minutes of customer time pass in between
 * and the order may have been cancelled in them.
 */
export async function completePayment(store, opts) {
  const {
    orderRef: refIn = null, provider: providerId = null, providerRef = null,
    captureKey = null, actor = 'customer', sql = null
  } = opts;

  let payment = null;
  if (providerId && providerRef) payment = await store.paymentByProviderRef(providerId, providerRef);
  if (!payment && refIn && captureKey) payment = await store.paymentByKey(refIn, captureKey);
  if (!payment && refIn) {
    const rows = await store.paymentsFor(refIn);
    payment = [...rows].reverse().find((p) => p.status === 'intent')
           || [...rows].reverse().find((p) => p.status === 'captured') || null;
  }
  if (!payment) throw new PaymentError('payment_not_found',
    'There is no payment in flight for that order.', { orderRef: refIn });

  const orderRef = payment.order_ref;

  if (payment.status === 'captured' || payment.status === 'partially_refunded' || payment.status === 'refunded')
    return { payment, orderStatus: (await store.getOrder(orderRef)).status, replayed: true };
  if (payment.status !== 'intent')
    throw new PaymentError('not_capturable',
      'That payment attempt is closed. Start a new one.', { status: payment.status });

  const order = await store.getOrder(orderRef);
  if (!order) throw new PaymentError('order_not_found', 'That order does not exist.', { orderRef });

  /* The precondition again, on the way in this time. An order that was
     cancelled while the customer was on the provider's page must not be
     capturable, and neither must one that somehow moved backwards. */
  const chargeable = chargeability(order.status);
  if (!chargeable.ok) {
    await store.markCancelled(payment.id);
    await log(store, orderRef, payment.id, 'capture.refused',
      { reason: chargeable.code, orderStatus: order.status }, actor);
    throw new PaymentError(chargeable.code, chargeable.message, { orderStatus: order.status });
  }

  /* Charge what the order is worth now, and refuse if that is not what the
     intent was raised for. A price that moved underneath an in-flight payment
     is a reconciliation question for a human, not something to resolve by
     charging one of the two numbers and hoping. */
  const quote = await amountFor(store, orderRef, sql);
  if (quote.amount !== payment.amount) {
    await store.markFailed(payment.id, 'amount_drift');
    const incident = await store.openIncident({
      orderRef, paymentId: payment.id, kind: 'amount_drift', severity: 'warning',
      detail: { intentAmount: payment.amount, quotedAmount: quote.amount, source: quote.source }
    });
    throw new PaymentError('amount_drift',
      'The price of this order changed while the payment was in progress. Start again.',
      { incident: incident.ref });
  }

  const provider = getProvider(payment.provider);

  let result;
  try {
    result = await provider.capture({
      orderRef, providerRef: payment.provider_ref, amount: payment.amount,
      currency: payment.currency, actor
    });
  } catch (err) {
    return await handleCaptureRefusal(store, { payment, provider, order, err, actor });
  }

  let captured;
  try {
    captured = await store.markCaptured(payment.id, result.providerTxn);
  } catch (err) {
    /* Money moved and we could not write it down. This is the case PRD §12
       names specifically, and the only correct answer is to give it back and
       leave a record somebody has to close. */
    return await reconcileUnrecorded(store, { payment, provider, result, err, actor });
  }

  await log(store, orderRef, captured.id, 'capture.succeeded', {
    provider: provider.id, providerRef: payment.provider_ref, providerTxn: result.providerTxn,
    amount: captured.amount, simulated: provider.simulated()
  }, actor);

  /* A provider that reports a different figure than we asked for does not
     invalidate the capture — the customer paid something and holding their
     order hostage over it helps nobody — but it is a discrepancy, so it gets
     an incident at warning rather than being averaged away. */
  if (result.amount !== undefined && result.amount !== null && Number(result.amount) !== captured.amount)
    await store.openIncident({
      orderRef, paymentId: captured.id, kind: 'amount_mismatch', severity: 'warning',
      detail: { charged: captured.amount, providerReported: Number(result.amount) }
    });

  const moved = await store.advanceOrder(orderRef, CHARGE_AT, CHARGE_TO);
  if (!moved) {
    /* Paid, but the order did not move. Refunding here would be the worse
       outcome — the customer has approved and paid, and the run should start.
       So the incident stays open and a human advances it. */
    const incident = await store.openIncident({
      orderRef, paymentId: captured.id, kind: 'captured_but_order_stuck', severity: 'critical',
      detail: { expected: CHARGE_AT, providerTxn: result.providerTxn }
    });
    return { payment: captured, orderStatus: (await store.getOrder(orderRef)).status,
             incident: incident.ref, replayed: false };
  }

  await store.addOrderEvent(orderRef, 'approve', actor,
    `Paid by ${provider.label} — the run starts now`);
  await log(store, orderRef, captured.id, 'order.advanced', { from: CHARGE_AT, to: CHARGE_TO }, actor);
  return { payment: captured, orderStatus: CHARGE_TO, replayed: false };
}

/* The provider said no — or said nothing we could parse. Before believing it,
   ask again: a timeout on execute is indistinguishable from a decline from
   here, and the difference is whether the customer has been debited. */
async function handleCaptureRefusal(store, { payment, provider, order, err, actor }) {
  const orderRef = payment.order_ref;
  let upstream = null;
  try {
    upstream = await provider.query({ providerRef: payment.provider_ref });
  } catch { /* the second call failing too is itself the answer: assume nothing */ }

  if (upstream && upstream.status === 'captured') {
    const result = { providerTxn: upstream.providerTxn, amount: upstream.amount };
    return await reconcileUnrecorded(store, {
      payment, provider, result, err,
      note: 'the capture call failed but the provider reports the payment as taken', actor
    });
  }

  await store.markFailed(payment.id, err.code || 'capture_failed');
  await log(store, orderRef, payment.id, 'capture.failed', {
    provider: provider.id, code: err.code || 'capture_failed', message: err.message,
    upstreamStatus: upstream ? upstream.status : 'unknown'
  }, actor);

  /* Nothing half-committed: the order never left `awaiting_approval`, the
     payment row is terminal, and the customer can try again. */
  if (!upstream)
    await store.openIncident({
      orderRef, paymentId: payment.id, kind: 'capture_status_unknown', severity: 'warning',
      detail: { provider: provider.id, code: err.code || 'capture_failed' }
    });

  throw err instanceof PaymentError ? err
    : new PaymentError('capture_failed', 'The payment did not go through.', {});
}

/* Charged upstream, not recorded here. Open the incident first so the record
   of the mismatch survives even if the refund itself fails, then give the
   money back. */
async function reconcileUnrecorded(store, { payment, provider, result, err, note, actor }) {
  const orderRef = payment.order_ref;
  const incident = await store.openIncident({
    orderRef, paymentId: payment.id, kind: 'provider_captured_not_recorded', severity: 'critical',
    detail: {
      provider: provider.id, providerRef: payment.provider_ref,
      providerTxn: result && result.providerTxn, amount: payment.amount,
      storeError: err && (err.code || err.message), note: note || null
    }
  });
  await log(store, orderRef, payment.id, 'capture.unrecorded', {
    provider: provider.id, incident: incident.ref, providerTxn: result && result.providerTxn
  }, actor);
  await store.markFailed(payment.id, 'unrecorded_capture');

  const refund = await issueRefund(store, {
    payment, provider, amount: payment.amount,
    reason: `auto: ${incident.ref} ${incident.kind}`,
    refundKey: `incident:${incident.ref}`,
    providerTxn: result && result.providerTxn
  });

  if (refund.status === 'refunded')
    await store.resolveIncident(incident.id, orderRef,
      { refund: refund.ref, note: 'automatically refunded' });

  throw new PaymentError('payment_reconciliation',
    refund.status === 'refunded'
      ? 'Your payment went through but could not be attached to this order, so it has been refunded. Nothing was charged.'
      : 'Your payment went through but could not be attached to this order. We have opened a case and will refund it.',
    { incident: incident.ref, refund: refund.ref, refundStatus: refund.status });
}

/* One refund path, used by reconciliation and by a human-initiated refund
   alike, so the idempotency and the ledger writes cannot diverge between the
   automatic case and the manual one. */
async function issueRefund(store, { payment, provider, amount, reason, refundKey, providerTxn }) {
  const { refund, fresh } = await store.openRefund({
    paymentId: payment.id, orderRef: payment.order_ref, provider: provider.id,
    amount, reason, refundKey
  });
  if (!fresh && refund.status !== 'pending') return refund;

  try {
    const res = await provider.refund({
      providerRef: payment.provider_ref, providerTxn: providerTxn || payment.provider_txn,
      amount, currency: payment.currency, reason
    });
    await store.settleRefund(refund.id, payment.id, amount, res.providerRef, 'refunded');
    await log(store, payment.order_ref, payment.id, 'refund.succeeded',
      { refund: refund.ref, amount, providerRef: res.providerRef, manual: !!res.manual });
    return { ...refund, status: 'refunded', provider_ref: res.providerRef };
  } catch (e) {
    await store.settleRefund(refund.id, payment.id, amount, null, 'failed');
    await store.openIncident({
      orderRef: payment.order_ref, paymentId: payment.id, kind: 'refund_failed', severity: 'critical',
      detail: { refund: refund.ref, amount, code: e.code || 'refund_failed', message: e.message }
    });
    await log(store, payment.order_ref, payment.id, 'refund.failed',
      { refund: refund.ref, amount, code: e.code || 'refund_failed' });
    return { ...refund, status: 'failed' };
  }
}

/**
 * Settle a cash-on-delivery payment at handover. The courier or the shop says
 * the notes changed hands; the customer cannot say it about themselves, which
 * is enforced in cod.mjs rather than here so the rule travels with the method.
 */
export async function settleCashOnDelivery(store, { orderRef, actor = 'courier', idemKey = null }) {
  const rows = await store.paymentsFor(orderRef);
  const captured = rows.find((p) => p.provider === 'cod'
    && ['captured', 'partially_refunded', 'refunded'].includes(p.status));
  if (captured) return { payment: captured, replayed: true };

  const open = [...rows].reverse().find((p) => p.provider === 'cod' && p.status === 'intent');
  if (!open) throw new PaymentError('no_cash_intent',
    'This order has no cash-on-delivery payment to settle.', { orderRef });

  const provider = getProvider('cod');
  const result = await provider.capture({ orderRef, amount: open.amount, actor });
  let settled;
  try {
    settled = await store.markCaptured(open.id, result.providerTxn);
  } catch (err) {
    const incident = await store.openIncident({
      orderRef, paymentId: open.id, kind: 'cash_settlement_conflict', severity: 'critical',
      detail: { storeError: err.code || err.message, idemKey: idemKey ? 'present' : 'absent' }
    });
    throw new PaymentError('cash_settlement_conflict',
      'This order already holds a settled payment.', { incident: incident.ref });
  }
  await log(store, orderRef, settled.id, 'capture.succeeded',
    { provider: 'cod', amount: settled.amount, providerTxn: result.providerTxn }, actor);
  return { payment: settled, replayed: false };
}

/**
 * Refund a captured payment. Idempotent on `idemKey`, and refuses to invent an
 * amount larger than what is left unrefunded.
 */
export async function refundOrder(store, { orderRef, amount = null, reason = 'requested', actor = 'staff', idemKey = null }) {
  const payment = await store.capturedPayment(orderRef);
  if (!payment) throw new PaymentError('nothing_to_refund',
    'This order has no captured payment.', { orderRef });

  const remaining = payment.amount - payment.refunded;
  const want = amount === null ? remaining : Math.round(Number(amount));
  if (!Number.isFinite(want) || want <= 0)
    throw new PaymentError('bad_refund_amount', 'A refund has to be a positive amount.', {});
  if (want > remaining)
    throw new PaymentError('bad_refund_amount',
      'That is more than is left to refund on this payment.', { remaining });

  const provider = getProvider(payment.provider);
  const refund = await issueRefund(store, {
    payment, provider, amount: want, reason: String(reason).slice(0, 255),
    refundKey: String(idemKey || `manual:${orderRef}:${want}:${reason}`).slice(0, 128)
  });
  await store.addOrderEvent(orderRef, 'refund', actor, `${provider.label} — ৳${want}`);
  return { refund, payment: await store.capturedPayment(orderRef) };
}

/** Everything the order screen needs to render the money side of one order. */
export async function paymentState(store, orderRef) {
  const order = await store.getOrder(orderRef);
  if (!order) throw new PaymentError('order_not_found', 'That order does not exist.', { orderRef });
  const payments = await store.paymentsFor(orderRef);
  const captured = payments.find((p) =>
    ['captured', 'partially_refunded', 'refunded'].includes(p.status)) || null;
  const incidents = (await store.incidentsFor(orderRef)).filter((i) => i.severity !== 'resolved');
  return {
    orderRef, orderStatus: order.status,
    chargeable: chargeability(order.status),
    paid: !!captured,
    payment: captured && {
      ref: captured.ref, provider: captured.provider, status: captured.status,
      amount: captured.amount, currency: captured.currency, refunded: captured.refunded,
      simulated: captured.simulated
    },
    attempts: payments.length,
    methods: paymentMethods(),
    openIncidents: incidents.map((i) => ({ ref: i.ref, kind: i.kind, severity: i.severity }))
  };
}
