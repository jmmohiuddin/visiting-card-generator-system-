/* Headless verification of phone-based accounts (PRD Epic G).
   Run with: node tests/auth.test.mjs

   The happy path here is one assertion out of many. What this file is really
   for is the properties that stop being true the moment someone edits the
   flow without thinking: a code works exactly once, an expired or forged
   session is refused, the claim cannot take another browser's work, and no
   code or token ever reaches a log line.

   Postgres is stood in for by an in-memory fake that matches on query text
   and evaluates the same predicates the real statements do — enough to make
   single-use, expiry and the ON CONFLICT race real rather than mocked away. */

process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'test-signing-key-that-is-long-enough-0123456789';
process.env.OTP_PEPPER  = 'test-otp-pepper-0123456789abcdef';
delete process.env.SMS_API_KEY;
delete process.env.SMS_SENDER_ID;

const A = await import('../lib/auth.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✓ ' + name))
                                              : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))); };
const H = s => console.log('\n' + s);

/* ── the fake database ─────────────────────────────────────────────────── */
function makeDb() {
  const S = {
    now: Date.UTC(2026, 0, 1, 9, 0, 0),
    users: [], otps: [], sessions: [], attempts: [], claims: [], orders: [], designs: [],
    seq: { users: 0, otps: 0, claims: 0 }
  };
  const N = () => S.now;

  const sql = (strings, ...v) => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    const rows = run(q, v);
    return Promise.resolve(rows);
  };
  sql.state = S;
  sql.advance = (seconds) => { S.now += seconds * 1000; };

  function run(q, v) {
    // ── auth_otps ──
    if (/^UPDATE auth_otps SET consumed_at = now\(\) WHERE phone/.test(q)) {
      for (const o of S.otps) if (o.phone === v[0] && o.consumed_at == null) o.consumed_at = N();
      return [];
    }
    if (/^INSERT INTO auth_otps/.test(q)) {
      S.otps.push({ id: ++S.seq.otps, phone: v[0], code_hash: v[1], attempts: 0,
                    max_attempts: v[2], request_ip: v[3], consumed_at: null,
                    expires_at: N() + v[4] * 1000, created_at: N() + S.otps.length });
      return [];
    }
    if (/^SELECT id, code_hash FROM auth_otps/.test(q)) {
      const live = S.otps.filter(o => o.phone === v[0] && o.consumed_at == null && o.expires_at > N())
                         .sort((a, b) => b.created_at - a.created_at);
      return live.slice(0, 1).map(o => ({ id: o.id, code_hash: o.code_hash }));
    }
    if (/^UPDATE auth_otps SET attempts = attempts \+ 1/.test(q)) {
      const o = S.otps.find(x => x.id === v[0]);
      if (o) { o.attempts += 1; if (o.attempts >= o.max_attempts) o.consumed_at = N(); }
      return [];
    }
    if (/^UPDATE auth_otps SET consumed_at = now\(\) WHERE id/.test(q)) {
      const o = S.otps.find(x => x.id === v[0]);
      if (!o || o.consumed_at != null) return [];
      o.consumed_at = N();
      return [{ id: o.id }];
    }
    // ── rate ledger ──
    if (/FROM auth_attempts/.test(q)) {
      const cut = N() - v[1] * 1000;
      const hits = S.attempts.filter(a => a.bucket === v[0] && a.created_at > cut);
      const oldest = hits.length ? Math.min(...hits.map(h => h.created_at)) : 0;
      return [{ n: hits.length, oldest_ms: oldest ? N() - oldest : 0 }];
    }
    if (/^INSERT INTO auth_attempts/.test(q)) {
      S.attempts.push({ bucket: v[0], kind: v[1], created_at: N() });
      return [];
    }
    // ── sessions ──
    if (/^SELECT 1 FROM auth_sessions WHERE jti/.test(q)) {
      const s = S.sessions.find(x => x.jti === v[0] && x.revoked_at == null && x.expires_at > N());
      return s ? [{ '?column?': 1 }] : [];
    }
    // ── users ──
    if (/^INSERT INTO users/.test(q)) {
      if (S.users.some(u => u.phone === v[0])) return [];
      const u = { id: ++S.seq.users, phone: v[0], name: v[1], locale: v[2],
                  created_at: new Date(N()).toISOString() };
      S.users.push(u);
      return [{ ...u }];
    }
    if (/FROM users WHERE phone/.test(q)) {
      return S.users.filter(u => u.phone === v[0]).map(u => ({ ...u }));
    }
    // ── claims ──
    if (/FROM owner_claims WHERE user_id/.test(q)) {
      const cut = N() - v[1] * 1000;
      return [{ n: S.claims.filter(c => c.user_id === v[0] && c.claimed_at > cut).length }];
    }
    if (/^INSERT INTO owner_claims/.test(q)) {
      if (S.claims.some(c => c.owner_key === v[0])) return [];
      S.claims.push({ id: ++S.seq.claims, owner_key: v[0], user_id: v[1],
                      claimed_ip: v[2], claimed_at: N() });
      return [{ user_id: v[1] }];
    }
    if (/^SELECT user_id FROM owner_claims WHERE owner_key/.test(q)) {
      return S.claims.filter(c => c.owner_key === v[0]).map(c => ({ user_id: c.user_id }));
    }
    if (/^UPDATE orders SET user_id/.test(q)) {
      const hit = S.orders.filter(o => o.owner_key === v[1] && o.user_id == null);
      for (const o of hit) o.user_id = v[0];
      return hit.map(o => ({ ref: o.ref }));
    }
    if (/FROM design_specs WHERE owner_key/.test(q)) {
      return [{ n: S.designs.filter(d => d.owner_key === v[0]).length }];
    }
    throw new Error('the fake database has no rule for: ' + q.slice(0, 90));
  }
  return sql;
}

/* A dev SMS transport whose inbox the test reads, standing in for a handset. */
const inboxSender = () => {
  const inbox = new Map();
  return { name: 'test', inbox, async send(phone, msg) { inbox.set(phone, msg); return { delivered: true }; } };
};
const codeOf = (sender, phone) => (/(\d{6})/.exec(sender.inbox.get(phone) || '') || [])[1];

const req = (headers = {}) => new Request('https://cardworks.test/api/auth', { headers });
const bearer = (t) => req({ authorization: 'Bearer ' + t });
const PHONE = '+8801712345678';

/* ── 1. Phone normalisation ────────────────────────────────────────────── */
H('1. Phone normalisation (BD mobile numbers only)');
for (const raw of ['01712345678', '8801712345678', '+8801712345678', '+880 1712-345678',
                   ' 01712 345 678 ', '০'.length ? '01712345678' : ''])
  ok(`accepts ${JSON.stringify(raw)}`, A.normalisePhone(raw) === PHONE, String(A.normalisePhone(raw)));
ok('accepts every live operator prefix 013–019',
   ['013', '014', '015', '016', '017', '018', '019']
     .every(p => A.normalisePhone(p + '12345678') === '+88' + p + '12345678'));
for (const raw of ['01112345678', '01212345678', '0171234567', '017123456789',
                   '', null, undefined, 'not a phone', '+919812345678', '1712345678'])
  ok(`rejects ${JSON.stringify(raw)}`, A.normalisePhone(raw) === null, String(A.normalisePhone(raw)));

/* ── 2. Sessions ───────────────────────────────────────────────────────── */
H('2. Sessions are signed, expiring, and unforgeable');
const s1 = A.signSession({ userId: 7, phone: PHONE });
const v1 = A.verifySessionToken(s1.token);
ok('a freshly signed token verifies', v1.ok === true, v1.reason);
ok('it carries the user id and phone back', v1.ok && v1.user.userId === 7 && v1.user.phone === PHONE);
ok('it carries a jti so the session can be revoked', v1.ok && typeof v1.user.jti === 'string' && v1.user.jti.length > 8);
ok('the token is opaque: it is not the phone number in disguise', !s1.token.includes(PHONE));

const flip = (t, i) => { const c = t.split(''); c[i] = c[i] === 'A' ? 'B' : 'A'; return c.join(''); };
ok('a flipped signature byte is rejected',
   A.verifySessionToken(flip(s1.token, s1.token.length - 3)).reason === 'bad_signature');
const [ver, payload, sig] = s1.token.split('.');
const forgedPayload = Buffer.from(JSON.stringify({ u: 99, p: PHONE, j: 'x', iat: 1, exp: 2 ** 31 })).toString('base64url');
ok('a re-written payload is rejected even though it is well-formed',
   A.verifySessionToken(`${ver}.${forgedPayload}.${sig}`).reason === 'bad_signature');
ok('a token signed with another key is rejected',
   A.verifySessionToken(A.signSession({ userId: 7, phone: PHONE }, { secret: 'a'.repeat(40) }).token).reason === 'bad_signature');
ok('an expired token is rejected',
   A.verifySessionToken(s1.token, { now: Date.now() + (A.SESSION_TTL + 60) * 1000 }).reason === 'expired');
ok('a token still inside its window is accepted',
   A.verifySessionToken(s1.token, { now: Date.now() + (A.SESSION_TTL - 60) * 1000 }).ok === true);
for (const junk of ['', 'x', 'v1.a', 'v2.' + payload + '.' + sig, 'v1..', 'v1.$$.' + sig, null, 42])
  ok(`malformed token ${JSON.stringify(junk)} is rejected`, A.verifySessionToken(junk).ok === false);
ok('a token 5KB long is rejected without being parsed',
   A.verifySessionToken('v1.' + 'a'.repeat(5000) + '.b').reason === 'malformed');

ok('safeEqual is true for equal strings and false for unequal lengths',
   A.safeEqual('abc', 'abc') === true && A.safeEqual('abc', 'abcd') === false && A.safeEqual('abc', 'abd') === false);

H('3. Reading a session off a request');
ok('sessionFrom(no header) is null, not an error', A.sessionFrom(req()) === null);
ok('sessionFrom(garbage) is null', A.sessionFrom(bearer('nonsense')) === null);
ok('sessionFrom(valid) yields { userId, phone }', (() => {
  const u = A.sessionFrom(bearer(s1.token));
  return u && u.userId === 7 && u.phone === PHONE;
})());
ok('a non-Bearer Authorization header is ignored',
   A.sessionFrom(req({ authorization: 'Basic ' + s1.token })) === null);

const [noUser, noErr] = await A.authenticate(req());
ok('authenticate() with no header refuses', noUser === null && noErr instanceof Response && noErr.status === 401);
ok('the refusal uses the house error envelope', await (async () => {
  const b = await noErr.clone().json();
  return b.error && b.error.code === 'unauthorized' && typeof b.error.message === 'string' && b.error.remediation === 'sign_in';
})());
const [gotUser, gotErr] = await A.authenticate(bearer(s1.token));
ok('authenticate() with a good token yields the user and no error',
   gotErr === null && gotUser.userId === 7 && gotUser.phone === PHONE);
const [expUser, expErr] = await A.authenticate(bearer(A.signSession({ userId: 7, phone: PHONE }, { ttlSeconds: 1, now: Date.now() - 10000 }).token));
ok('authenticate() refuses an expired token', expUser === null && expErr.status === 401);

const dbS = makeDb();
dbS.state.sessions.push({ jti: s1.jti, user_id: 7, revoked_at: null, expires_at: dbS.state.now + 1e9 });
const [liveUser] = await A.authenticate(bearer(s1.token), dbS);
ok('authenticate(req, sql) accepts a session whose row is live', liveUser && liveUser.userId === 7);
dbS.state.sessions[0].revoked_at = dbS.state.now;
const [revUser, revErr] = await A.authenticate(bearer(s1.token), dbS);
ok('authenticate(req, sql) refuses a revoked session even though the signature is good',
   revUser === null && revErr.status === 401);
const [unkUser] = await A.authenticate(bearer(A.signSession({ userId: 7, phone: PHONE }).token), dbS);
ok('a session with no row at all is refused under the sql check', unkUser === null);

/* ── 4. One-time codes ─────────────────────────────────────────────────── */
H('4. One-time codes are single-use, short-lived and stored hashed');
{
  const sql = makeDb(), sender = inboxSender();
  const issued = await A.issueOtp(sql, PHONE, { ip: '1.1.1.1', sender });
  const code = codeOf(sender, PHONE);
  ok('issueOtp sends a six-digit code', issued.sent === true && /^\d{6}$/.test(code || ''));
  ok('the code never appears in the return value', !JSON.stringify(issued).includes(code));
  ok('the code is stored hashed, never in plaintext',
     sql.state.otps.length === 1 && !JSON.stringify(sql.state.otps).includes(code));
  ok('the stored hash is a keyed digest, not the code with a wrapper',
     sql.state.otps[0].code_hash === A.hashOtp(PHONE, code) && sql.state.otps[0].code_hash.length === 64);
  ok('the same code for a different number hashes differently',
     A.hashOtp(PHONE, code) !== A.hashOtp('+8801812345678', code));

  const first = await A.consumeOtp(sql, PHONE, code);
  ok('the right code is accepted once', first.ok === true);
  const second = await A.consumeOtp(sql, PHONE, code);
  ok('the same code a second time is refused (single use)', second.ok === false && second.reason === 'no_live_code');
}
{
  const sql = makeDb(), sender = inboxSender();
  await A.issueOtp(sql, PHONE, { sender });
  const code = codeOf(sender, PHONE);
  sql.advance(A.OTP_TTL + 30);
  const r = await A.consumeOtp(sql, PHONE, code);
  ok('a code past its five minutes is refused', r.ok === false && r.reason === 'no_live_code');
}
{
  const sql = makeDb(), sender = inboxSender();
  await A.issueOtp(sql, PHONE, { sender });
  const code = codeOf(sender, PHONE);
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  let refusals = 0;
  for (let i = 0; i < A.OTP_MAX_ATTEMPTS; i++) {
    const r = await A.consumeOtp(sql, PHONE, wrong);
    if (!r.ok && r.reason === 'wrong') refusals++;
  }
  ok(`${A.OTP_MAX_ATTEMPTS} wrong guesses are each refused`, refusals === A.OTP_MAX_ATTEMPTS);
  const after = await A.consumeOtp(sql, PHONE, code);
  ok('the code is burned once its guesses are spent, so even the right code fails',
     after.ok === false && after.reason === 'no_live_code');
}
{
  const sql = makeDb(), sender = inboxSender();
  await A.issueOtp(sql, PHONE, { sender });
  const older = codeOf(sender, PHONE);
  await A.issueOtp(sql, PHONE, { sender });
  const newer = codeOf(sender, PHONE);
  ok('two requests mint two different codes', older !== newer);
  const stale = await A.consumeOtp(sql, PHONE, older);
  ok('asking for a new code retires the previous one', stale.ok === false);
  ok('the newest code still works', (await A.consumeOtp(sql, PHONE, newer)).ok === true);
}
{
  const sql = makeDb();
  for (const junk of ['', '12345', '1234567', 'abcdef', '12 34 56', null, undefined, '000000000'])
    ok(`a code shaped like ${JSON.stringify(junk)} is refused before any lookup`,
       (await A.consumeOtp(sql, PHONE, junk)).reason === 'malformed');
  const sender = inboxSender();
  await A.issueOtp(sql, PHONE, { sender });
  ok('a code issued for one number does not work for another',
     (await A.consumeOtp(sql, '+8801812345678', codeOf(sender, PHONE))).ok === false);
}
{
  const draws = new Set();
  for (let i = 0; i < 3000; i++) draws.add(A.generateOtp());
  ok('generateOtp is six digits and genuinely random, not a counter or a constant',
     draws.size > 2900 && [...draws].every(d => /^\d{6}$/.test(d)));
}
{
  const sql = makeDb();
  const failing = { async send() { return { delivered: false }; } };
  const r = await A.issueOtp(sql, PHONE, { sender: failing });
  ok('a failed send retires the code rather than leaving a live one nobody received',
     r.sent === false && sql.state.otps.every(o => o.consumed_at != null));
}

/* ── 5. Rate limiting ──────────────────────────────────────────────────── */
H('5. Rate limiting, per phone and per IP, with a lockout');
ok('rateVerdict allows below the limit', A.rateVerdict({ count: 2, limit: 3, windowSeconds: 900 }).allowed === true);
ok('rateVerdict refuses at the limit', A.rateVerdict({ count: 3, limit: 3, windowSeconds: 900 }).allowed === false);
ok('a refusal carries a retry-after inside the window',
   A.rateVerdict({ count: 3, limit: 3, windowSeconds: 900, oldestMs: 60000 }).retryAfter === 840);
{
  const sql = makeDb();
  const rule = A.LIMITS.requestPerPhone;
  let allowed = 0;
  for (let i = 0; i < rule.limit + 2; i++) {
    const v = await A.rateCheck(sql, `phone:${PHONE}:request`, rule);
    if (v.allowed) { allowed++; await A.rateRecord(sql, `phone:${PHONE}:request`, 'request'); }
  }
  ok(`only ${rule.limit} code requests per phone get through the window`, allowed === rule.limit);
  ok('the lockout persists for the rest of the window, it does not merely throttle',
     (await A.rateCheck(sql, `phone:${PHONE}:request`, rule)).allowed === false);
  ok('a different number is unaffected by that phone lockout',
     (await A.rateCheck(sql, 'phone:+8801812345678:request', rule)).allowed === true);
  ok('the IP bucket is counted separately from the phone bucket',
     (await A.rateCheck(sql, 'ip:1.1.1.1:request', A.LIMITS.requestPerIp)).allowed === true);
  sql.advance(rule.windowSeconds + 1);
  ok('once the window has passed the number can ask again',
     (await A.rateCheck(sql, `phone:${PHONE}:request`, rule)).allowed === true);
}
{
  const sql = makeDb();
  const rule = A.LIMITS.verifyPerIp;
  for (let i = 0; i < rule.limit; i++) await A.rateRecord(sql, 'ip:9.9.9.9:verify', 'verify');
  ok('the verify end is limited too, not only the request end',
     (await A.rateCheck(sql, 'ip:9.9.9.9:verify', rule)).allowed === false);
}
ok('clientIp prefers the Netlify header over a spoofable forwarded-for',
   A.clientIp(req({ 'x-nf-client-connection-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' })) === '203.0.113.9');
ok('clientIp takes only the first hop of x-forwarded-for',
   A.clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' })) === '203.0.113.9');
ok('clientIp with nothing to go on is a bucket, not a crash', A.clientIp(req()) === 'unknown');

/* ── 6. Claiming a browser's anonymous work ────────────────────────────── */
H("6. The claim carries anonymous work over — and cannot take anyone else's");
const KEY = 'brw_9f2a41c8d3e7b6a5';
const OTHER_KEY = 'brw_0000111122223333';

ok('claimDecision refuses a key that is not a valid owner key',
   A.claimDecision({ ownerKey: 'short', userId: 1 }).reason === 'bad_owner_key');
ok('claimDecision refuses without a session',
   A.claimDecision({ ownerKey: KEY, userId: 0 }).reason === 'no_session');
ok('claimDecision allows a free key', A.claimDecision({ ownerKey: KEY, userId: 1 }).allow === true);
ok('claimDecision treats a repeat by the same user as already-yours, not a failure',
   A.claimDecision({ ownerKey: KEY, userId: 1, existingClaim: { user_id: 1 } }).reason === 'already_claimed_by_you');
ok("claimDecision refuses another account's key",
   A.claimDecision({ ownerKey: KEY, userId: 2, existingClaim: { user_id: 1 } }).reason === 'claimed_by_another');
ok('claimDecision refuses once the per-account daily cap is reached',
   A.claimDecision({ ownerKey: KEY, userId: 1, recentClaims: A.LIMITS.claimPerUser.limit }).reason === 'too_many_claims');
ok('every refusal maps to the house error envelope with a real status',
   ['bad_owner_key', 'no_session', 'claimed_by_another', 'too_many_claims']
     .map(r => A.claimRefusal(r).status).join(',') === '400,401,409,429');

{
  const sql = makeDb();
  const { user: victim } = await A.upsertUser(sql, PHONE);
  const { user: thief } = await A.upsertUser(sql, '+8801812345678');
  ok('upsertUser mints an id from the sequence, not from a row count',
     Number(victim.id) === 1 && Number(thief.id) === 2);
  ok('upsertUser is idempotent for a number that already has an account',
     (await A.upsertUser(sql, PHONE)).created === false);

  sql.state.designs.push({ short_code: 'aaaa1111', owner_key: KEY },
                         { short_code: 'bbbb2222', owner_key: KEY },
                         { short_code: 'cccc3333', owner_key: OTHER_KEY });
  sql.state.orders.push({ ref: 'ORD-02201', owner_key: KEY, user_id: null },
                        { ref: 'ORD-02202', owner_key: KEY, user_id: null },
                        { ref: 'ORD-02203', owner_key: OTHER_KEY, user_id: null });

  const first = await A.claimOwnerKey(sql, Number(victim.id), KEY, { ip: '1.1.1.1' });
  ok('signing in moves this browser\'s designs and orders onto the account',
     first.claimed === true && first.designs === 2 && first.orders === 2);
  ok('the orders now carry the account',
     sql.state.orders.filter(o => o.user_id === Number(victim.id)).length === 2);
  ok('another key\'s work is untouched',
     sql.state.orders.find(o => o.ref === 'ORD-02203').user_id === null);
  ok('the owner_key stays on the rows, so the anonymous browser still lists its own work',
     sql.state.orders.filter(o => o.owner_key === KEY).length === 2 &&
     sql.state.designs.filter(d => d.owner_key === KEY).length === 2);

  const again = await A.claimOwnerKey(sql, Number(victim.id), KEY);
  ok('the same user signing in again on the same browser is a no-op, not an error',
     again.claimed === false && again.alreadyMine === true && !again.refused);
  ok('a repeat claim does not add a second claim row', sql.state.claims.length === 1);

  const stolen = await A.claimOwnerKey(sql, Number(thief.id), KEY, { ip: '6.6.6.6' });
  ok('a second account presenting the same device key is refused',
     stolen.claimed === false && stolen.refused === 'claimed_by_another');
  ok('the refused claim moved nothing: the orders still belong to the first account',
     sql.state.orders.filter(o => o.user_id === Number(thief.id)).length === 0 &&
     sql.state.orders.filter(o => o.user_id === Number(victim.id)).length === 2);
  ok('a key can be claimed exactly once, ever', sql.state.claims.filter(c => c.owner_key === KEY).length === 1);

  for (const bad of ['', 'tiny', 'has spaces here', 'a'.repeat(65), null, undefined, {}, 'key;DROP TABLE'])
    ok(`a claim of ${JSON.stringify(String(bad))} is refused before touching the tables`,
       (await A.claimOwnerKey(sql, Number(victim.id), bad)).refused === 'bad_owner_key');
  ok('a claim without a real user id is refused',
     (await A.claimOwnerKey(sql, 0, KEY)).refused === 'no_session');
}
{
  const sql = makeDb();
  const { user } = await A.upsertUser(sql, PHONE);
  let claimed = 0;
  for (let i = 0; i < A.LIMITS.claimPerUser.limit + 3; i++) {
    const r = await A.claimOwnerKey(sql, Number(user.id), 'brw_' + String(i).padStart(14, '0'));
    if (r.claimed) claimed++;
  }
  ok(`one account cannot hoover up more than ${A.LIMITS.claimPerUser.limit} device keys a day`,
     claimed === A.LIMITS.claimPerUser.limit);
  sql.advance(A.LIMITS.claimPerUser.windowSeconds + 1);
  ok('the cap is a daily window, not a permanent ceiling',
     (await A.claimOwnerKey(sql, Number(user.id), 'brw_99999999999999')).claimed === true);
}
{
  const sql = makeDb();
  const { user: a } = await A.upsertUser(sql, PHONE);
  const { user: b } = await A.upsertUser(sql, '+8801812345678');
  const [ra, rb] = await Promise.all([
    A.claimOwnerKey(sql, Number(a.id), KEY),
    A.claimOwnerKey(sql, Number(b.id), KEY)
  ]);
  ok('two accounts racing the same key: exactly one wins, the other is refused',
     [ra, rb].filter(r => r.claimed).length === 1 && [ra, rb].filter(r => r.refused).length === 1);
  ok('the race leaves one claim row, not two', sql.state.claims.length === 1);
}

/* ── 7. SMS transport ──────────────────────────────────────────────────── */
H('7. SMS delivery is an interface, and the development stand-in stays out of production');
ok('with no gateway credentials the sender is the development transport',
   A.smsSender({ NODE_ENV: 'test' }).name === 'dev');
ok('with gateway credentials the sender is the real HTTP one',
   A.smsSender({ SMS_API_KEY: 'k', SMS_SENDER_ID: 's' }).name === 'http');
ok('the development transport refuses to exist under NODE_ENV=production', (() => {
  try { A.devSmsSender({ NODE_ENV: 'production' }); return false; } catch { return true; }
})());
ok('the real transport is still selected in production when credentials are set',
   A.smsSender({ NODE_ENV: 'production', SMS_API_KEY: 'k', SMS_SENDER_ID: 's' }).name === 'http');
ok('the Bangla message is the default and carries the code',
   A.otpMessage('123456').includes('123456') && /[ঀ-৿]/.test(A.otpMessage('123456')));
ok('an English message is available for the language toggle',
   A.otpMessage('123456', 'en').includes('123456') && /sign-in code/.test(A.otpMessage('123456', 'en')));

/* ── 8. Nothing logs a code or a token ─────────────────────────────────── */
H('8. No code and no token ever reaches a log line');
{
  const captured = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real))
    console[k] = (...args) => captured.push(args.map(a => (a && a.stack) || String(a)).join(' '));

  const sql = makeDb(), sender = inboxSender();
  await A.issueOtp(sql, PHONE, { ip: '1.1.1.1', sender });
  const code = codeOf(sender, PHONE);
  await A.consumeOtp(sql, PHONE, String((Number(code) + 7) % 1000000).padStart(6, '0'));
  await A.consumeOtp(sql, PHONE, code);
  const { user } = await A.upsertUser(sql, PHONE);
  const sess = A.signSession({ userId: Number(user.id), phone: PHONE });
  await A.authenticate(bearer(sess.token));
  await A.authenticate(bearer('v1.forged.forged'));
  await A.claimOwnerKey(sql, Number(user.id), KEY);
  // The development transport is the one most likely to be careless, so run it too.
  await A.devSmsSender({ NODE_ENV: 'test' }).send(PHONE, A.otpMessage('424242'));

  for (const k of Object.keys(real)) console[k] = real[k];
  const log = captured.join('\n');
  ok('the one-time code appears nowhere in the captured output', !log.includes(code), log.slice(0, 200));
  ok('the code hash appears nowhere either', !log.includes(A.hashOtp(PHONE, code)));
  ok('the session token appears nowhere in the captured output', !log.includes(sess.token));
  ok('the message body handed to the transport is not logged', !log.includes('424242'));
  ok('what is logged is only the fact of a send', captured.every(l => !/\b\d{6}\b/.test(l)), log.slice(0, 200));
}

/* ── 9. Anonymous use is not broken ────────────────────────────────────── */
H('9. Anonymous use survives (Technical Design §9)');
ok('an unauthenticated request reads as anonymous rather than as an error',
   A.sessionFrom(req()) === null);
ok('the owner-key shape the anonymous client already uses is still the one the claim accepts',
   A.claimDecision({ ownerKey: KEY, userId: 1 }).allow === true);
ok('nothing in lib/auth.mjs reaches for an npm package', await (async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../lib/auth.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
  return imports.every(i => i.startsWith('node:') || i.startsWith('.'));
})());

/* ── 10. The rule at the seam ──────────────────────────────────────────────
   Every assertion above passed while orders.mjs treated each signed-in
   customer as anonymous, because that bug lived at the seam between this
   module and its callers rather than inside either one. So the rule is
   enforced from here, over their source.

   The rule: a statement that names `user_id` must authenticate with `sql`.
   `sessionFrom` and a bare `authenticate(req)` check a signature and a clock
   and never reach the database, so both return a live user on a deploy where
   migration 004 was never applied — and the statement naming the column then
   fails outright. `authenticate(req, sql)` reads `auth_sessions`, which that
   same migration creates, so a missing schema arrives as a rejection the
   caller degrades to anonymous.

   A source-level check earns its place only if it can fail, so the detector
   runs against known-bad and known-good samples before it is turned loose on
   the real files. */
H('10. Callers that name user_id authenticate with sql');
{
  const fs = await import('node:fs/promises');

  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** Every `authenticate(...)` call's top-level argument list. */
  function authCalls(src) {
    const out = [];
    const re = /\bauthenticate\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length, depth = 1, cur = '', args = [];
      while (i < src.length) {
        const c = src[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) { depth--; if (depth === 0) break; }
        if (depth === 1 && c === ',') { args.push(cur); cur = ''; } else cur += c;
        i++;
      }
      args.push(cur);
      out.push(args.map(a => a.trim()).filter(Boolean));
    }
    return out;
  }

  /* The second failure mode, and the one that actually shipped: the right
     call, with `sql`, assigned whole instead of destructured. `authenticate`
     resolves to a tuple, so `const s = await authenticate(req, sql)` leaves an
     array whose `.userId` is undefined, and every signed-in caller is silently
     read as anonymous. Two arguments are not enough to be correct, so the
     shape of the assignment is checked too. */
  const undestructured = (src) =>
    [...src.matchAll(/(?:const|let|var)\s+([^=;]+?)\s*=\s*await\s+authenticate\s*\(/g)]
      .map(m => m[1].trim())
      .filter(lhs => !lhs.startsWith('['));

  const audit = (raw) => {
    const src = stripComments(raw);
    const calls = authCalls(src);
    return {
      namesUserId: /\buser_id\b/.test(src),
      usesSessionFrom: /\bsessionFrom\s*\(/.test(src),
      bareAuth: calls.filter(a => a.length < 2).length,
      undestructured: undestructured(src),
      calls: calls.length
    };
  };

  const BAD_SESSIONFROM = `
    import { sessionFrom } from '../../lib/auth.mjs';
    const u = sessionFrom(req);
    await sql\`INSERT INTO orders (owner_key, user_id) VALUES (\${k}, \${u && u.userId})\`;`;
  const BAD_BARE_AUTH = `
    import { authenticate } from '../../lib/auth.mjs';
    const [u] = await authenticate(req);
    await sql\`SELECT 1 FROM orders WHERE user_id = \${u.userId}\`;`;
  const GOOD = `
    import { authenticate } from '../../lib/auth.mjs';
    const [u] = await authenticate(req, sql).catch(() => [null, null]);
    await sql\`SELECT 1 FROM orders WHERE user_id = \${u.userId}\`;`;
  const GOOD_NO_COLUMN = `
    import { sessionFrom } from '../../lib/auth.mjs';
    const u = sessionFrom(req);
    return ok({ signedIn: !!u });`;
  const COMMENT_ONLY = `
    // a deploy without migration 004 has no user_id on this table
    import { sessionFrom } from '../../lib/auth.mjs';
    return ok({ anonymous: true });`;
  /* The exact shape orders.mjs shipped with. */
  const BAD_UNDESTRUCTURED = `
    import { authenticate } from '../../lib/auth.mjs';
    const session = await authenticate(req, sql).catch(() => null);
    return { session: session && session.userId ? session : null };`;

  ok('the detector catches sessionFrom feeding a statement that names user_id',
     audit(BAD_SESSIONFROM).namesUserId && audit(BAD_SESSIONFROM).usesSessionFrom);
  ok('the detector catches a bare authenticate(req) feeding the same',
     audit(BAD_BARE_AUTH).namesUserId && audit(BAD_BARE_AUTH).bareAuth === 1);
  ok('the detector passes the correct form', (() => {
    const a = audit(GOOD);
    return a.namesUserId && !a.usesSessionFrom && a.bareAuth === 0 && a.calls === 1;
  })());
  ok('the detector does not object to sessionFrom when no column is named',
     audit(GOOD_NO_COLUMN).namesUserId === false);
  ok('a mention of user_id in a comment does not count as naming the column',
     audit(COMMENT_ONLY).namesUserId === false);
  ok('the detector catches the tuple assigned whole — the bug that shipped',
     audit(BAD_UNDESTRUCTURED).undestructured.join() === 'session');
  ok('the detector accepts a correct destructure', audit(GOOD).undestructured.length === 0);

  /* auth.mjs is exempt by nature: it is the endpoint that creates accounts, so
     it writes user_id on the sign-in path, which is not authenticated and
     cannot be. It has no anonymous mode to degrade to either — requiring
     migration 004 is its premise, not an oversight. */
  const dir = new URL('../netlify/functions/', import.meta.url);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.mjs') && f !== 'auth.mjs');
  ok('there are function files to check', files.length > 0, String(files.length));

  const offenders = { sessionFrom: [], bareAuth: [], unauthenticated: [], loose: [] };
  const checked = [];
  for (const f of files) {
    const a = audit(await fs.readFile(new URL(f, dir), 'utf8'));
    /* The destructure is wrong wherever it appears, whether or not this file
       goes on to name the column, so it is checked before the filter. */
    if (a.undestructured.length) offenders.loose.push(`${f} (${a.undestructured.join(', ')})`);
    if (!a.namesUserId) continue;
    checked.push(f);
    if (a.usesSessionFrom) offenders.sessionFrom.push(f);
    if (a.bareAuth) offenders.bareAuth.push(f);
    if (!a.calls) offenders.unauthenticated.push(f);
  }

  ok('no function naming user_id derives its session from sessionFrom',
     offenders.sessionFrom.length === 0, offenders.sessionFrom.join(', '));
  ok('no function naming user_id calls authenticate without sql',
     offenders.bareAuth.length === 0, offenders.bareAuth.join(', '));
  ok('every function naming user_id authenticates at all',
     offenders.unauthenticated.length === 0, offenders.unauthenticated.join(', '));
  ok('no function assigns the authenticate tuple whole instead of destructuring it',
     offenders.loose.length === 0, offenders.loose.join('; '));
  console.log(`    ${files.length} functions scanned, ${checked.length} name user_id: ${checked.join(', ') || 'none'}`);
}

/* ── 11. Every remediation token resolves to a sentence ────────────────────
   `remediation` is a machine token rather than prose because a screen has to
   branch on the next step and cannot branch on `code` — a mistyped one-time
   code and an expired session are both 401 `unauthorized`. The sentence a
   customer reads comes from `REMEDIATION_TEXT` in assets/ui-shell.js at
   render time, which is also what lets it be Bangla.

   `remedyText` drops an unrecognised token rather than printing it, which is
   right — a leaked snake_case word is the more embarrassing failure — but it
   means a token shipped without a sentence renders as nothing at all, with
   nothing failing anywhere. `remediationText` on the envelope is the escape
   hatch: a token that is new or rare carries its own fallback.

   Scanned across every endpoint rather than only this subgroup's, because the
   guarantee is worth as much to whoever writes the next one.

   Resolution is asserted by **running the shell's own `remedyText`**, not by
   re-deriving its rules from a parsed copy of its table. WORKPLAN.md records
   that assertions grepping source by shape were this session's recurring
   anti-pattern — three subgroups wrote one and all three broke on unrelated
   edits while looking like real failures — and this check was one of them.
   Calling the real function survives the table being renamed, reordered, or
   turned into something other than an object literal, because what is being
   asserted is the behaviour that matters: this token produces a sentence.

   One thing here stays source-shaped and cannot help it. Whether the fallback
   survives the trip to the renderer is a question about which fields one
   assignment copies, and there is no way to observe that without reading it.
   It is isolated to a single boolean with its own assertion, so when it
   breaks it says so plainly instead of reporting every token as an orphan. */
H('11. Remediation tokens resolve to a sentence');
{
  const fs = await import('node:fs/promises');
  const read = (u) => fs.readFile(u, 'utf8');

  /* Only bare snake_case counts as a token — the same rule `remedyText` uses
     to tell a token from a sentence an endpoint wrote by hand. */
  const TOKEN_RE = /^[a-z][a-z0-9_]*$/;

  /** The object literal enclosing an offset, so a token can be checked
   *  against the `remediationText` sitting beside it. */
  function enclosingObject(src, at) {
    let depth = 0, start = -1;
    for (let i = at; i >= 0; i--) {
      const c = src[i];
      if (c === '}') depth++;
      else if (c === '{') { if (depth === 0) { start = i; break; } depth--; }
    }
    if (start < 0) return '';
    let d = 0;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) return src.slice(start, i + 1); }
    }
    return src.slice(start);
  }

  /** Every token a source emits, each with whether a fallback travels with it. */
  const emissions = (src) =>
    [...src.matchAll(/remediation:\s*'([^']+)'/g)]
      .filter(m => TOKEN_RE.test(m[1]))
      .map(m => ({ token: m[1], hasFallback: /remediationText\s*:/.test(enclosingObject(src, m.index)) }));

  const shell = await read(new URL('../assets/ui-shell.js', import.meta.url));

  /** The shell's own `remedyText`, lifted out and made callable. Slicing by
   *  brace-matching rather than by a content regex, so the only thing that has
   *  to stay stable is the two declarations existing at all. */
  const declFrom = (src, at) => {
    const open = src.indexOf('{', at);
    if (at < 0 || open < 0) return '';
    let d = 0;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) return src.slice(at, i + 1); }
    }
    return '';
  };
  let remedyText = null;
  try {
    const tableSrc = declFrom(shell, shell.search(/const\s+REMEDIATION_TEXT\s*=/));
    const fnSrc = declFrom(shell, shell.search(/function\s+remedyText\s*\(/));
    if (tableSrc && fnSrc)
      remedyText = new Function(`${tableSrc};\n${fnSrc}\nreturn remedyText;`)();
  } catch { /* reported by the assertion below, not swallowed */ }

  /* If this fails, every assertion after it is meaningless rather than
     failing on its own merits — so it is stated once, loudly, and the rest is
     skipped instead of reporting a cascade of false orphans. */
  ok('the shell\'s own remedyText can be loaded and called', typeof remedyText === 'function');
  const resolves = (token, extra = {}) =>
    typeof remedyText === 'function' &&
    typeof remedyText({ remediation: token, ...extra }) === 'string' &&
    remedyText({ remediation: token, ...extra }).length > 0;

  /* Behavioural sanity on the borrowed function before trusting it to judge
     anything: it must resolve a token it knows, refuse one it does not, prefer
     a fallback when it has no entry, and pass prose through. */
  ok('the borrowed remedyText resolves a token the shell knows', resolves('sign_in'));
  ok('the borrowed remedyText refuses a token it does not know', !resolves('no_such_token'));
  ok('the borrowed remedyText prefers a fallback for an unknown token',
     resolves('no_such_token', { remediationText: 'Do this instead.' }));
  ok('the borrowed remedyText passes prose through',
     remedyText && remedyText({ remediation: 'Save the design first.' }) === 'Save the design first.');

  /* Whether the fallback actually reaches the renderer, rather than assuming
     it. `api()` sets `remediationText` on the thrown error, but `net.lastError`
     is rebuilt as a fresh literal, and a screen reading that — the documented
     way — sees only the fields it copies across. If the fallback is dropped
     there, then "a new token may carry its own sentence" is not true on that
     path, and this check must not certify a token that relies on it. */
  const lastErrorShape = (() => {
    const at = /net\.lastError\s*=\s*\{/.exec(shell);
    return at ? enclosingObject(shell, at.index + at[0].length - 1) : '';
  })();
  const fallbackSurvives = /remediationText/.test(lastErrorShape);
  ok('the shell rebuilds net.lastError from a literal we can inspect', !!lastErrorShape);

  /* Endpoints first, then the lib modules they refuse from — `lib/auth.mjs`
     builds its own refusals, and the payment and quote modules may too. */
  const sources = [];
  for (const [dir, sub] of [['../netlify/functions/', false], ['../lib/', true]]) {
    const base = new URL(dir, import.meta.url);
    for (const e of await fs.readdir(base, { withFileTypes: true })) {
      if (e.isDirectory() && sub) {
        const inner = new URL(e.name + '/', base);
        for (const f of await fs.readdir(inner))
          if (f.endsWith('.mjs')) sources.push([dir + e.name + '/' + f, new URL(f, inner)]);
      } else if (e.name.endsWith('.mjs')) sources.push([dir + e.name, new URL(e.name, base)]);
    }
  }
  ok('there are sources to scan', sources.length > 3, String(sources.length));

  /* Resolution is the shell's answer, not ours. A fallback only rescues a
     token if the fallback also survives the trip to the renderer, so the
     escape hatch counts only while it does: it fails the day someone relies on
     a hatch that is not open, and relaxes on its own once the shell carries
     `remediationText` through — which is what happened between two runs of
     this suite. */
  const isOrphan = (token, hasFallback, survives) =>
    !resolves(token) && !(hasFallback && survives && resolves(token, { remediationText: 'x' }));

  const orphans = [], seen = new Set();
  for (const [name, url] of sources)
    for (const { token, hasFallback } of emissions(await read(url))) {
      seen.add(token);
      if (isOrphan(token, hasFallback, fallbackSurvives)) orphans.push(`${name}:${token}`);
    }

  ok('every remediation token resolves to a sentence a customer can actually read',
     orphans.length === 0,
     orphans.join(', ') + (orphans.length && !fallbackSurvives
       ? ' — and net.lastError drops remediationText, so a fallback does not rescue it' : ''));

  /* Controls. A source-level check that cannot fail is decoration, and this
     one has to get three distinctions right, not one. */
  const bare = emissions(`ERR.unauthorized('m', { remediation: 'no_such_token' })`);
  ok('the check catches a token with neither a sentence nor a fallback',
     bare.length === 1 && !bare[0].hasFallback && !resolves(bare[0].token));
  const rescued = emissions(
    `ERR.unauthorized('m', { remediation: 'no_such_token', remediationText: 'Do this instead.' })`);
  ok('a new token that carries its own fallback is accepted',
     rescued.length === 1 && rescued[0].hasFallback);
  ok('prose is not mistaken for a token',
     emissions(`ERR.badRequest('m', { remediation: 'Save the design first.' })`).length === 0);
  ok('a fallback on one refusal is not credited to the next', (() => {
    const two = emissions(
      `a(ERR.x('m', { remediation: 'tok_a', remediationText: 'A.' }));\n` +
      `b(ERR.y('m', { remediation: 'tok_b' }));`);
    return two.length === 2 && two[0].hasFallback === true && two[1].hasFallback === false;
  })());
  /* The predicate weighs three things, so its table is pinned rather than
     reasoned about. A token the shell resolves is safe however the transport
     behaves; a token relying on a fallback is safe only while it survives. */
  ok('a token the shell resolves is safe whether or not the fallback survives',
     !isOrphan('sign_in', false, false) && !isOrphan('sign_in', false, true));
  ok('a fallback-only token is safe when the shell carries the fallback through',
     !isOrphan('no_such_token', true, true));
  ok('a fallback-only token is an orphan when the shell drops the fallback',
     isOrphan('no_such_token', true, false));
  ok('a token with neither is an orphan either way',
     isOrphan('no_such_token', false, true) && isOrphan('no_such_token', false, false));

  console.log(`    ${sources.length} sources scanned, ${seen.size} distinct tokens: ${[...seen].sort().join(', ')}`);
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
