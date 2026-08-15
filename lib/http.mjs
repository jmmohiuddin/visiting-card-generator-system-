/* The shared HTTP contract for every function in this codebase.
 *
 * Technical Design §8 asks for three things the current three endpoints do
 * not have: a versioned surface, an `Idempotency-Key` on every mutating
 * call, and an error shape of `{ code, message, field?, remediation? }`
 * where `remediation` is the next step the UI offers. That last field is the
 * reason the client can render an honest empty state generically instead of
 * needing bespoke handling per error — so it is part of the envelope here,
 * not something each endpoint invents.
 *
 * ── What `remediation` actually is ────────────────────────────────────────
 *
 * A **token**: a bare snake_case word from a small shared vocabulary
 * (`sign_in`, `fix_phone`, `wait`, `retry`, …), not a sentence.
 *
 * Two reasons, and the second is the one that decides it. A screen has to
 * branch on the next step, and it cannot branch on `code`: a mistyped
 * one-time code and an expired session are both 401 `unauthorized`, and
 * sending someone who fat-fingered a digit back to the sign-in screen they
 * are already looking at is the worse failure. Splitting `code` finely enough
 * to carry that distinction just moves the vocabulary somewhere less
 * disciplined. And a server-written English sentence cannot be shown to a
 * Bangla reader — this product treats Bangla as first-class (Master PRD §5.1,
 * §7), and a token maps to either language at render time where a sentence
 * baked into the response can only ever be one.
 *
 * Prose is still legal, and passes through untouched, because the long tail
 * of one-off refusals does not deserve a vocabulary entry. The rule is: if a
 * screen branches on it, it is a token; otherwise write the sentence.
 *
 * Both may travel together. `remediationText` carries a human fallback
 * alongside a token, and the client prefers its own localised copy for a
 * known token, then this. Send it whenever a token is new or rare — it is
 * what stops an unrecognised token from rendering as nothing at all, which
 * is the failure mode this convention would otherwise have: silent, and in
 * the reassuring direction.
 *
 * `assets/ui-shell.js` holds the token→sentence table and the lookup
 * (`remedyText`). §11 of `tests/auth.test.mjs` asserts every token the
 * endpoints emit has an entry there, so adding one without the other fails
 * the build rather than quietly blanking a line on a customer's screen.
 */
import { neon } from '@neondatabase/serverless';

export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

export const ok = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

/** The one error shape. `remediation` is what the UI offers the user next. */
export const fail = (status, code, message, extra = {}) =>
  new Response(JSON.stringify({ error: { code, message, ...extra } }), {
    status, headers: JSON_HEADERS
  });

export const ERR = {
  badRequest:   (m, x) => fail(400, 'bad_request', m, x),
  unauthorized: (m = 'Sign in to continue.', x) => fail(401, 'unauthorized', m, x),
  forbidden:    (m = 'Not yours to change.', x) => fail(403, 'forbidden', m, x),
  notFound:     (m = 'Not found.', x) => fail(404, 'not_found', m, x),
  conflict:     (m, x) => fail(409, 'conflict', m, x),
  tooLarge:     (m = 'Payload too large.', x) => fail(413, 'payload_too_large', m, x),
  unprocessable:(m, x) => fail(422, 'unprocessable', m, x),
  rateLimited:  (m = 'Too many attempts. Wait a minute.', x) => fail(429, 'rate_limited', m, x),
  server:       (m = 'Something failed on our side.', x) => fail(500, 'server_error', m, x),
  unavailable:  (m = 'The database is not configured for this deploy.', x) => fail(503, 'unavailable', m, x)
};

/** A Neon client, or null when the deploy has no database wired up. */
export const db = () => process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

/** Read and size-limit a JSON body. Returns `[body, null]` or `[null, Response]`. */
export async function readJson(req, maxBytes = 64 * 1024) {
  const raw = await req.text();
  if (raw.length > maxBytes) return [null, ERR.tooLarge()];
  if (!raw) return [{}, null];
  try { return [JSON.parse(raw), null]; }
  catch { return [null, ERR.badRequest('The request body is not valid JSON.')]; }
}

/* ── Idempotency ────────────────────────────────────────────────────────
   A retried order must not become two orders. The key is the caller's, the
   response is ours, and replaying a key returns the first response verbatim
   rather than re-running the handler — which is the only version of this
   that is safe when the first attempt succeeded but the reply was lost. */

export const idempotencyKey = (req) =>
  (req.headers.get('idempotency-key') || '').trim().slice(0, 128) || null;

/** Replay a stored response for this key, or null if it is a fresh call.
 *
 *  Losing this cache must degrade to "the handler runs again", never to a
 *  failed request — a deploy that has not applied `001_idempotency.sql` has
 *  no such table, and a customer pressing Place order should not meet a 500
 *  because a convenience cache is missing. The endpoints that genuinely
 *  cannot tolerate a double effect do not rely on this: payment capture is
 *  guarded by its own partial unique index, and a design save is idempotent
 *  by content address. */
export async function replay(sql, key, scope) {
  if (!key || !sql) return null;
  let rows;
  try {
    rows = await sql`
      SELECT status, body FROM idempotency_keys
      WHERE key = ${key} AND scope = ${scope} AND created_at > now() - interval '24 hours'
      LIMIT 1`;
  } catch (e) {
    console.error('idempotency replay unavailable:', e && e.message);
    return null;
  }
  if (!rows.length) return null;
  return new Response(JSON.stringify(rows[0].body), {
    status: rows[0].status, headers: { ...JSON_HEADERS, 'idempotency-replayed': 'true' }
  });
}

/** Record a response against its key. Best-effort: a failure here must never
 *  fail the request the caller already succeeded at. */
export async function remember(sql, key, scope, status, body) {
  if (!key || !sql) return;
  try {
    await sql`
      INSERT INTO idempotency_keys (key, scope, status, body)
      VALUES (${key}, ${scope}, ${status}, ${JSON.stringify(body)}::jsonb)
      ON CONFLICT (key, scope) DO NOTHING`;
  } catch (e) { console.error('idempotency write failed:', e && e.message); }
}

/* ── Small shared validators ──────────────────────────────────────────── */
export const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const CODE_RE  = /^[0-9a-f]{6,16}$/;
export const REF_RE   = /^ORD-[0-9A-Z]{4,10}$/;
/** BD mobile numbers, normalised to +8801XXXXXXXXX. */
export const normalisePhone = (raw) => {
  const d = String(raw || '').replace(/[^\d]/g, '');
  const m = /^(?:88)?(01[3-9]\d{8})$/.exec(d);
  return m ? '+88' + m[1] : null;
};

/** Wrap a handler so an unexpected throw becomes the standard envelope
 *  instead of a stack trace, and so every response carries the API version. */
export const handler = (name, fn) => async (req, ctx) => {
  try {
    const res = await fn(req, ctx);
    res.headers.set('x-cardworks-api', 'v1');
    return res;
  } catch (err) {
    console.error(`${name} failed:`, err && err.stack);
    return ERR.server();
  }
};
