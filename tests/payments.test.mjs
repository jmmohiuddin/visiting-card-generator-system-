/* Headless verification of payment capture.
   Drives lib/payments against the in-memory store, which carries the same two
   unique constraints as db/migrations/003_payments.sql, so the properties
   asserted here are the ones production actually enforces. No network: every
   provider runs its simulated transport because no credentials are set.

   Run: node tests/payments.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROVIDERS, ORDER_FLOW, CHARGE_AT, CHARGE_TO, getProvider, paymentMethods,
  chargeability, assertChargeable, beginApprovalPayment, completePayment,
  settleCashOnDelivery, refundOrder, paymentState, createMemoryStore,
  amountFor, PaymentError, StoreConflict
} from '../lib/payments/index.mjs';
import { simulationGuard } from '../lib/payments/provider.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let pass = 0, fail = 0;
const ok  = (name, cond, extra='') => { cond ? (pass++, console.log('  ✓ ' + name))
                                             : (fail++, console.log('  ✗ ' + name + (extra?' — '+extra:''))); };
const H = s => console.log('\n' + s);

/* Every assertion below runs without credentials, so the guard in
   provider.mjs must see a non-production environment or it refuses. That is
   the intended behaviour, not a workaround — see the production test below. */
delete process.env.NODE_ENV;
for (const k of Object.keys(process.env)) if (/^(BKASH|NAGAD)_/.test(k)) delete process.env[k];

const TOTAL = 1300;
const seed = (overrides = []) => createMemoryStore([
  { ref: 'ORD-02201', status: CHARGE_AT,          total: TOTAL, currency: 'BDT' },
  { ref: 'ORD-02202', status: 'proof_delivered',  total: TOTAL, currency: 'BDT' },
  { ref: 'ORD-02203', status: 'files_locked',     total: TOTAL, currency: 'BDT' },
  { ref: 'ORD-02204', status: CHARGE_TO,          total: TOTAL, currency: 'BDT' },
  { ref: 'ORD-02205', status: 'cancelled',        total: TOTAL, currency: 'BDT' },
  { ref: 'ORD-02206', status: 'delivered',        total: TOTAL, currency: 'BDT' },
  { ref: 'ORD-DECLINE', status: CHARGE_AT,        total: TOTAL, currency: 'BDT' },
  ...overrides
]);

const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const code  = async (fn) => { const e = await threw(fn); return e && e.code; };

/* ─────────────────────────────────────────────────────────────────────── */
H('1. Providers offered');

ok('bKash, Nagad and cash on delivery are the three methods',
   Object.keys(PROVIDERS).sort().join(',') === 'bkash,cod,nagad',
   Object.keys(PROVIDERS).join(','));
ok('no card rail is registered — SSLCommerz and friends stay a documented seam',
   !Object.keys(PROVIDERS).some(k => /sslcommerz|aamarpay|shurjopay|card/i.test(k)));
ok('every provider implements the whole contract',
   Object.values(PROVIDERS).every(p =>
     p.id && p.label && (p.kind === 'redirect' || p.kind === 'offline') &&
     ['createIntent','capture','query','refund','configured','simulated']
       .every(m => typeof p[m] === 'function')));
ok('cash on delivery is offline; both mobile rails are redirect flows',
   PROVIDERS.cod.kind === 'offline' && PROVIDERS.bkash.kind === 'redirect' && PROVIDERS.nagad.kind === 'redirect');
ok('bKash and Nagad report themselves simulated when no credentials are set',
   PROVIDERS.bkash.simulated() && PROVIDERS.nagad.simulated());
ok('cash on delivery is never simulated — it has no transport to fake',
   PROVIDERS.cod.simulated() === false);
ok('an unknown provider is refused, not defaulted',
   (() => { try { getProvider('sslcommerz'); return false; } catch (e) { return e.code === 'unknown_provider'; } })());
ok('paymentMethods() tells the UI which rails are live',
   paymentMethods().length === 3 && paymentMethods().every(m => 'simulated' in m));

H('2. Simulation refuses to run in production');
process.env.NODE_ENV = 'production';
{
  const e = await threw(async () => simulationGuard('bkash', ['BKASH_APP_KEY']));
  ok('simulationGuard throws provider_unconfigured under NODE_ENV=production',
     e && e.code === 'provider_unconfigured', e && e.code);
  const store = seed();
  const e2 = await threw(() => beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash' }));
  ok('a production deploy with no bKash credentials cannot raise a payment',
     e2 && e2.code === 'provider_unconfigured', e2 && e2.code);
  ok('and it left no captured payment behind',
     (await store.capturedPayment('ORD-02201')) === null);
}
delete process.env.NODE_ENV;

/* ─────────────────────────────────────────────────────────────────────── */
H('3. Charge only at proof approval (PRD Epic F)');

ok('the charge point is awaiting_approval and it unlocks printing',
   CHARGE_AT === 'awaiting_approval' && CHARGE_TO === 'printing');
ok('the flow the order state machine models is unchanged',
   ORDER_FLOW.join('→') === 'files_locked→at_press→proof_printed→proof_delivered→awaiting_approval→printing→delivered');

for (const s of ['files_locked','at_press','proof_printed','proof_delivered']) {
  const c = chargeability(s);
  ok(`capture is refused at ${s}`, !c.ok && c.code === 'payment_too_early', c.code);
}
ok('capture is refused once the run has started', chargeability(CHARGE_TO).code === 'already_started');
ok('capture is refused after delivery',          chargeability('delivered').code === 'already_started');
ok('capture is refused on a cancelled order',    chargeability('cancelled').code === 'order_cancelled');
ok('capture is allowed at awaiting_approval and nowhere else',
   ORDER_FLOW.filter(s => chargeability(s).ok).join(',') === CHARGE_AT);
ok('assertChargeable throws with the same code chargeability reports',
   (() => { try { assertChargeable('files_locked'); return false; }
            catch (e) { return e instanceof PaymentError && e.code === 'payment_too_early'; } })());

{
  const store = seed();
  ok('beginApprovalPayment refuses an order that has not reached approval',
     (await code(() => beginApprovalPayment(store, { orderRef: 'ORD-02202', provider: 'bkash' }))) === 'payment_too_early');
  ok('beginApprovalPayment refuses an order still at files_locked',
     (await code(() => beginApprovalPayment(store, { orderRef: 'ORD-02203', provider: 'bkash' }))) === 'payment_too_early');
  ok('beginApprovalPayment refuses an order already printing',
     (await code(() => beginApprovalPayment(store, { orderRef: 'ORD-02204', provider: 'bkash' }))) === 'already_started');
  ok('beginApprovalPayment refuses a cancelled order',
     (await code(() => beginApprovalPayment(store, { orderRef: 'ORD-02205', provider: 'bkash' }))) === 'order_cancelled');
  ok('beginApprovalPayment refuses a delivered order',
     (await code(() => beginApprovalPayment(store, { orderRef: 'ORD-02206', provider: 'bkash' }))) === 'already_started');
  ok('none of those refusals wrote a payment row',
     store._payments.length === 0, String(store._payments.length));
  ok('and none of them moved an order',
     [...store._orders.values()].map(o => o.status).join(',') ===
     [CHARGE_AT,'proof_delivered','files_locked',CHARGE_TO,'cancelled','delivered',CHARGE_AT].join(','));
}

H('4. The state machine cannot skip approval');
{
  /* An order at proof_delivered with a payment forced into flight: even with
     an intent in hand, completing it must not start the run. */
  const store = seed();
  const forced = await store.openIntent({
    orderRef: 'ORD-02202', provider: 'bkash', providerRef: 'SIM-BKASH-ORD-02202-1300',
    amount: TOTAL, currency: 'BDT', captureKey: 'forced', simulated: true
  });
  const e = await threw(() => completePayment(store, { orderRef: 'ORD-02202' }));
  ok('completePayment on a pre-approval order is refused',
     e && e.code === 'payment_too_early', e && e.code);
  ok('the order stayed at proof_delivered',
     (await store.getOrder('ORD-02202')).status === 'proof_delivered');
  ok('the forced intent was cancelled rather than left open',
     (await store.paymentsFor('ORD-02202'))[0].status === 'cancelled');
  ok('no capture was recorded', (await store.capturedPayment('ORD-02202')) === null);
  ok('the refusal is in the ledger',
     (await store.eventsFor('ORD-02202')).some(e2 => e2.type === 'capture.refused'));
  ok('the intent row exists so nothing is invisible', forced.ref.startsWith('PAY-'));
}

/* ─────────────────────────────────────────────────────────────────────── */
H('5. A redirect rail does not move the order until money moves');
{
  const store = seed();
  const begun = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'k1' });
  ok('begin returns a redirect URL for bKash', typeof begun.redirectURL === 'string' && begun.redirectURL.length > 0);
  ok('begin leaves the order at awaiting_approval — nothing is charged yet',
     begun.orderStatus === CHARGE_AT && (await store.getOrder('ORD-02201')).status === CHARGE_AT);
  ok('the payment is an open intent, not a capture', begun.payment.status === 'intent');
  ok('the payment reference came from a sequence, not a row count',
     /^PAY-\d{6}$/.test(begun.payment.ref), begun.payment.ref);
  ok('the intent is marked simulated so it can never be mistaken for real money',
     begun.payment.simulated === true && String(begun.payment.provider_ref).startsWith('SIM-'));

  const done = await completePayment(store, { orderRef: 'ORD-02201' });
  ok('completing the payment captures it', done.payment.status === 'captured');
  ok('and only then does the order reach printing',
     done.orderStatus === CHARGE_TO && (await store.getOrder('ORD-02201')).status === CHARGE_TO);
  ok('the order event log records the approval',
     store._events.some(e => e.kind === 'order' && e.type === 'approve'));
  ok('the payment ledger records the capture',
     (await store.eventsFor('ORD-02201')).some(e => e.type === 'capture.succeeded'));
  ok('exactly one payment row exists for the order', (await store.paymentsFor('ORD-02201')).length === 1);
  ok('no incident was opened on the happy path', (await store.incidentsFor('ORD-02201')).length === 0);
}

H('6. Nagad follows the same shape');
{
  const store = seed();
  const begun = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'nagad', idemKey: 'n1' });
  ok('Nagad returns a redirect URL and leaves the order alone',
     !!begun.redirectURL && begun.orderStatus === CHARGE_AT);
  const done = await completePayment(store, { orderRef: 'ORD-02201' });
  ok('Nagad capture advances the order to printing',
     done.payment.status === 'captured' && done.orderStatus === CHARGE_TO);
  ok('the captured amount is the server total', done.payment.amount === TOTAL, String(done.payment.amount));
}

/* ─────────────────────────────────────────────────────────────────────── */
H('7. A retried capture is never a second charge');
{
  const store = seed();
  const a = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'same-key' });
  const b = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'same-key' });
  ok('replaying the idempotency key returns the first payment, not a second',
     b.replayed === true && b.payment.ref === a.payment.ref, `${a.payment.ref} vs ${b.payment.ref}`);
  ok('only one payment row was opened', (await store.paymentsFor('ORD-02201')).length === 1);
  ok('the replay hands back the same redirect URL the customer was given',
     b.redirectURL === a.redirectURL);

  const c1 = await completePayment(store, { orderRef: 'ORD-02201' });
  const c2 = await completePayment(store, { orderRef: 'ORD-02201' });
  ok('completing twice returns the first capture rather than charging again',
     c2.replayed === true && c2.payment.ref === c1.payment.ref);
  ok('still exactly one payment row', (await store.paymentsFor('ORD-02201')).length === 1);
  ok('still exactly one captured payment',
     (await store.paymentsFor('ORD-02201')).filter(p => p.status === 'captured').length === 1);

  const d = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'a-different-key' });
  ok('a fresh key on an already-paid order replays rather than opening a second charge',
     d.replayed === true && d.payment.status === 'captured' && d.payment.ref === c1.payment.ref);
  ok('and it did not add a row', (await store.paymentsFor('ORD-02201')).length === 1);
}

H('8. Without an idempotency key, one order is still one attempt');
{
  const store = seed();
  const a = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash' });
  const b = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash' });
  ok('an unkeyed retry collapses onto the first attempt',
     b.replayed === true && b.payment.ref === a.payment.ref);
  ok('one row, not two', (await store.paymentsFor('ORD-02201')).length === 1);
}

H('9. Two intents racing produce one capture');
{
  const store = seed();
  await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'race-a' });
  const second = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'nagad', idemKey: 'race-b' });
  ok('two different keys can hold two open intents', (await store.paymentsFor('ORD-02201')).length === 2);

  await completePayment(store, { orderRef: 'ORD-02201', provider: 'bkash', providerRef: 'SIM-BKASH-ORD-02201-1300' });
  const e = await threw(() => completePayment(store, {
    orderRef: 'ORD-02201', provider: 'nagad', providerRef: second.payment.provider_ref }));
  ok('the loser is refused because the run has already started',
     e && e.code === 'already_started', e && e.code);
  ok('exactly one capture survives',
     (await store.paymentsFor('ORD-02201')).filter(p => p.status === 'captured').length === 1);
  ok('the losing intent is cancelled, not left dangling',
     (await store.paymentsFor('ORD-02201')).some(p => p.status === 'cancelled'));
}

H('10. A capture that wins upstream but loses the unique index is refunded');
{
  /* The true double-charge race: both intents reach the provider while the
     order still reads awaiting_approval. The partial unique index is the last
     line, and what it produces is an incident plus an automatic refund
     (PRD §12), never a silent second debit. */
  const store = seed();
  await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'r-a' });
  const b = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'nagad', idemKey: 'r-b' });
  await completePayment(store, { orderRef: 'ORD-02201', provider: 'bkash', providerRef: 'SIM-BKASH-ORD-02201-1300' });
  store._orders.get('ORD-02201').status = CHARGE_AT;      // re-open the window the race needs

  const e = await threw(() => completePayment(store, {
    orderRef: 'ORD-02201', provider: 'nagad', providerRef: b.payment.provider_ref }));
  ok('the second capture is reported as a reconciliation, not a success',
     e && e.code === 'payment_reconciliation', e && e.code);
  ok('an incident was opened rather than the mismatch going quiet',
     (await store.incidentsFor('ORD-02201')).some(i => i.kind === 'provider_captured_not_recorded'));
  ok('the incident carries a sequence-derived reference',
     /^INC-\d{6}$/.test((await store.incidentsFor('ORD-02201'))[0].ref));
  ok('the duplicate was automatically refunded',
     store._refunds.length === 1 && store._refunds[0].status === 'refunded',
     JSON.stringify(store._refunds.map(r => r.status)));
  ok('the incident was closed by a resolving row, not by editing it',
     (await store.incidentsFor('ORD-02201')).some(i => i.severity === 'resolved' && i.resolves));
  ok('still exactly one captured payment on the order',
     (await store.paymentsFor('ORD-02201')).filter(p => p.status === 'captured').length === 1);
  ok('the customer was told, in the error, that they were refunded',
     /refund/i.test(e.message) && !!e.detail.incident);
}

/* ─────────────────────────────────────────────────────────────────────── */
H('11. The client never supplies the amount');
{
  const store = seed();
  const begun = await beginApprovalPayment(store, {
    orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'cheap', claimedAmount: 1
  });
  ok('a claimed total of ৳1 charges the server total instead',
     begun.payment.amount === TOTAL, String(begun.payment.amount));
  ok('the attempt to underpay is recorded rather than merely dropped',
     (await store.eventsFor('ORD-02201')).some(e =>
       e.type === 'amount.claim_ignored' && e.detail.claimed === 1 && e.detail.charged === TOTAL));

  const done = await completePayment(store, { orderRef: 'ORD-02201' });
  ok('and the capture is for the server total', done.payment.amount === TOTAL);

  const store2 = seed();
  const inflated = await beginApprovalPayment(store2, {
    orderRef: 'ORD-02201', provider: 'bkash', claimedAmount: 999999
  });
  ok('an inflated claim is ignored the same way', inflated.payment.amount === TOTAL);

  const store3 = seed();
  const junk = await beginApprovalPayment(store3, {
    orderRef: 'ORD-02201', provider: 'bkash', claimedAmount: 'free'
  });
  ok('a non-numeric claim changes nothing', junk.payment.amount === TOTAL);

  const store4 = seed([{ ref: 'ORD-02207', status: CHARGE_AT, total: 0, currency: 'BDT' }]);
  ok('an order with no priced total cannot be charged at all',
     (await code(() => beginApprovalPayment(store4, { orderRef: 'ORD-02207', provider: 'bkash' }))) === 'quote_unavailable');
}

H('12. The amount comes from A4\'s quote engine when there is one');
{
  /* A `sql` that throws is enough: loadPresses falls back to its seed presses
     rather than failing, so the whole pricing path runs with no database. */
  const throwingSql = () => { throw new Error('no database in this test'); };
  const qs = await import('../lib/quote-server.mjs').then(m => m, () => null);
  ok('lib/quote-server.mjs is present and exports amountForOrder',
     !!qs && typeof qs.amountForOrder === 'function');

  if (qs) {
    /* A quote minted at an arbitrary moment has to be chargeable. This first
       showed up looking like a payments bug — every capture came back
       `quote_stale` — and it was a digest that hashed the expiry in
       milliseconds while the id carried only whole seconds, so the rebuild
       agreed roughly once in a thousand. A4 fixed it. The assertion belongs
       here as well as there: this is the seam where that class of failure
       stops a customer paying, and it should not be found by hand twice. */
    let unchargeable = 0;
    for (let i = 0; i < 25; i++) {
      const q = await qs.quoteFor({ sql: throwingSql, qty: 500, finishes: [], zone: 'dhaka' });
      const r = await qs.amountForOrder({ sql: throwingSql, quoteId: q.quoteId,
        press: q.options[0].slug, qty: 500, finishes: [], zone: 'dhaka' });
      if (!r.ok) unchargeable++;
    }
    ok('a quote taken at an arbitrary moment can actually be charged',
       unchargeable === 0, `${unchargeable}/25 came back unchargeable`);

    const quoted = await qs.quoteFor({ sql: throwingSql, qty: 500, finishes: [], zone: 'dhaka' });
    const option = quoted.options[0];

    /* `orders.press` is free text today — the press's display name, not its
       slug — and it is the value this module actually passes. Migration 002
       adds press_id, which nothing writes yet. All three have to price the
       same order identically or a charge breaks the day orders.mjs switches
       column, so all three are asserted rather than just the one the rest of
       this section happens to use. */
    const byKey = {};
    for (const [label, key] of [['slug', option.slug], ['free-text name', option.name], ['press_id', option.pressId]]) {
      const r = await qs.amountForOrder({ sql: throwingSql, quoteId: quoted.quoteId,
        press: key, qty: 500, finishes: [], zone: 'dhaka' });
      byKey[label] = r.ok ? r.amount : r.code;
    }
    ok('a press resolves the same by slug, by free-text name and by press_id',
       byKey['slug'] === option.price && byKey['free-text name'] === option.price &&
       byKey['press_id'] === option.price, JSON.stringify(byKey));

    const store = seed([{
      ref: 'ORD-Q1', status: CHARGE_AT, total: 1, currency: 'BDT',
      /* the free-text name, which is what a real order row carries */
      quote_id: quoted.quoteId, press: option.name, qty: 500, finishes: [], zone: 'dhaka'
    }]);

    const q = await amountFor(store, 'ORD-Q1', throwingSql);
    ok('the quote engine prices the order, not the stored total',
       q.amount === option.price && q.source === 'quote-server', `${q.amount} vs ${option.price}`);
    ok('and the quoted price is not the ৳1 the order row claims',
       q.amount !== 1 && q.amount > 0, String(q.amount));

    const begun = await beginApprovalPayment(store, {
      orderRef: 'ORD-Q1', provider: 'bkash', idemKey: 'q1', claimedAmount: 1, sql: throwingSql
    });
    ok('the charge is the quoted price even when the order row says ৳1',
       begun.payment.amount === option.price, String(begun.payment.amount));
    ok('the ledger records which source priced it',
       (await store.eventsFor('ORD-Q1')).some(e =>
         e.type === 'intent.opened' && e.detail.quoteSource === 'quote-server'));
    ok('and whether the price rests on cost constants nobody has validated (PRD §8.1)',
       (await store.eventsFor('ORD-Q1')).some(e =>
         e.type === 'intent.opened' && typeof e.detail.unvalidatedCosts === 'boolean'));

    /* A refusal from the quote engine has to reach the customer as the quote
       engine's own code and remediation. Falling back to the order's stored
       total on a refusal would reopen the exact hole this file exists to
       close, so each of these asserts that nothing was charged. */
    const bad = seed([{ ref: 'ORD-Q2', status: CHARGE_AT, total: 1300, currency: 'BDT',
                        quote_id: 'not-a-quote', press: option.slug, qty: 500, finishes: [], zone: 'dhaka' }]);
    ok('a quote reference we did not issue is refused, not fallen back from',
       (await code(() => beginApprovalPayment(bad, { orderRef: 'ORD-Q2', provider: 'bkash', sql: throwingSql }))) === 'bad_quote');
    ok('and that refusal charged nothing', (await bad.capturedPayment('ORD-Q2')) === null);

    const stale = seed([{ ref: 'ORD-Q3', status: CHARGE_AT, total: 1300, currency: 'BDT',
                          quote_id: quoted.quoteId, press: option.slug, qty: 900, finishes: [], zone: 'dhaka' }]);
    const staleErr = await threw(() => beginApprovalPayment(stale, { orderRef: 'ORD-Q3', provider: 'bkash', sql: throwingSql }));
    ok('a quote whose inputs no longer match is a repricing, not a charge',
       staleErr && staleErr.code === 'quote_stale', staleErr && staleErr.code);
    ok('the repricing carries the remediation the quote engine wrote',
       !!(staleErr && staleErr.detail && staleErr.detail.remediation));
    ok('and it charged nothing', (await stale.capturedPayment('ORD-Q3')) === null);

    const expired = seed([{ ref: 'ORD-Q4', status: CHARGE_AT, total: 1300, currency: 'BDT',
                            quote_id: 'q1_1000000000_' + 'a'.repeat(32),
                            press: option.slug, qty: 500, finishes: [], zone: 'dhaka' }]);
    ok('an expired quote cannot be charged',
       (await code(() => beginApprovalPayment(expired, { orderRef: 'ORD-Q4', provider: 'bkash', sql: throwingSql }))) === 'quote_expired');
    ok('and it charged nothing', (await expired.capturedPayment('ORD-Q4')) === null);
  }

  /* An order placed before migration 002 has no quote to rebuild, and must
     still be payable — against its own stored total, flagged as such.
     orders.mjs pins the quote with `UPDATE … quote_id` under a `.catch(() =>
     {})`, so on a deploy without 002 the column is simply absent and the row
     comes back without it. That has to degrade, not throw: the order was
     already priced server-side by amountForOrder before it was written, so
     the stored total is still the server's number and charging it is right. */
  const legacy = seed();
  const l = await amountFor(legacy, 'ORD-02201', null);
  ok('an order with no quote_id falls back to its stored total, and says so',
     l.amount === TOTAL && l.source === 'order-total');

  const throwing = () => { throw new Error('no database'); };
  const missingCol = await amountFor(seed(), 'ORD-02201', throwing);
  ok('a row with no quote_id column degrades rather than throwing, even with sql present',
     missingCol.amount === TOTAL && missingCol.source === 'order-total');

  const nulled = seed([{ ref: 'ORD-Q5', status: CHARGE_AT, total: TOTAL, currency: 'BDT', quote_id: null }]);
  ok('an explicitly null quote_id degrades the same way',
     (await amountFor(nulled, 'ORD-Q5', throwing)).source === 'order-total');

  const paid = await beginApprovalPayment(nulled, { orderRef: 'ORD-Q5', provider: 'bkash', sql: throwing });
  ok('and such an order is still fully payable',
     paid.payment.amount === TOTAL && paid.payment.status === 'intent');
}

H('13. The customer is only ever returned to our own origin');
{
  /* The callback is where a paying customer lands after typing a PIN. A value
     that reaches this module off a request body is a redirect a stranger
     chose for them, which is the shape of a payment phishing hop and looks
     like success to everyone involved. orders.mjs forwards b.callbackURL from
     the body, so the refusal has to live here. */
  process.env.PUBLIC_BASE_URL = 'https://cardworks.example';

  const store = seed();
  await beginApprovalPayment(store, {
    orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'cb1',
    callbackURL: 'https://evil.example/collect?ref=ORD-02201'
  });
  const evs = await store.eventsFor('ORD-02201');
  ok('a foreign callback origin is replaced, not honoured',
     evs.some(e => e.type === 'callback.replaced' && e.detail.reason === 'foreign_origin'));
  ok('and the replacement is recorded with what was asked for',
     evs.some(e => e.type === 'callback.replaced' && /evil\.example/.test(e.detail.requested)));

  const ours = seed();
  await beginApprovalPayment(ours, {
    orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'cb2',
    callbackURL: 'https://cardworks.example/?order=ORD-02201&payment=ok'
  });
  ok('a callback on our own origin is honoured, so the app can choose where to land',
     !(await ours.eventsFor('ORD-02201')).some(e => e.type === 'callback.replaced'));

  const rel = seed();
  await beginApprovalPayment(rel, {
    orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'cb3', callbackURL: '/order/ORD-02201'
  });
  ok('a relative path resolves against our own origin rather than being refused',
     !(await rel.eventsFor('ORD-02201')).some(e => e.type === 'callback.replaced'));

  const junk = seed();
  await beginApprovalPayment(junk, {
    orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'cb4', callbackURL: 'javascript:alert(1)'
  });
  ok('a javascript: callback is refused',
     (await junk.eventsFor('ORD-02201')).some(e => e.type === 'callback.replaced'));

  delete process.env.PUBLIC_BASE_URL;
  const noBase = seed();
  await beginApprovalPayment(noBase, {
    orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'cb5',
    callbackURL: 'https://evil.example/collect'
  });
  ok('with no PUBLIC_BASE_URL a requested callback is still refused, never trusted by default',
     (await noBase.eventsFor('ORD-02201')).some(e =>
       e.type === 'callback.replaced' && e.detail.reason === 'no_public_base_url'));
  ok('cash on delivery needs no callback and is unaffected',
     (await beginApprovalPayment(seed(), { orderRef: 'ORD-02201', provider: 'cod' })).redirectURL === null);
}

H('14. A price that moves under an in-flight payment stops it');
{
  const store = seed();
  await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'drift' });
  store._orders.get('ORD-02201').total = 2600;
  const e = await threw(() => completePayment(store, { orderRef: 'ORD-02201' }));
  ok('capture is refused when the quote no longer matches the intent',
     e && e.code === 'amount_drift', e && e.code);
  ok('the order did not move', (await store.getOrder('ORD-02201')).status === CHARGE_AT);
  ok('nothing was captured', (await store.capturedPayment('ORD-02201')) === null);
  ok('the drift is an incident somebody can find',
     (await store.incidentsFor('ORD-02201')).some(i => i.kind === 'amount_drift'));
}

/* ─────────────────────────────────────────────────────────────────────── */
H('15. A provider failure leaves nothing half-committed');
{
  const store = seed();
  const begun = await beginApprovalPayment(store, { orderRef: 'ORD-DECLINE', provider: 'bkash', idemKey: 'dec' });
  ok('the intent opened before the provider was called, so the attempt is traceable',
     begun.payment.status === 'intent');
  const e = await threw(() => completePayment(store, { orderRef: 'ORD-DECLINE' }));
  ok('a declined capture throws the provider code',
     e && e.code === 'bkash_execute_failed', e && e.code);
  ok('the order is still at awaiting_approval', (await store.getOrder('ORD-DECLINE')).status === CHARGE_AT);
  ok('the payment row is terminal, not stuck at intent',
     (await store.paymentsFor('ORD-DECLINE')).every(p => p.status === 'failed'));
  ok('the failure names its cause',
     (await store.paymentsFor('ORD-DECLINE'))[0].failure_code === 'bkash_execute_failed');
  ok('nothing was captured', (await store.capturedPayment('ORD-DECLINE')) === null);
  ok('no refund was issued for money that never moved', store._refunds.length === 0);
  ok('the failure is in the ledger',
     (await store.eventsFor('ORD-DECLINE')).some(ev => ev.type === 'capture.failed'));

  const retry = await beginApprovalPayment(store, { orderRef: 'ORD-DECLINE', provider: 'nagad', idemKey: 'dec' });
  ok('a spent key does not block an honest retry — it takes the next slot',
     retry.replayed === false && retry.payment.capture_key === 'dec#2', retry.payment.capture_key);
  ok('the failed attempt is still on record beside it',
     (await store.paymentsFor('ORD-DECLINE')).length === 2);
}

H('16. A capture the provider took but we could not record is refunded');
{
  const store = seed();
  await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'lost' });
  const realMark = store.markCaptured.bind(store);
  let tripped = false;
  store.markCaptured = async (...a) => {
    if (!tripped) { tripped = true; throw new StoreConflict('write_failed', 'simulated database failure'); }
    return realMark(...a);
  };
  const e = await threw(() => completePayment(store, { orderRef: 'ORD-02201' }));
  store.markCaptured = realMark;

  ok('the customer is told it was reconciled rather than that it worked',
     e && e.code === 'payment_reconciliation', e && e.code);
  ok('an incident records the provider-side charge we could not attach',
     (await store.incidentsFor('ORD-02201')).some(i => i.kind === 'provider_captured_not_recorded'));
  ok('the money was refunded automatically (PRD §12)',
     store._refunds.length === 1 && store._refunds[0].status === 'refunded');
  ok('the refund reference came from a sequence', /^RFD-\d{6}$/.test(store._refunds[0].ref));
  ok('the order never advanced on an unrecorded charge',
     (await store.getOrder('ORD-02201')).status === CHARGE_AT);
  ok('the payment row is marked failed, not captured',
     (await store.paymentsFor('ORD-02201'))[0].status === 'failed');
  ok('the incident was resolved by appending, not by editing',
     (await store.incidentsFor('ORD-02201')).some(i => i.resolves));
}

/* ─────────────────────────────────────────────────────────────────────── */
H('17. Cash on delivery is a first-class method');
{
  const store = seed();
  const begun = await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'cod', idemKey: 'cod1' });
  ok('there is no redirect for cash', begun.redirectURL === null);
  ok('approval starts the run immediately — the cash arrives after the cards do',
     begun.orderStatus === CHARGE_TO && (await store.getOrder('ORD-02201')).status === CHARGE_TO);
  ok('the payment is an intent recording what will be collected',
     begun.payment.status === 'intent' && begun.payment.amount === TOTAL);
  ok('the intent is not marked simulated — cash is real', begun.payment.simulated === false);

  ok('the customer cannot settle their own cash payment',
     (await code(() => settleCashOnDelivery(store, { orderRef: 'ORD-02201', actor: 'customer' }))) === 'cod_needs_courier');
  ok('and that refusal captured nothing', (await store.capturedPayment('ORD-02201')) === null);

  const settled = await settleCashOnDelivery(store, { orderRef: 'ORD-02201', actor: 'courier' });
  ok('the courier settles it at handover', settled.payment.status === 'captured');
  const again = await settleCashOnDelivery(store, { orderRef: 'ORD-02201', actor: 'courier' });
  ok('settling twice is the same settlement',
     again.replayed === true && again.payment.ref === settled.payment.ref);
  ok('one payment row throughout', (await store.paymentsFor('ORD-02201')).length === 1);

  const empty = seed();
  ok('settling an order with no cash intent is refused',
     (await code(() => settleCashOnDelivery(empty, { orderRef: 'ORD-02201', actor: 'courier' }))) === 'no_cash_intent');
}

/* ─────────────────────────────────────────────────────────────────────── */
H('18. Refunds');
{
  const store = seed();
  await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 'ref1' });
  await completePayment(store, { orderRef: 'ORD-02201' });

  const partial = await refundOrder(store, { orderRef: 'ORD-02201', amount: 300, reason: 'short run', idemKey: 'p1' });
  ok('a partial refund settles', partial.refund.status === 'refunded');
  ok('the payment reads partially_refunded',
     (await store.capturedPayment('ORD-02201')).status === 'partially_refunded');

  const replayedRefund = await refundOrder(store, { orderRef: 'ORD-02201', amount: 300, reason: 'short run', idemKey: 'p1' });
  ok('replaying a refund key does not refund twice',
     replayedRefund.refund.ref === partial.refund.ref && store._refunds.length === 1);
  ok('the refunded total did not double',
     (await store.capturedPayment('ORD-02201')).refunded === 300);

  ok('a refund larger than what is left is refused',
     (await code(() => refundOrder(store, { orderRef: 'ORD-02201', amount: 5000, idemKey: 'p2' }))) === 'bad_refund_amount');
  ok('a zero refund is refused',
     (await code(() => refundOrder(store, { orderRef: 'ORD-02201', amount: 0, idemKey: 'p3' }))) === 'bad_refund_amount');

  const rest = await refundOrder(store, { orderRef: 'ORD-02201', reason: 'cancelled', idemKey: 'p4' });
  ok('refunding with no amount refunds the remainder', rest.refund.amount === TOTAL - 300);
  ok('the payment is now fully refunded',
     (await store.capturedPayment('ORD-02201')).status === 'refunded');
  ok('and nothing further can be refunded',
     (await code(() => refundOrder(store, { orderRef: 'ORD-02201', idemKey: 'p5' }))) === 'bad_refund_amount');

  const unpaid = seed();
  ok('an unpaid order has nothing to refund',
     (await code(() => refundOrder(unpaid, { orderRef: 'ORD-02201' }))) === 'nothing_to_refund');
}

/* ─────────────────────────────────────────────────────────────────────── */
H('19. What the order screen is told');
{
  const store = seed();
  const before = await paymentState(store, 'ORD-02201');
  ok('an unpaid order at approval reports itself chargeable',
     before.chargeable.ok === true && before.paid === false);
  ok('and it lists the three methods', before.methods.length === 3);

  await beginApprovalPayment(store, { orderRef: 'ORD-02201', provider: 'bkash', idemKey: 's1' });
  await completePayment(store, { orderRef: 'ORD-02201' });
  const after = await paymentState(store, 'ORD-02201');
  ok('a paid order reports paid, with the amount and provider',
     after.paid === true && after.payment.amount === TOTAL && after.payment.provider === 'bkash');
  ok('and it is no longer chargeable', after.chargeable.ok === false && after.chargeable.code === 'already_started');
  ok('open incidents are surfaced, not buried', Array.isArray(after.openIncidents) && after.openIncidents.length === 0);

  ok('an unknown order is a not-found, not an empty state',
     (await code(() => paymentState(store, 'ORD-99999'))) === 'order_not_found');
}

H('20. Store constraints match the migration');
{
  const store = seed();
  await store.openIntent({ orderRef: 'ORD-02201', provider: 'bkash', amount: TOTAL, captureKey: 'x' });
  const dup = await threw(() => store.openIntent({ orderRef: 'ORD-02201', provider: 'bkash', amount: TOTAL, captureKey: 'x' }));
  ok('(order_ref, capture_key) is unique',
     dup instanceof StoreConflict && dup.code === 'duplicate_capture_key', dup && dup.code);

  const other = await store.openIntent({ orderRef: 'ORD-02201', provider: 'nagad', amount: TOTAL, captureKey: 'y' });
  await store.markCaptured(1, 'TRX1');
  const second = await threw(() => store.markCaptured(other.id, 'TRX2'));
  ok('at most one captured payment per order',
     second instanceof StoreConflict && second.code === 'already_captured', second && second.code);

  ok('references come from sequences and keep advancing past a gap',
     (await store.openIntent({ orderRef: 'ORD-02204', provider: 'cod', amount: TOTAL, captureKey: 'z' })).ref === 'PAY-001002');

  /* The transition table, which the payments_guard trigger enforces in
     Postgres. A failed attempt is terminal: the money going back after an
     unrecorded capture is a refunds row, never a rewrite of what this row was. */
  const t = seed();
  const p = await t.openIntent({ orderRef: 'ORD-02201', provider: 'bkash', amount: TOTAL, captureKey: 'k' });
  await t.markFailed(p.id, 'declined');
  ok('a failed payment cannot later be captured',
     (await threw(() => t.markCaptured(p.id, 'TRX'))) instanceof StoreConflict);
  await t.openRefund({ paymentId: p.id, orderRef: 'ORD-02201', provider: 'bkash', amount: TOTAL, reason: 'x', refundKey: 'k' });
  await t.settleRefund(t._refunds[0].id, p.id, TOTAL, 'R1', 'refunded');
  ok('and refunding it does not turn it into a refunded capture',
     (await t.paymentsFor('ORD-02201'))[0].status === 'failed',
     (await t.paymentsFor('ORD-02201'))[0].status);
  ok('the refund itself is still recorded', t._refunds[0].status === 'refunded');
}

H('21. The migration keeps the patterns db/schema.sql proved');
{
  const sqlText = fs.readFileSync(path.join(ROOT, 'db/migrations/003_payments.sql'), 'utf8');
  ok('payments carries the columns Technical Design §5.2 specifies',
     ['order_ref','provider','provider_ref','amount','status','created_at']
       .every(c => new RegExp(`^\\s+${c}\\s`, 'm').test(sqlText)));
  ok('payment references come from a dedicated sequence, not a row count',
     /CREATE SEQUENCE IF NOT EXISTS payments_ref_seq/.test(sqlText) &&
     /nextval\('payments_ref_seq'\)/.test(sqlText));
  ok('refund and incident references do too',
     /nextval\('refunds_ref_seq'\)/.test(sqlText) && /nextval\('payment_incidents_ref_seq'\)/.test(sqlText));
  ok('no identifier is derived from a count',
     !/count\(\*\)/i.test(sqlText));
  ok('the append-only tables are enforced by a trigger, not by convention',
     /CREATE TRIGGER payment_events_immutable/.test(sqlText) &&
     /CREATE TRIGGER payment_incidents_immutable/.test(sqlText));
  ok('the payment state machine is enforced in the database',
     /illegal payment transition/.test(sqlText) && /CREATE TRIGGER payments_guarded/.test(sqlText));
  ok('the immutable columns of a payment are frozen by the same trigger',
     /fixed at creation/.test(sqlText));
  ok('one capture per order is a unique index, not an application check',
     /CREATE UNIQUE INDEX IF NOT EXISTS payments_one_capture_per_order_ix/.test(sqlText));
  ok('a capture key is unique per order', /payments_capture_key_ix/.test(sqlText));
}

H('22. Credentials never reach a log');
{
  const files = ['provider.mjs','bkash.mjs','nagad.mjs','cod.mjs','quote.mjs','store.mjs','index.mjs']
    .map(f => [f, fs.readFileSync(path.join(ROOT, 'lib/payments', f), 'utf8')]);
  const fn = fs.readFileSync(path.join(ROOT, 'netlify/functions/payments.mjs'), 'utf8');

  const SECRETS = /(BKASH_APP_SECRET|BKASH_PASSWORD|NAGAD_PRIVATE_KEY|app_secret|password)/;
  const loggedSecret = files.concat([['payments.mjs', fn]]).filter(([, src]) =>
    src.split('\n').some(line => /console\.(log|warn|error|info)/.test(line) && SECRETS.test(line)));
  ok('no console call in the payment code mentions a credential',
     loggedSecret.length === 0, loggedSecret.map(([f]) => f).join(','));

  const [, providerSrc] = files.find(([f]) => f === 'provider.mjs');
  ok('a failed provider call reports the URL without its query string',
     /x\.origin \+ x\.pathname/.test(providerSrc));
  ok('the request body and headers are never attached to a thrown error',
     !/detail:\s*\{[^}]*\bbody\b\s*[,}]/.test(providerSrc));

  const [, bkashSrc] = files.find(([f]) => f === 'bkash.mjs');
  ok('bKash credentials are read through env(), never interpolated into a message',
     !/\$\{[^}]*(BKASH_APP_SECRET|BKASH_PASSWORD)/.test(bkashSrc));

  ok('the endpoint compares the staff token without leaking its length by early exit',
     /got\.length === expected\.length/.test(fn));
  ok('.env stays gitignored', /^\.env$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
  ok('.env.example holds no real-looking secret',
     !/[A-Za-z0-9+/]{40,}={0,2}/.test(
       fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').replace(/^#.*$/gm, '')));
}

H('23. The endpoint never charges a client-supplied amount');
{
  const fn = fs.readFileSync(path.join(ROOT, 'netlify/functions/payments.mjs'), 'utf8');
  ok('the only use of body.total is as a claim to be recorded',
     (fn.match(/body\.total/g) || []).length === 1 && /claimedAmount:\s*body\.total/.test(fn));
  /* The begin call site is the one that leads to a provider charge. It must
     name no amount at all — the figure comes from the quote inside
     beginApprovalPayment, and `claimedAmount` is only there to be logged. */
  const beginCall = fn.slice(fn.indexOf('beginApprovalPayment(store, {'),
                             fn.indexOf('payload = {'));
  ok('the capture call site names no amount from the body',
     beginCall.length > 0 && !/\bamount:/.test(beginCall) && /claimedAmount:\s*body\.total/.test(beginCall));
  ok('nothing in the endpoint passes a body figure as a charge amount',
     !/amount:\s*body\.(total|subtotal|price|quote)/.test(fn));
  ok('the refund amount is the one figure a staff caller may name, and refundOrder bounds it',
     /amount:\s*body\.amount === undefined \? null : body\.amount/.test(fn) &&
     /That is more than is left to refund/.test(
       fs.readFileSync(path.join(ROOT, 'lib/payments/index.mjs'), 'utf8')));
  /* orders.mjs is not mine, but the property is: no endpoint that can reach
     this module may charge a figure the client chose. An earlier version of
     this block asserted that orders.mjs did not import lib/payments, which was
     true of my boundary during wave 1 and became false the moment the order
     endpoint was rewired — a process constraint, and those expire. What
     follows is the product property the old assertion was standing in for,
     applied to the file that now does the charging. */
  const ordersSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/orders.mjs'), 'utf8');

  ok('orders.mjs routes approval through beginApprovalPayment',
     /beginApprovalPayment\(/.test(ordersSrc) && /from '\.\.\/\.\.\/lib\/payments\/index\.mjs'/.test(ordersSrc));
  ok('the approve action no longer maps straight to a status change',
     !/approve\s*:\s*'printing'/.test(ordersSrc));
  ok('orders.mjs never writes the printing status itself',
     !/status\s*=\s*'printing'/.test(ordersSrc) && !/'printing'\s*[,:]/.test(
       ordersSrc.replace(/\['printing',[^\]]*\]/g, '')));

  /* The approve call site: no amount may cross it. `claimedAmount` is the one
     place b.total is allowed to appear, and only to be compared and reported. */
  const approveCall = ordersSrc.slice(ordersSrc.indexOf('beginApprovalPayment(createStore(sql), {'),
                                      ordersSrc.indexOf('await sql`INSERT INTO order_events'));
  ok('the approve call site names no amount from the body',
     approveCall.length > 0 && !/\bamount:/.test(approveCall) &&
     /claimedAmount:\s*b\.total === undefined \? undefined : Number\(b\.total\)/.test(approveCall));

  /* The place-order path: the row's total is the quote engine's figure, and a
     client total that disagrees is a conflict rather than something absorbed
     in either direction. */
  ok('the order row is priced from amountForOrder, not from the body',
     /const priced = await amountForOrder\(\{/.test(ordersSrc) &&
     /\$\{priced\.amount\}/.test(ordersSrc) && !/\$\{Math\.round\(Number\(b\.total\)/.test(ordersSrc));
  ok('a client total that disagrees with the quote is a price_moved conflict',
     /code:\s*'price_moved'/.test(ordersSrc) &&
     /claimed !== null && claimed !== priced\.amount/.test(ordersSrc));
  /* Every line that mentions the client's total has to be either the claim
     handed to the payment module or the comparison that produces the
     conflict. Counting occurrences would only re-break the day someone
     reformats a line, so the assertion is on where they appear. */
  const totalLines = ordersSrc.split('\n')
    .filter(l => /b\.total/.test(l))
    .map(l => l.trim());
  ok('b.total appears only as a claim and as a comparison, never as a stored value',
     totalLines.length > 0 && totalLines.every(l =>
       /^claimedAmount:/.test(l) || /^const claimed = /.test(l)),
     totalLines.join(' | '));
  ok('and it never reaches the INSERT that writes the order row',
     !/INSERT INTO orders[\s\S]*?b\.total[\s\S]*?RETURNING/.test(ordersSrc));
  ok('the quote is pinned to the order so the charge re-derives the same number',
     /UPDATE orders SET quote_id = \$\{b\.quoteId\}/.test(ordersSrc));

  /* The response cache lives in a table another subgroup owns. Losing it must
     degrade to "the capture_key does the work", never to a 500 at the moment
     the customer is paying. */
  ok('a missing idempotency_keys table cannot 500 a payment',
     /try \{ replayed = await replay\(sql, key, scope\); \}/.test(fn) &&
     /catch \(e\) \{ console\.error\('idempotency replay unavailable/.test(fn));
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
