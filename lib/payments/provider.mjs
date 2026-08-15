/* The contract every payment provider in this directory implements, plus the
 * two pieces of machinery all of them share: an HTTP call that never leaks a
 * credential into a log, and the simulated transport that lets the whole
 * capture flow be exercised on a machine that has no merchant account.
 *
 * A provider is an object with `id`, `label`, `kind`, and four methods:
 *
 *   createIntent({ orderRef, amount, currency, payerReference, callbackURL })
 *       -> { providerRef, redirectURL, extra }
 *   capture({ orderRef, providerRef, amount, currency, extra })
 *       -> { providerTxn, amount }            throws PaymentError on refusal
 *   refund({ providerRef, providerTxn, amount, currency, reason })
 *       -> { providerRef }
 *   query({ providerRef })
 *       -> { status, amount, providerTxn }
 *
 * `kind` is either 'redirect', meaning the customer leaves for the provider's
 * page and comes back to a callback, or 'offline', meaning the money moves
 * outside this system entirely and capture is somebody confirming it did.
 * The orchestration in index.mjs branches on that word and nothing else, which
 * is what keeps cash-on-delivery a real payment method rather than a special
 * case bolted onto the side of the card rails.
 */

/** A refusal we understand: the provider answered, and the answer was no. */
export class PaymentError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.detail = detail;
  }
}

/* Provider credentials are read through this rather than off `process.env`
   directly, so that the one place a secret could be stringified into an error
   message is the one place that knows never to include the value. */
export const env = (name) => {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

export const hasAll = (...names) => names.every((n) => env(n) !== null);

/* Simulation is a development affordance and nothing else. A deploy that
   thinks it is production and has no credentials must fail loudly at the first
   attempt to take money, because the alternative is a customer being told
   their payment succeeded when no money moved. */
export const isProduction = () => (process.env.NODE_ENV || '') === 'production';

const warned = new Set();
export function simulationGuard(providerId, missing) {
  if (isProduction())
    throw new PaymentError(
      'provider_unconfigured',
      `${providerId} has no credentials in this deploy and simulation is refused in production.`,
      { missing }
    );
  if (!warned.has(providerId)) {
    warned.add(providerId);
    console.warn(
      `[payments] ${providerId} is running SIMULATED — ${missing.join(', ')} not set. ` +
      'No money will move. Never rely on this outside development and tests.'
    );
  }
  return true;
}

/* Providers quote in taka internally because that is the unit orders.total is
   stored in; the wire wants two decimals. Keeping the conversion here means
   there is exactly one place to look when a figure comes back a hundred times
   too large. */
export const wireAmount = (taka) => Number(taka).toFixed(2);

/** A short, non-reversible tag for a value we want to correlate but never log.
 *  Used so a support ticket can say "the key ending 9f2c" without printing it. */
export const fingerprint = (s) => {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').slice(-4);
};

/* One JSON POST/GET, with the timeout the platform will not give us for free.
   The response body is returned verbatim to the caller; the *request* body and
   headers are never echoed into a thrown error, because they hold the app
   secret and the merchant's signature. */
export async function callJSON(url, { method = 'POST', headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal
    });
  } catch (err) {
    throw new PaymentError('provider_unreachable',
      'The payment provider did not answer.', { url: safeURL(url), cause: err && err.name });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
  if (json === null)
    throw new PaymentError('provider_bad_response',
      'The payment provider returned something that is not JSON.',
      { url: safeURL(url), status: res.status });
  if (!res.ok)
    throw new PaymentError('provider_http_error',
      'The payment provider rejected the request.',
      { url: safeURL(url), status: res.status, body: json });
  return json;
}

/* A URL is safe to put in an error only once its query string is gone — Nagad
   puts the merchant id and order id in the path, which is fine, but a future
   provider putting a key in the query would otherwise land it in a log. */
const safeURL = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '(url)'; } };

/** Bangladesh keeps a fixed UTC+6 with no daylight saving, so the timestamp
 *  both providers want in Asia/Dhaka local time is an offset, not a lookup. */
export function dhakaStamp(at = new Date()) {
  const d = new Date(at.getTime() + 6 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
