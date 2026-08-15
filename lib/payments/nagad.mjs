/* Nagad Online Payment Gateway.
 *
 * Shapes confirmed August 2026 against shahriar-shojib/nagad-payment-gateway
 * (the most widely used Node implementation, and the one whose field names the
 * PHP and Dart ports agree with), cross-checked against arif98741/nagadApi and
 * dgvai/laravel-nagad for the hosts. Nagad publishes the specification as a
 * PDF handed to registered merchants rather than a public reference, so the
 * community SDKs are the citable source; anything below marked as unverified
 * is what a live merchant account would settle.
 *
 * Hosts: sandbox http://sandbox.mynagad.com:10080/remote-payment-gateway-1.0
 * and production https://api.mynagad.com — note the sandbox is plain HTTP on a
 * non-standard port, which is Nagad's choice and not a mistake here.
 *
 *   POST {base}/api/dfs/check-out/initialize/{merchantId}/{orderId}
 *        { accountNumber, dateTime, sensitiveData, signature }
 *        -> { sensitiveData, signature }, decrypting to
 *           { paymentReferenceId, acceptDateTime, challenge }
 *   POST {base}/api/dfs/check-out/complete/{paymentReferenceId}
 *        { paymentRefId, sensitiveData, signature, merchantCallbackURL,
 *          additionalMerchantInfo } -> { callBackUrl }
 *   GET  {base}/api/dfs/verify/payment/{paymentRefId}
 *        -> { orderId, paymentRefId, amount, issuerPaymentRefNo, status, ... }
 *
 * The cryptography is the part that gets implemented wrong. Sensitive data is
 * RSA-encrypted with *Nagad's* public key and signed with the *merchant's*
 * private key, both PKCS#1 v1.5, both base64. The reply's sensitiveData is
 * decrypted with the merchant's private key. `challenge` is the uppercase hex
 * SHA-1 of the order id on the way in, and on the way out it is Nagad's own
 * value, which must be echoed back in the complete call — sending the first
 * one again is the most common integration failure.
 *
 * Nagad's own guide describes SHA1withRSA for verifying signatures Nagad
 * produces, while every working merchant implementation signs with SHA256.
 * NAGAD_SIGN_ALG exists so that can be switched without a deploy if a live
 * account disagrees; it is unverified against a real merchant portal.
 *
 * Nagad has no execute step: initialize and complete together hand back a URL,
 * the customer pays there, and money moves on Nagad's side. Capture here is
 * therefore a verify — we ask Nagad what happened and record only what it
 * says, which is the right shape anyway, because the alternative is trusting a
 * browser redirect to tell us we were paid.
 */
import crypto from 'node:crypto';
import {
  PaymentError, callJSON, dhakaStamp, env, hasAll, simulationGuard, wireAmount
} from './provider.mjs';

export const id = 'nagad';
export const label = 'Nagad';
export const kind = 'redirect';

const REQUIRED = ['NAGAD_MERCHANT_ID', 'NAGAD_MERCHANT_NUMBER', 'NAGAD_PRIVATE_KEY', 'NAGAD_PUBLIC_KEY'];

export const configured = () => hasAll(...REQUIRED);
const missing = () => REQUIRED.filter((n) => env(n) === null);

const base = () =>
  env('NAGAD_BASE_URL') ||
  (env('NAGAD_MODE') === 'live'
    ? 'https://api.mynagad.com/remote-payment-gateway-1.0'
    : 'http://sandbox.mynagad.com:10080/remote-payment-gateway-1.0');

/* Nagad's portal hands the keys over as bare base64 with no PEM armour, and
   half the merchants store them that way. Adding the header back is cheaper
   than every operator remembering to. */
const pem = (raw, type) =>
  /begin/i.test(raw) ? raw.trim()
    : `-----BEGIN ${type} KEY-----\n${raw.trim()}\n-----END ${type} KEY-----`;

const privateKey = () => pem(env('NAGAD_PRIVATE_KEY'), 'PRIVATE');
const nagadPublicKey = () => pem(env('NAGAD_PUBLIC_KEY'), 'PUBLIC');

const encrypt = (obj) => crypto.publicEncrypt(
  { key: nagadPublicKey(), padding: crypto.constants.RSA_PKCS1_PADDING },
  Buffer.from(JSON.stringify(obj))
).toString('base64');

const decrypt = (b64) => JSON.parse(crypto.privateDecrypt(
  { key: privateKey(), padding: crypto.constants.RSA_PKCS1_PADDING },
  Buffer.from(b64, 'base64')
).toString());

const sign = (obj) => {
  const s = crypto.createSign(env('NAGAD_SIGN_ALG') || 'SHA256');
  s.update(JSON.stringify(obj));
  s.end();
  return s.sign(privateKey(), 'base64');
};

const challengeFor = (orderRef) =>
  crypto.createHash('sha1').update(orderRef).digest('hex').toUpperCase();

/* Nagad rejects a loopback address outright, which makes local development
   fail in a way that looks like a credential problem. A routable placeholder
   keeps the failure honest. */
const clientIP = (ip) =>
  !ip || ip === '::1' || ip === '127.0.0.1' ? '103.100.200.100' : ip;

const headers = (ip) => ({
  'X-KM-Api-Version': env('NAGAD_API_VERSION') || 'v-0.2.0',
  'X-KM-IP-V4': clientIP(ip),
  'X-KM-Client-Type': 'PC_WEB'
});

export async function createIntent({ orderRef, amount, callbackURL, clientIp, meta = {} }) {
  if (!configured()) return sim.createIntent({ orderRef, amount, callbackURL });

  const merchantId = env('NAGAD_MERCHANT_ID');
  const dateTime = dhakaStamp();
  const initSensitive = { merchantId, datetime: dateTime, orderId: orderRef, challenge: challengeFor(orderRef) };

  const init = await callJSON(
    `${base()}/api/dfs/check-out/initialize/${merchantId}/${encodeURIComponent(orderRef)}`,
    {
      headers: headers(clientIp),
      body: {
        accountNumber: env('NAGAD_MERCHANT_NUMBER'),
        dateTime,
        sensitiveData: encrypt(initSensitive),
        signature: sign(initSensitive)
      }
    }
  );
  if (!init.sensitiveData)
    throw new PaymentError('nagad_initialize_failed',
      `Nagad refused to initialise: ${init.message || init.reason || 'no sensitive data returned'}`,
      { status: init.status, reasonCode: init.reasonCode });

  /* The challenge that comes back is Nagad's, not the one we sent. Echoing our
     own here is the failure that reads as a signature mismatch. */
  const { paymentReferenceId, challenge } = decrypt(init.sensitiveData);

  const completeSensitive = {
    merchantId, orderId: orderRef, amount: wireAmount(amount),
    currencyCode: '050',                       // ISO 4217 numeric for BDT
    challenge
  };
  const done = await callJSON(
    `${base()}/api/dfs/check-out/complete/${encodeURIComponent(paymentReferenceId)}`,
    {
      headers: headers(clientIp),
      body: {
        paymentRefId: paymentReferenceId,
        sensitiveData: encrypt(completeSensitive),
        signature: sign(completeSensitive),
        merchantCallbackURL: callbackURL,
        additionalMerchantInfo: { ...meta, orderRef }
      }
    }
  );
  if (!done.callBackUrl)
    throw new PaymentError('nagad_complete_failed',
      `Nagad refused to complete: ${done.message || done.status || 'no callback URL returned'}`,
      { status: done.status });

  return { providerRef: paymentReferenceId, redirectURL: done.callBackUrl, extra: {} };
}

/* Capture is a verify. Nagad has already taken or not taken the money by the
   time the customer lands back here; the only honest thing to do is ask. */
export async function capture({ providerRef, amount }) {
  if (!configured()) return sim.capture({ providerRef, amount });
  const res = await verify(providerRef);
  if (res.status !== 'captured')
    throw new PaymentError('nagad_not_paid',
      `Nagad reports the payment as ${res.raw.status || 'unknown'}.`,
      { status: res.raw.status, statusCode: res.raw.statusCode });
  return { providerTxn: res.providerTxn, amount: res.amount };
}

export async function query({ providerRef }) {
  if (!configured()) return sim.query({ providerRef });
  const r = await verify(providerRef);
  return { status: r.status, amount: r.amount, providerTxn: r.providerTxn };
}

async function verify(providerRef) {
  const raw = await callJSON(
    `${base()}/api/dfs/verify/payment/${encodeURIComponent(providerRef)}`,
    { method: 'GET' }
  );
  return {
    status: String(raw.status || '').toLowerCase() === 'success' ? 'captured'
          : String(raw.status || '').toLowerCase() === 'pending' ? 'intent' : 'failed',
    amount: raw.amount === undefined ? null : Math.round(Number(raw.amount)),
    providerTxn: raw.issuerPaymentRefNo || raw.paymentRefId || providerRef,
    raw
  };
}

/* Nagad's merchant refund runs through the merchant portal rather than the
   checkout API in the version documented above, so an automatic refund cannot
   be issued here without a live account confirming the endpoint. Failing with
   a specific code rather than silently pretending is what turns this into a
   reconciliation incident that a human closes, which is the correct outcome
   until the endpoint is confirmed. */
export async function refund({ providerRef, amount }) {
  if (!configured()) return sim.refund({ providerRef, amount });
  throw new PaymentError('nagad_refund_manual',
    'Nagad refunds are not available on the checkout API; this needs a portal refund.',
    { providerRef, amount });
}

/* ── SIMULATED TRANSPORT — development and tests only ──────────────────────
   Present for the same reason as the bKash one: so the orchestration can be
   tested without a merchant account. Refuses to run in production, moves no
   money, and everything it emits is prefixed SIM-. */
const sim = {
  createIntent({ orderRef, amount }) {
    simulationGuard(id, missing());
    return {
      providerRef: `SIM-NAGAD-${orderRef}-${Math.round(amount)}`,
      redirectURL: `https://simulated.invalid/nagad?order=${encodeURIComponent(orderRef)}`,
      extra: { simulated: true }
    };
  },
  capture({ providerRef, amount }) {
    simulationGuard(id, missing());
    if (String(providerRef).includes('DECLINE'))
      throw new PaymentError('nagad_not_paid', 'Nagad reports the payment as Aborted.', { simulated: true });
    return { providerTxn: `SIMNGD${String(providerRef).slice(-8)}`, amount: Math.round(amount) };
  },
  query({ providerRef }) {
    simulationGuard(id, missing());
    return { status: String(providerRef).includes('DECLINE') ? 'failed' : 'captured',
             amount: null, providerTxn: `SIMNGD${String(providerRef).slice(-8)}` };
  },
  refund({ providerRef }) {
    simulationGuard(id, missing());
    return { providerRef: `SIMRFD${String(providerRef).slice(-8)}` };
  }
};

export const simulated = () => !configured();
