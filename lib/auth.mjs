/* Lightweight phone-based accounts — sessions, one-time codes, and the claim
 * that carries a browser's anonymous work onto a real account.
 *
 * PRD Epic G replaces the anonymous `owner_key` with an account so saved
 * designs and order history survive a cleared browser or a new phone. It asks
 * for a phone number and nothing else; trade licence and BIN are corporate
 * order fields, not signup fields.
 *
 * ── The one line other endpoints adopt ─────────────────────────────────────
 *
 *   import { authenticate, sessionFrom } from '../../lib/auth.mjs';
 *
 *   const [user, err] = await authenticate(req, sql);   // sql optional
 *   if (err) return err;                                // 401 in the house envelope
 *   // user is { userId, phone, jti, expiresAt }
 *
 * `authenticate` is for endpoints that require an account. Pass `sql` and it
 * also refuses a session that has been revoked or whose row has expired; omit
 * it and verification is signature-and-clock only, which is the right trade
 * for a read path that cannot afford a round trip. It is always async so the
 * call site does not change when a caller starts passing `sql`.
 *
 * For the paths Technical Design §9 insists must keep working without an
 * account — briefing, preview, save, and the URL-hash share — use the other
 * one:
 *
 *   const user = sessionFrom(req);   // { userId, phone } | null, never throws
 *
 * A null there means anonymous, not an error, and the endpoint carries on with
 * `owner_key` exactly as it does today.
 *
 * ── The rule that decides between them ─────────────────────────────────────
 *
 * A statement that names `user_id` must authenticate with `sql`.
 *
 * This is not a style preference, and it is worth stating plainly because the
 * cheaper-looking call is the wrong one. `sessionFrom` and a bare
 * `authenticate(req)` verify a signature and a clock and touch no database at
 * all, so both happily return a live user on a deploy where migration 004 was
 * never applied and `user_id` does not exist — and the statement that names
 * the column then fails outright. `authenticate(req, sql)` cannot: its
 * revocation query reads `auth_sessions`, which the same migration creates, so
 * a missing schema surfaces as a rejected promise the caller turns into a null
 * user and an anonymous fallback. The safety comes from the argument, not from
 * the caller being signed in.
 *
 * That deploy is reachable rather than hypothetical: `npm run db:schema`
 * applies `db/schema.sql` alone, tokens are self-contained and last thirty
 * days, and a preview deploy inherits `AUTH_SECRET` while pointing at its own
 * database. `tests/auth.test.mjs` §10 enforces the rule over every function in
 * `netlify/functions/`.
 *
 * Nothing here reaches for an npm package. Signing, comparison and random
 * generation are `node:crypto` primitives, which is enough for an HMAC token
 * and keeps the function bundle the size it is.
 */
import crypto from 'node:crypto';
import { ERR, OWNER_RE, normalisePhone } from './http.mjs';

export { normalisePhone };

/* ── Secrets ───────────────────────────────────────────────────────────────
   A signing key that is absent in production is a silent authentication
   bypass waiting to happen, so this returns null there and the endpoint
   answers 503 rather than inventing a key nobody can revoke. In development
   an ephemeral per-process key is generated instead, which means restarting
   the dev server invalidates every session — noisy on purpose, because the
   alternative is a hardcoded default that eventually ships. */
let devSecret = null;
export function authSecret(env = process.env) {
  const s = env.AUTH_SECRET;
  if (typeof s === 'string' && s.length >= 32) return s;
  if (env.NODE_ENV === 'production') return null;
  if (!devSecret) devSecret = crypto.randomBytes(32).toString('hex');
  return devSecret;
}

/* The OTP pepper is separate from the session key so that a leak of one does
   not hand over the other, but it falls back to the session key rather than
   failing closed on a deploy that only set one variable. */
export const otpPepper = (env = process.env) =>
  (typeof env.OTP_PEPPER === 'string' && env.OTP_PEPPER.length >= 16)
    ? env.OTP_PEPPER : authSecret(env);

/* ── Sessions ──────────────────────────────────────────────────────────────
   A session is a signed, expiring string of the form v1.<payload>.<mac>. It
   is self-contained so the common read path verifies without a query, and it
   carries a `jti` so the sessions table can revoke a specific one — a token
   nobody can revoke is not a session, it is a permanent password.

   It travels in an `Authorization: Bearer` header rather than a cookie. The
   client already keeps its owner key in localStorage and talks to these
   endpoints over fetch, so a header costs nothing and leaves no ambient
   credential for a cross-site request to ride on. */

export const SESSION_TTL = 30 * 24 * 60 * 60;   // thirty days, in seconds
export const OTP_TTL     = 5 * 60;              // five minutes
export const OTP_MAX_ATTEMPTS = 5;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

const mac = (secret, data) =>
  crypto.createHmac('sha256', secret).update(data).digest();

/** Constant-time equality that tolerates unequal lengths without throwing. */
export function safeEqual(a, b) {
  const A = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const B = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/** Mint a session for a user. Returns the token plus the fields the
 *  `auth_sessions` row needs, so the caller records what it handed out. */
export function signSession({ userId, phone }, opts = {}) {
  const secret = opts.secret || authSecret();
  if (!secret) throw new Error('AUTH_SECRET is not configured');
  const now = Math.floor((opts.now || Date.now()) / 1000);
  const ttl = Number(opts.ttlSeconds) > 0 ? Math.floor(opts.ttlSeconds) : SESSION_TTL;
  const jti = opts.jti || crypto.randomBytes(16).toString('base64url');
  const payload = { u: Number(userId), p: String(phone), j: jti, iat: now, exp: now + ttl };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(mac(secret, 'v1.' + body));
  return {
    token: `v1.${body}.${sig}`,
    jti,
    issuedAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date((now + ttl) * 1000).toISOString(),
    expiresIn: ttl
  };
}

/** Verify a token's signature and clock. Returns `{ ok, user }` or a reason.
 *  The reasons are for logs and tests; the endpoint never shows them to a
 *  caller, because "expired" and "forged" are the same refusal to a stranger. */
export function verifySessionToken(token, opts = {}) {
  const secret = opts.secret || authSecret();
  if (!secret) return { ok: false, reason: 'unconfigured' };
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [, body, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig))
    return { ok: false, reason: 'malformed' };
  if (!safeEqual(unb64u(sig), mac(secret, 'v1.' + body))) return { ok: false, reason: 'bad_signature' };

  let p;
  try { p = JSON.parse(unb64u(body).toString('utf8')); }
  catch { return { ok: false, reason: 'malformed' }; }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed' };
  if (!Number.isInteger(p.u) || p.u <= 0) return { ok: false, reason: 'malformed' };
  if (normalisePhone(p.p) !== p.p) return { ok: false, reason: 'malformed' };
  if (typeof p.j !== 'string' || !p.j) return { ok: false, reason: 'malformed' };

  const now = Math.floor((opts.now || Date.now()) / 1000);
  if (!Number.isFinite(p.exp) || p.exp <= now) return { ok: false, reason: 'expired' };
  // A token issued in the future is a clock-skew artefact at best and a forged
  // payload at worst; sixty seconds of tolerance covers the former.
  if (Number.isFinite(p.iat) && p.iat > now + 60) return { ok: false, reason: 'malformed' };

  return {
    ok: true,
    user: { userId: p.u, phone: p.p, jti: p.j, expiresAt: new Date(p.exp * 1000).toISOString() }
  };
}

/** Pull the bearer token off a request. */
export function bearerToken(req) {
  const h = (req && req.headers && req.headers.get('authorization')) || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** The anonymous-tolerant reader: `{ userId, phone }` when signed in, null
 *  otherwise. Never throws and never queries.
 *
 *  Because it never queries, it is the wrong call for any path that goes on to
 *  name `user_id` in a statement — it will hand back a live user on a deploy
 *  where migration 004 was never applied and the column does not exist. Use
 *  `authenticate(req, sql)` there. This one is for read paths that only need
 *  to know whether to show an account or a browser key. */
export function sessionFrom(req) {
  const t = bearerToken(req);
  if (!t) return null;
  const v = verifySessionToken(t);
  return v.ok ? { userId: v.user.userId, phone: v.user.phone, jti: v.user.jti } : null;
}

/** The account-required reader. `[user, null]` or `[null, Response]`, matching
 *  `readJson` in lib/http.mjs so both read the same at a call site. It returns
 *  a tuple in every case — it is never null and never throws for an absent or
 *  invalid token, so `const [user] = await authenticate(req, sql)` is the only
 *  correct destructure; assigning the result whole and reading `.userId` off it
 *  yields undefined and silently treats every signed-in caller as anonymous.
 *
 *  Passing `sql` adds the revocation check, and is mandatory for any path that
 *  names `user_id` in a statement — see the rule in the file header. It can
 *  reject when `auth_sessions` is missing, which is the intended signal that
 *  migration 004 has not run; catch it into `[null, null]` to fall back to
 *  anonymous rather than failing the request. */
export async function authenticate(req, sql = null) {
  const t = bearerToken(req);
  if (!t) return [null, ERR.unauthorized('Sign in with your mobile number to continue.',
    { remediation: 'sign_in' })];
  const v = verifySessionToken(t);
  if (!v.ok) {
    if (v.reason === 'unconfigured')
      return [null, ERR.unavailable('Accounts are not configured for this deploy.')];
    return [null, ERR.unauthorized('Your session has ended. Sign in again.',
      { remediation: 'sign_in' })];
  }
  if (sql) {
    const rows = await sql`
      SELECT 1 FROM auth_sessions
      WHERE jti = ${v.user.jti} AND revoked_at IS NULL AND expires_at > now()
      LIMIT 1`;
    if (!rows.length)
      return [null, ERR.unauthorized('Your session has ended. Sign in again.',
        { remediation: 'sign_in' })];
  }
  return [v.user, null];
}

/* ── One-time codes ────────────────────────────────────────────────────────
   Six digits from the CSPRNG, never `Math.random`, and never stored as typed.
   What goes in the table is an HMAC of the code under a server-side pepper
   keyed by phone, so a dump of `auth_otps` does not let anyone sign in and the
   same code for two numbers hashes differently. */

export function generateOtp(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

export function hashOtp(phone, code, env = process.env) {
  const pepper = otpPepper(env);
  if (!pepper) throw new Error('OTP_PEPPER is not configured');
  return crypto.createHmac('sha256', pepper)
    .update(String(phone) + ':' + String(code)).digest('hex');
}

/** Mint a code, retire the outstanding ones, and send it. The plaintext never
 *  leaves this function — not into the return value, not into a log line, not
 *  into the caller's error path — so there is no route by which a code reaches
 *  a response body or a log aggregator. */
export async function issueOtp(sql, phone, opts = {}) {
  /* A fresh request retires the live codes for this number. Leaving them
     valid would let an attacker accumulate a pile of simultaneously good
     guesses simply by asking repeatedly. */
  await sql`UPDATE auth_otps SET consumed_at = now()
            WHERE phone = ${phone} AND consumed_at IS NULL`;

  const code = generateOtp();
  const ttl = Number(opts.ttlSeconds) > 0 ? Math.floor(opts.ttlSeconds) : OTP_TTL;
  await sql`
    INSERT INTO auth_otps (phone, code_hash, purpose, max_attempts, request_ip, expires_at)
    VALUES (${phone}, ${hashOtp(phone, code)}, 'signin', ${OTP_MAX_ATTEMPTS}, ${opts.ip || null},
            now() + make_interval(secs => ${ttl}))`;

  const sender = opts.sender || smsSender();
  const sent = await sender.send(phone, otpMessage(code, opts.locale));
  if (!sent || !sent.delivered) {
    await sql`UPDATE auth_otps SET consumed_at = now()
              WHERE phone = ${phone} AND consumed_at IS NULL`;
    return { sent: false, expiresIn: ttl };
  }
  return { sent: true, expiresIn: ttl };
}

/** Spend a code. Every failure returns the same shape with a reason the
 *  caller must not pass on to a stranger — being told "expired" rather than
 *  "wrong" tells an attacker which half to work on. Returns `{ ok: true }` at
 *  most once per code, which is the property the whole flow rests on. */
export async function consumeOtp(sql, phone, code) {
  const typed = String(code == null ? '' : code).trim();
  if (!/^\d{6}$/.test(typed)) return { ok: false, reason: 'malformed' };

  const rows = await sql`
    SELECT id, code_hash FROM auth_otps
    WHERE phone = ${phone} AND consumed_at IS NULL AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1`;
  if (!rows.length) return { ok: false, reason: 'no_live_code' };
  const otp = rows[0];

  if (!safeEqual(otp.code_hash, hashOtp(phone, typed))) {
    /* Burn the code once its guesses are spent. Counting without burning is a
       throttle, not a limit — it leaves the code guessable, just slowly. Five
       wrong guesses out of a million ends it. The CASE keeps the decision in
       the database so two concurrent wrong guesses cannot both read the old
       attempt count and neither trip the ceiling. */
    await sql`
      UPDATE auth_otps
      SET attempts = attempts + 1,
          consumed_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE consumed_at END
      WHERE id = ${otp.id}`;
    return { ok: false, reason: 'wrong' };
  }

  /* Single use, decided by the database. The WHERE clause is what makes it
     true: two requests arriving with the same correct code race here, and
     only the one that flips consumed_at gets a session. Checking in
     JavaScript and updating afterwards would hand both of them one. */
  const burned = await sql`
    UPDATE auth_otps SET consumed_at = now()
    WHERE id = ${otp.id} AND consumed_at IS NULL RETURNING id`;
  if (!burned.length) return { ok: false, reason: 'raced' };
  return { ok: true };
}

/* ── Rate limiting ─────────────────────────────────────────────────────────
   Counted in Postgres against a ledger rather than in memory, because every
   function invocation is a fresh process and an in-memory counter would reset
   for free on the attacker's behalf. Both ends are limited and both keys are
   limited: per phone, so one number cannot be spammed with texts we pay for,
   and per IP, so one host cannot walk the number space. Exceeding a limit
   locks the bucket for the remainder of the window rather than merely
   throttling, which is what makes an online brute force of a six-digit code
   hopeless. */

export const LIMITS = {
  requestPerPhone: { limit: 3,  windowSeconds: 15 * 60 },
  requestPerIp:    { limit: 12, windowSeconds: 15 * 60 },
  verifyPerPhone:  { limit: 6,  windowSeconds: 15 * 60 },
  verifyPerIp:     { limit: 20, windowSeconds: 15 * 60 },
  claimPerUser:    { limit: 10, windowSeconds: 24 * 60 * 60 }
};

/** The pure half of the limiter, so the decision is testable without a
 *  database. `oldestMs` is the age of the oldest hit still inside the window,
 *  which is what the retry-after is derived from. */
export function rateVerdict({ count, limit, windowSeconds, oldestMs = 0 }) {
  if (count < limit) return { allowed: true, remaining: limit - count - 1, retryAfter: 0 };
  const retryAfter = Math.max(1, Math.ceil(windowSeconds - oldestMs / 1000));
  return { allowed: false, remaining: 0, retryAfter };
}

/** Count a bucket's hits inside its window and decide. Records nothing. */
export async function rateCheck(sql, bucket, rule) {
  if (!sql) return { allowed: true, remaining: rule.limit, retryAfter: 0 };
  const rows = await sql`
    SELECT count(*)::int AS n,
           COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))) * 1000, 0)::float8 AS oldest_ms
    FROM auth_attempts
    WHERE bucket = ${bucket}
      AND created_at > now() - make_interval(secs => ${rule.windowSeconds})`;
  const r = rows[0] || { n: 0, oldest_ms: 0 };
  return rateVerdict({ count: r.n, limit: rule.limit, windowSeconds: rule.windowSeconds,
                       oldestMs: r.oldest_ms });
}

/** Record one hit against a bucket. Best-effort, like the idempotency writer:
 *  a limiter that fails the request it was only meant to count is worse than
 *  a limiter that misses one hit. */
export async function rateRecord(sql, bucket, kind) {
  if (!sql) return;
  try { await sql`INSERT INTO auth_attempts (bucket, kind) VALUES (${bucket}, ${kind})`; }
  catch (e) { console.error('rate ledger write failed:', e && e.message); }
}

/** The caller's address as Netlify presents it, falling back to the first hop
 *  of `x-forwarded-for`. Anything past the first hop is attacker-controlled. */
export function clientIp(req) {
  const h = (req && req.headers) || { get: () => null };
  const direct = h.get('x-nf-client-connection-ip');
  if (direct) return direct.trim().slice(0, 64);
  const xff = h.get('x-forwarded-for') || '';
  return (xff.split(',')[0] || 'unknown').trim().slice(0, 64) || 'unknown';
}

/* ── SMS ───────────────────────────────────────────────────────────────────
   Delivery in Bangladesh means a local aggregator, not Twilio, so the sender
   is an interface with one HTTP implementation and one development stand-in.
   The stand-in exists so a contributor without gateway credentials can still
   run the whole flow locally; it refuses outright under NODE_ENV=production,
   because a silently-not-sending production deploy hands a session to whoever
   asks. Neither transport ever writes the code anywhere — not to a log, not
   to an error, not to the response. */

export function httpSmsSender(env = process.env) {
  const url = env.SMS_API_URL || 'https://bulksmsbd.net/api/smsapi';
  const key = env.SMS_API_KEY;
  const sender = env.SMS_SENDER_ID;
  return {
    name: 'http',
    async send(phone, message) {
      /* BulkSMSBD and the aggregators that clone its shape take form-encoded
         parameters and answer with a JSON envelope whose `response_code` is
         202 on acceptance; anything else is a rejection whose text may quote
         the message back, so only the code is ever logged. Numbers go without
         the leading plus, which is what the local gateways expect. */
      const body = new URLSearchParams({
        api_key: key, type: 'text', senderid: sender,
        number: String(phone).replace(/^\+/, ''), message
      });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      let code = null;
      try { code = (await res.json()).response_code; } catch { /* non-JSON gateway error */ }
      if (!res.ok || Number(code) !== 202) {
        console.error('sms gateway rejected the send:', res.status, code);
        return { delivered: false };
      }
      return { delivered: true };
    }
  };
}

/** Development transport. Holds the last code per number in process memory so
 *  a local sign-in can be completed, and refuses to exist in production. */
export function devSmsSender(env = process.env) {
  if (env.NODE_ENV === 'production')
    throw new Error('the development SMS transport must never run in production');
  const inbox = new Map();
  return {
    name: 'dev',
    inbox,
    async send(phone, message) {
      inbox.set(phone, message);
      console.log(`[dev sms] a sign-in code was issued for ${phone}`);
      return { delivered: true };
    }
  };
}

/** Pick a transport. Credentials present means the real gateway; absent means
 *  development, which throws in production rather than pretending to send. */
export function smsSender(env = process.env) {
  if (env.SMS_API_KEY && env.SMS_SENDER_ID) return httpSmsSender(env);
  return devSmsSender(env);
}

export const otpMessage = (code, locale = 'bn') =>
  locale === 'en'
    ? `${code} is your CARDWORKS sign-in code. It expires in 5 minutes.`
    : `${code} আপনার CARDWORKS সাইন-ইন কোড। ৫ মিনিটের মধ্যে ব্যবহার করুন।`;

/* ── Claiming a browser's anonymous work ───────────────────────────────────
   This is the point of the whole subgroup and the part worth being careful
   about. Today a browser holds a random `owner_key` in localStorage and every
   design and order it made carries that string. Signing in has to carry that
   work onto the account, once, without letting a caller sweep up work that
   was never theirs.

   The abuse case is someone presenting an `owner_key` they did not mint. Four
   things bound it. First, possession of the key is already the whole of the
   anonymous authority — `/api/orders?list=1&owner=KEY` will list against it
   today — so a claim grants a thief nothing they could not already read, and
   the escalation to guard against is permanence, not access. Second, the
   claim is additive: the rows keep their `owner_key`, so the honest browser
   that still holds it is never locked out of its own designs, and a mistaken
   claim costs a user nothing. Third, a key can be claimed exactly once, ever,
   enforced by a unique index and an atomic ON CONFLICT rather than a
   read-then-write that two concurrent requests both win; a second user
   claiming the same key is refused, and re-claiming by the same user is a
   no-op success so a repeat sign-in on the same browser is harmless. Fourth,
   claims are rate-limited per account, because the shape of an attack here is
   one account hoovering up many keys, and ten a day is far above what an
   honest user with several devices ever needs.

   What this deliberately does not do is bind the key to the account for the
   future. The claim fixes the rows and the link that existed at that moment;
   it is not a standing authority, so a stolen key does not quietly redirect
   what the victim saves tomorrow.

   `design_specs` is append-only by Postgres trigger — an UPDATE raises — so
   designs cannot be stamped with a `user_id` after the fact and are resolved
   through the `owner_claims` link instead. `orders` has no such trigger and
   is backfilled directly, which keeps the order queries a single predicate. */

/** The decision, separated from the writing so the guard order is testable.
 *  `existingClaim` is the row already holding this key, or null. */
export function claimDecision({ ownerKey, userId, existingClaim = null, recentClaims = 0 }) {
  if (!OWNER_RE.test(String(ownerKey || '')))
    return { allow: false, reason: 'bad_owner_key' };
  if (!Number.isInteger(userId) || userId <= 0)
    return { allow: false, reason: 'no_session' };
  if (existingClaim && Number(existingClaim.user_id) === userId)
    return { allow: false, reason: 'already_claimed_by_you' };
  if (existingClaim)
    return { allow: false, reason: 'claimed_by_another' };
  if (recentClaims >= LIMITS.claimPerUser.limit)
    return { allow: false, reason: 'too_many_claims' };
  return { allow: true, reason: 'ok' };
}

/** Refusals in the house envelope. `already_claimed_by_you` is not an error to
 *  the caller — it is the idempotent repeat of a sign-in on the same browser. */
export function claimRefusal(reason) {
  switch (reason) {
    case 'bad_owner_key':
      return ERR.badRequest('That is not a valid device key.', { field: 'ownerKey' });
    case 'no_session':
      return ERR.unauthorized('Sign in before moving your saved work.', { remediation: 'sign_in' });
    case 'claimed_by_another':
      return ERR.conflict('That device key already belongs to another account.',
        { remediation: 'contact_support' });
    case 'too_many_claims':
      return ERR.rateLimited('Too many devices moved onto this account today. Try tomorrow.');
    default:
      return ERR.server();
  }
}

/** Claim `ownerKey` for `userId`. Returns a summary, never throws for a
 *  refusal — the caller turns `refused` into `claimRefusal(reason)`. */
export async function claimOwnerKey(sql, userId, ownerKey, opts = {}) {
  if (!OWNER_RE.test(String(ownerKey || '')))
    return { claimed: false, refused: 'bad_owner_key' };
  if (!Number.isInteger(userId) || userId <= 0)
    return { claimed: false, refused: 'no_session' };

  const recent = await sql`
    SELECT count(*)::int AS n FROM owner_claims
    WHERE user_id = ${userId}
      AND claimed_at > now() - make_interval(secs => ${LIMITS.claimPerUser.windowSeconds})`;
  if ((recent[0] ? recent[0].n : 0) >= LIMITS.claimPerUser.limit)
    return { claimed: false, refused: 'too_many_claims' };

  /* Atomic: the unique index on owner_key decides the winner, so two requests
     racing the same key cannot both believe they claimed it. A read-then-write
     here would let both through under concurrency. */
  const won = await sql`
    INSERT INTO owner_claims (owner_key, user_id, claimed_ip)
    VALUES (${ownerKey}, ${userId}, ${opts.ip || null})
    ON CONFLICT (owner_key) DO NOTHING
    RETURNING user_id`;

  if (!won.length) {
    const held = await sql`SELECT user_id FROM owner_claims WHERE owner_key = ${ownerKey} LIMIT 1`;
    const holder = held.length ? Number(held[0].user_id) : null;
    if (holder === userId) return { claimed: false, alreadyMine: true, designs: 0, orders: 0 };
    return { claimed: false, refused: 'claimed_by_another' };
  }

  const orders = await sql`
    UPDATE orders SET user_id = ${userId}
    WHERE owner_key = ${ownerKey} AND user_id IS NULL
    RETURNING ref`;
  const designs = await sql`
    SELECT count(*)::int AS n FROM design_specs WHERE owner_key = ${ownerKey}`;

  return { claimed: true, designs: designs[0] ? designs[0].n : 0, orders: orders.length };
}

/* ── Users ─────────────────────────────────────────────────────────────────
   Identifiers come from the table's own sequence. Technical Design §5.2 makes
   the point that anywhere an identifier is derived rather than sequence-
   generated is a latent version of the order-reference collision, and a user
   id is no exception. */

/** Find the account for a phone or create it. Race-safe by the unique index:
 *  the loser of a concurrent insert reads the winner's row rather than
 *  failing, which is what happens when two tabs verify the same code. */
export async function upsertUser(sql, phone, { name = null, locale = null } = {}) {
  const rows = await sql`
    INSERT INTO users (phone, name, locale)
    VALUES (${phone}, ${name}, ${locale || 'bn'})
    ON CONFLICT (phone) DO NOTHING
    RETURNING id, phone, name, locale, created_at`;
  if (rows.length) return { user: rows[0], created: true };
  const found = await sql`
    SELECT id, phone, name, locale, created_at FROM users WHERE phone = ${phone} LIMIT 1`;
  return { user: found[0], created: false };
}
