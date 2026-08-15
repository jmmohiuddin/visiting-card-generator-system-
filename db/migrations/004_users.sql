-- 004 — phone-based accounts (PRD Epic G, Technical Design §5.2, §10 item 6).
--
-- The anonymous `owner_key` in localStorage is what "My designs" runs on
-- today, and it dies with the browser. These tables give a person a real
-- identity keyed on the one identifier every Bangladeshi buyer already has
-- and can prove: their mobile number. No KYC beyond that — trade licence and
-- BIN belong to a corporate order, not to signup.
--
-- Re-runnable, like db/schema.sql: every object is IF NOT EXISTS so applying
-- this twice is a no-op rather than an error. Every identifier comes from a
-- sequence; §5.2 calls out that anywhere an id is derived from a row count is
-- a latent version of the order-reference collision this codebase already fixed.

CREATE TABLE IF NOT EXISTS users (
  id         bigserial   PRIMARY KEY,
  phone      text        NOT NULL,
  name       text,
  locale     text        NOT NULL DEFAULT 'bn' CHECK (locale IN ('bn','en')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The number is the account. The unique index is also what makes the
-- find-or-create in lib/auth.mjs race-safe: two tabs verifying the same code
-- cannot produce two accounts.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON users (phone);

-- Numbers are stored only in the +8801XXXXXXXXX form normalisePhone() emits,
-- so `01712…`, `8801712…` and `+8801712…` are one account and not three.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_normalised;
ALTER TABLE users ADD  CONSTRAINT users_phone_normalised
  CHECK (phone ~ '^\+8801[3-9][0-9]{8}$');

-- ── One-time codes ────────────────────────────────────────────────────────
-- Keyed on the phone rather than the user, because the first code a number
-- ever receives is the one that creates the account. `code_hash` is an HMAC
-- under a server-side pepper: a dump of this table does not let anyone sign
-- in, and the plaintext exists only in the SMS and in the requester's hand.

CREATE TABLE IF NOT EXISTS auth_otps (
  id           bigserial   PRIMARY KEY,
  phone        text        NOT NULL,
  code_hash    text        NOT NULL,
  purpose      text        NOT NULL DEFAULT 'signin',
  attempts     int         NOT NULL DEFAULT 0,
  max_attempts int         NOT NULL DEFAULT 5,
  request_ip   text,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The verifier wants the newest live code for a number, and only that one:
-- requesting a fresh code retires the outstanding ones, so an attacker
-- cannot accumulate a pile of simultaneously-valid guesses.
CREATE INDEX IF NOT EXISTS auth_otps_live_ix
  ON auth_otps (phone, created_at DESC) WHERE consumed_at IS NULL;

-- ── Sessions ──────────────────────────────────────────────────────────────
-- The token itself is self-contained and signed, so the read path verifies
-- without a query. This table exists for the thing a signature cannot do:
-- revoke. A row per issued `jti` means signing out, or an operator killing a
-- stolen session, actually ends it before its thirty days are up.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id         bigserial   PRIMARY KEY,
  jti        text        NOT NULL,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent text,
  issued_ip  text,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_jti_key ON auth_sessions (jti);
CREATE INDEX IF NOT EXISTS auth_sessions_user_ix ON auth_sessions (user_id, issued_at DESC);

-- ── Rate-limit ledger ─────────────────────────────────────────────────────
-- Counted here rather than in process memory, because every function
-- invocation is a fresh process and an in-memory counter resets for free on
-- the attacker's behalf. One row per attempt; `bucket` is 'phone:+8801…' or
-- 'ip:…' so the same table limits both ends of the flow.

CREATE TABLE IF NOT EXISTS auth_attempts (
  id         bigserial   PRIMARY KEY,
  bucket     text        NOT NULL,
  kind       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempts_bucket_ix ON auth_attempts (bucket, created_at DESC);

-- ── Claiming a browser's anonymous work ───────────────────────────────────
-- The migration that is the point of the epic: the designs and orders a
-- person made before they had an account have to follow them onto it.
--
-- The unique index on owner_key is the security control, not a tidiness
-- rule. A key can be claimed exactly once, ever, and the claim is decided by
-- an atomic INSERT … ON CONFLICT rather than a read-then-write two concurrent
-- requests would both win. The claim is additive — rows keep their owner_key,
-- so the browser that still holds it is never locked out and a mistaken claim
-- costs nothing. See the reasoning block in lib/auth.mjs for the abuse cases.

CREATE TABLE IF NOT EXISTS owner_claims (
  id         bigserial   PRIMARY KEY,
  owner_key  text        NOT NULL,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_ip text,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_claims_key_uniq ON owner_claims (owner_key);
CREATE INDEX IF NOT EXISTS owner_claims_user_ix ON owner_claims (user_id, claimed_at DESC);

-- Work created *after* signing in is stamped with the account directly and
-- needs no claim at all. `design_specs` is append-only by trigger, so its
-- column can only ever be set at INSERT — which is why pre-account designs
-- resolve through owner_claims instead of being back-stamped. `orders` has no
-- such trigger, so its column is both set at insert and backfilled on claim,
-- which keeps the order list a single predicate.

ALTER TABLE design_specs ADD COLUMN IF NOT EXISTS user_id bigint REFERENCES users(id);
ALTER TABLE orders       ADD COLUMN IF NOT EXISTS user_id bigint REFERENCES users(id);
CREATE INDEX IF NOT EXISTS design_specs_user_ix ON design_specs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_user_ix       ON orders       (user_id, created_at DESC);
