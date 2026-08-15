/* Sign in with a mobile number.
 *
 * PRD Epic G asks for a lightweight account — phone number, no KYC — so that
 * saved designs and order history survive a cleared browser or a new handset.
 * This endpoint is the whole of it: ask for a code, prove you received it,
 * receive a session, and bring your browser's anonymous work with you.
 *
 * Four actions on one path, because they are one flow and splitting them
 * across four functions would only duplicate the rate limiter. The mechanics
 * — token format, code hashing, limits, and the reasoning behind the claim —
 * live in lib/auth.mjs so the other endpoints can import the verifier without
 * importing a Netlify function.
 *
 * Anonymous use is untouched. Technical Design §9 keeps offline-tolerant
 * briefing and the URL-hash share working after login exists, so nothing here
 * is a precondition for briefing, previewing or saving a design.
 */
import {
  handler, ok, ERR, readJson, db, OWNER_RE, normalisePhone,
  idempotencyKey, replay, remember
} from '../../lib/http.mjs';
import {
  authSecret, signSession, authenticate, sessionFrom, issueOtp, consumeOtp,
  rateCheck, rateRecord, clientIp, upsertUser, claimOwnerKey, claimRefusal,
  LIMITS, OTP_TTL
} from '../../lib/auth.mjs';

/* One refusal for every way a code can fail to work. A caller who is told
   "no account for that number" has been handed a registration oracle, and a
   caller told "expired" rather than "wrong" learns which half to attack. This
   is honest — it says the code did not work and offers the next step — while
   telling a stranger nothing about who banks with us. */
const BAD_CODE = () => ERR.unauthorized(
  'That code is wrong or has expired. Ask for a new one.',
  { field: 'code', remediation: 'request_new_code' });

const tooMany = (retryAfter) => {
  const res = ERR.rateLimited(
    `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${retryAfter > 90 ? 's' : ''}.`,
    { remediation: 'wait' });
  res.headers.set('retry-after', String(retryAfter));
  return res;
};

const publicUser = (u) => ({
  id: Number(u.id), phone: u.phone, name: u.name || null,
  locale: u.locale || 'bn', createdAt: u.created_at
});

export default handler('auth', async (req) => {
  const sql = db();
  if (!sql) return ERR.unavailable();
  if (!authSecret()) return ERR.unavailable('Accounts are not configured for this deploy.');

  const ip = clientIp(req);

  /* ── who am I ──
     Anonymous is an answer, not an error: the shell calls this on load to
     decide whether to show "My designs" against an account or against the
     browser key, and a 401 there would turn an ordinary visit into an error
     state on a screen that works fine without an account. */
  if (req.method === 'GET') {
    const s = sessionFrom(req);
    if (!s) return ok({ user: null });
    const rows = await sql`
      SELECT u.id, u.phone, u.name, u.locale, u.created_at
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.jti = ${s.jti} AND s.revoked_at IS NULL AND s.expires_at > now()
      LIMIT 1`;
    return ok({ user: rows.length ? publicUser(rows[0]) : null });
  }

  if (req.method !== 'POST') return ERR.badRequest('Use GET or POST.');

  const [body, bad] = await readJson(req, 8 * 1024);
  if (bad) return bad;
  const action = String(body.action || '');

  /* ── ask for a code ── */
  if (action === 'request') {
    const phone = normalisePhone(body.phone);
    if (!phone) return ERR.badRequest(
      'Enter a Bangladeshi mobile number, like 01712345678.',
      { field: 'phone', remediation: 'fix_phone' });

    /* The replay check comes before the limiter on purpose: a caller retrying
       a request whose reply was lost is one request, and charging it twice
       against a three-per-window budget would lock out the very person the
       retry is for. */
    const key = idempotencyKey(req);
    const replayed = await replay(sql, key, 'auth.request');
    if (replayed) return replayed;

    /* Both ends, both keys. The per-phone limit stops one number being
       flooded with texts we pay for; the per-IP limit stops one host walking
       the number space to find out who has an account. Whichever trips first
       answers, and the lockout lasts the rest of the window rather than
       merely slowing the next attempt down. */
    for (const [bucket, rule] of [[`phone:${phone}`, LIMITS.requestPerPhone],
                                  [`ip:${ip}`,       LIMITS.requestPerIp]]) {
      const v = await rateCheck(sql, bucket + ':request', rule);
      if (!v.allowed) return tooMany(v.retryAfter);
    }
    await rateRecord(sql, `phone:${phone}:request`, 'request');
    await rateRecord(sql, `ip:${ip}:request`, 'request');

    /* Minting, hashing and sending all happen inside lib/auth.mjs, which is
       what keeps the plaintext code out of this scope entirely — there is no
       variable here that could accidentally end up in a response or a log. */
    const locale = body.locale === 'en' ? 'en' : 'bn';
    const sent = await issueOtp(sql, phone, { ip, locale });
    if (!sent.sent)
      return ERR.unavailable('We could not send the code just now. Try again in a moment.',
        { remediation: 'retry' });

    /* Identical whether or not that number has ever been seen. */
    const out = { status: 'sent', expiresIn: OTP_TTL, digits: 6 };
    await remember(sql, key, 'auth.request', 202, out);
    return ok(out, 202);
  }

  /* ── prove it, and sign in ── */
  if (action === 'verify') {
    const phone = normalisePhone(body.phone);
    if (!phone) return ERR.badRequest(
      'Enter a Bangladeshi mobile number, like 01712345678.',
      { field: 'phone', remediation: 'fix_phone' });

    for (const [bucket, rule] of [[`phone:${phone}`, LIMITS.verifyPerPhone],
                                  [`ip:${ip}`,       LIMITS.verifyPerIp]]) {
      const v = await rateCheck(sql, bucket + ':verify', rule);
      if (!v.allowed) return tooMany(v.retryAfter);
    }
    await rateRecord(sql, `phone:${phone}:verify`, 'verify');
    await rateRecord(sql, `ip:${ip}:verify`, 'verify');

    /* Wrong, expired, already spent and never issued are four different
       reasons and one answer. consumeOtp reports which for the sake of the
       tests; the caller never forwards it. */
    const spent = await consumeOtp(sql, phone, body.code);
    if (!spent.ok) return BAD_CODE();

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) || null : null;
    const locale = body.locale === 'en' ? 'en' : 'bn';
    const { user, created } = await upsertUser(sql, phone, { name, locale });

    const s = signSession({ userId: Number(user.id), phone });
    await sql`
      INSERT INTO auth_sessions (jti, user_id, user_agent, issued_ip, expires_at)
      VALUES (${s.jti}, ${Number(user.id)},
              ${(req.headers.get('user-agent') || '').slice(0, 200) || null}, ${ip},
              ${s.expiresAt}::timestamptz)`;

    /* Bring this browser's anonymous work along. A refused claim does not
       refuse the sign-in: someone whose device key was already claimed still
       has every right to their account, and holding their login hostage to a
       migration detail would be the wrong trade. The outcome is reported so
       the shell can say what moved, or say honestly that nothing did. */
    let claim = { attempted: false };
    if (body.ownerKey && OWNER_RE.test(String(body.ownerKey))) {
      const r = await claimOwnerKey(sql, Number(user.id), String(body.ownerKey), { ip });
      claim = r.claimed      ? { attempted: true, moved: true, designs: r.designs, orders: r.orders }
            : r.alreadyMine  ? { attempted: true, moved: false, reason: 'already_yours' }
                             : { attempted: true, moved: false, reason: r.refused };
    }

    if (created)
      await sql`INSERT INTO usage_events (type, meta) VALUES ('auth.signup', ${JSON.stringify({ locale })}::jsonb)`;

    /* Deliberately outside the idempotency ledger, unlike the other mutating
       calls. Replay stores the response body verbatim for 24 hours, and this
       body carries a bearer token — a retry that is convenient is not worth
       parking live credentials in a queryable table. A retried verify fails
       closed instead, because the code is single-use, and the caller asks for
       a new code. */
    return ok({
      token: s.token, expiresAt: s.expiresAt, expiresIn: s.expiresIn,
      user: publicUser(user), created, claim
    }, 201);
  }

  /* ── move a second browser's work onto an account already signed in ── */
  if (action === 'claim') {
    const [user, err] = await authenticate(req, sql);
    if (err) return err;

    const key = idempotencyKey(req);
    const replayed = await replay(sql, key, 'auth.claim');
    if (replayed) return replayed;

    const r = await claimOwnerKey(sql, user.userId, String(body.ownerKey || ''), { ip });
    if (r.refused) return claimRefusal(r.refused);

    const out = r.alreadyMine
      ? { moved: false, reason: 'already_yours', designs: 0, orders: 0 }
      : { moved: true, designs: r.designs, orders: r.orders };
    await remember(sql, key, 'auth.claim', 200, out);
    return ok(out);
  }

  /* ── sign out ──
     The token stays valid by signature until it expires; what ends it is the
     revoked_at on its row, which is the reason a self-contained token still
     gets a database record. Callers that skip the `sql` argument to
     authenticate() will not see the revocation, which is the documented cost
     of that fast path. */
  if (action === 'logout') {
    const [user, err] = await authenticate(req, sql);
    if (err) return err;
    await sql`UPDATE auth_sessions SET revoked_at = now()
              WHERE jti = ${user.jti} AND revoked_at IS NULL`;
    return ok({ signedOut: true });
  }

  return ERR.badRequest('Unknown action.', { field: 'action' });
});

export const config = { path: '/api/auth' };
