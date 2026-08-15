/* bKash Tokenized Checkout.
 *
 * Shapes confirmed against bKash's tokenized checkout as it is actually called
 * in the wild (rahulhaque/bKash-payment-gateway-web-demo and
 * Irfan-Chowdhury/bkash-tokenized-checkout for the grant/create/execute
 * sequence; prabalsslw/bKash-Tokenized-PHP's endpoint table and
 * SagarBiswas-MultiHAT/bazaarflow-ecommerce for the status and refund paths),
 * checked August 2026. The sandbox host is
 * https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized and production is
 * https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized; both are overridable by
 * env because bKash has moved this path once already and will again.
 *
 * The four calls, in the order the flow uses them:
 *   POST /tokenized/checkout/token/grant     app_key + app_secret, username
 *                                            and password as *headers*
 *   POST /tokenized/checkout/create          mode 0011, amount as a string
 *   POST /tokenized/checkout/execute         { paymentID } -> trxID
 *   POST /tokenized/checkout/payment/status  { paymentID }, for reconciliation
 *   POST /tokenized/checkout/payment/refund  { paymentID, trxID, amount, ... }
 *
 * The thing worth knowing that the field list does not tell you: `create` does
 * not take money. Nothing is debited until `execute` succeeds, and `execute`
 * only succeeds after the customer has authorised on bKash's own page. That is
 * why this provider fits the proof-before-charge rule without bending it — the
 * intent can be raised the moment the customer taps approve, and the debit
 * still happens on their side of a screen they had to agree to.
 */
import {
  PaymentError, callJSON, env, hasAll, simulationGuard, wireAmount
} from './provider.mjs';

export const id = 'bkash';
export const label = 'bKash';
export const kind = 'redirect';

const REQUIRED = ['BKASH_APP_KEY', 'BKASH_APP_SECRET', 'BKASH_USERNAME', 'BKASH_PASSWORD'];

export const configured = () => hasAll(...REQUIRED);
const missing = () => REQUIRED.filter((n) => env(n) === null);

const base = () =>
  env('BKASH_BASE_URL') ||
  (env('BKASH_MODE') === 'live'
    ? 'https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized'
    : 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized');

/* bKash's id_token is good for an hour. Caching it in module scope means one
   grant per warm function instance rather than one per payment; a cold start
   pays for a fresh grant, which is the correct trade in a serverless runtime
   where there is nowhere else to put it that is cheaper than the call itself.
   Sixty seconds of headroom keeps a token from expiring mid-request. */
let token = { value: null, expiresAt: 0 };

async function grant() {
  if (token.value && Date.now() < token.expiresAt) return token.value;
  const res = await callJSON(`${base()}/checkout/token/grant`, {
    headers: { username: env('BKASH_USERNAME'), password: env('BKASH_PASSWORD') },
    body: { app_key: env('BKASH_APP_KEY'), app_secret: env('BKASH_APP_SECRET') }
  });
  if (!res.id_token)
    throw new PaymentError('bkash_grant_failed',
      'bKash refused the credentials for this deploy.',
      { statusCode: res.statusCode, statusMessage: res.statusMessage });
  const ttl = Math.max(60, Number(res.expires_in) || 3600);
  token = { value: res.id_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return token.value;
}

/** Reset the cached grant. Called after an auth rejection so the next attempt
 *  re-grants rather than replaying a token bKash has already invalidated. */
export const forgetToken = () => { token = { value: null, expiresAt: 0 }; };

async function authed(path, body) {
  const t = await grant();
  try {
    return await callJSON(`${base()}${path}`, {
      headers: { authorization: t, 'x-app-key': env('BKASH_APP_KEY') }, body
    });
  } catch (err) {
    if (err instanceof PaymentError && err.detail && err.detail.status === 401) forgetToken();
    throw err;
  }
}

/* bKash reports failure in a 200 body, not a status code, so every call has to
   read statusCode itself. '0000' is the only success. */
const assertOk = (res, code, what) => {
  if (res.statusCode && res.statusCode !== '0000')
    throw new PaymentError(code, `bKash refused: ${res.statusMessage || res.statusCode}`,
      { what, statusCode: res.statusCode, statusMessage: res.statusMessage });
  return res;
};

export async function createIntent({ orderRef, amount, currency = 'BDT', payerReference, callbackURL }) {
  if (!configured()) return sim.createIntent({ orderRef, amount, currency, callbackURL });
  const res = assertOk(await authed('/checkout/create', {
    mode: '0011',                       // 0011 is tokenized checkout without an agreement
    payerReference: String(payerReference || orderRef).slice(0, 40),
    callbackURL,
    amount: wireAmount(amount),
    currency,
    intent: 'sale',
    merchantInvoiceNumber: orderRef
  }), 'bkash_create_failed', 'create');
  if (!res.paymentID)
    throw new PaymentError('bkash_create_failed', 'bKash did not return a paymentID.', {});
  return { providerRef: res.paymentID, redirectURL: res.bkashURL || null, extra: {} };
}

export async function capture({ providerRef, amount }) {
  if (!configured()) return sim.capture({ providerRef, amount });
  const res = assertOk(await authed('/checkout/execute', { paymentID: providerRef }),
    'bkash_execute_failed', 'execute');
  if (res.transactionStatus !== 'Completed' || !res.trxID)
    throw new PaymentError('bkash_execute_failed',
      'bKash did not complete the transaction.',
      { transactionStatus: res.transactionStatus, statusMessage: res.statusMessage });
  return { providerTxn: res.trxID, amount: Math.round(Number(res.amount)) };
}

export async function query({ providerRef }) {
  if (!configured()) return sim.query({ providerRef });
  const res = await authed('/checkout/payment/status', { paymentID: providerRef });
  return {
    status: res.transactionStatus === 'Completed' ? 'captured'
          : res.transactionStatus === 'Initiated' ? 'intent' : 'failed',
    amount: res.amount === undefined ? null : Math.round(Number(res.amount)),
    providerTxn: res.trxID || null
  };
}

export async function refund({ providerRef, providerTxn, amount, reason }) {
  if (!configured()) return sim.refund({ providerRef, providerTxn, amount });
  const res = assertOk(await authed('/checkout/payment/refund', {
    paymentID: providerRef,
    trxID: providerTxn,
    amount: wireAmount(amount),
    sku: 'cardworks-order',
    reason: String(reason || 'reconciliation').slice(0, 255)
  }), 'bkash_refund_failed', 'refund');
  if (res.transactionStatus && res.transactionStatus !== 'Completed')
    throw new PaymentError('bkash_refund_failed', 'bKash did not complete the refund.',
      { transactionStatus: res.transactionStatus });
  return { providerRef: res.refundTrxID || res.originalTrxID || providerTxn };
}

/* ── SIMULATED TRANSPORT — development and tests only ──────────────────────
   This exists so the capture flow above can be exercised end to end on a
   machine with no merchant account, which is the situation every contributor
   is in until bKash issues sandbox credentials. It refuses to run in
   production (see simulationGuard) and everything it produces is prefixed
   SIM- so a simulated reference can never be mistaken for a real one in the
   database. It moves no money. */
const sim = {
  createIntent({ orderRef, amount }) {
    simulationGuard(id, missing());
    return {
      providerRef: `SIM-BKASH-${orderRef}-${Math.round(amount)}`,
      redirectURL: `https://simulated.invalid/bkash?order=${encodeURIComponent(orderRef)}`,
      extra: { simulated: true }
    };
  },
  capture({ providerRef, amount }) {
    simulationGuard(id, missing());
    /* A rail that always says yes is a rail nobody has tested the failure path
       of, so the simulation honours a marker in the reference. This is how the
       "a provider failure leaves no half-committed state" test drives a
       refusal without a network. */
    if (String(providerRef).includes('DECLINE'))
      throw new PaymentError('bkash_execute_failed',
        'bKash refused: simulated decline.', { simulated: true });
    return { providerTxn: `SIMTRX${String(providerRef).slice(-8)}`, amount: Math.round(amount) };
  },
  query({ providerRef }) {
    simulationGuard(id, missing());
    return { status: String(providerRef).includes('DECLINE') ? 'failed' : 'captured',
             amount: null, providerTxn: `SIMTRX${String(providerRef).slice(-8)}` };
  },
  refund({ providerTxn }) {
    simulationGuard(id, missing());
    return { providerRef: `SIMRFD${String(providerTxn).slice(-8)}` };
  }
};

export const simulated = () => !configured();
