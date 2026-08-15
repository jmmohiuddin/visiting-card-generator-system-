-- Idempotency, for the mutating endpoints (Technical Design §8).
--
-- Every mutating call accepts an `Idempotency-Key`. The problem it solves is
-- not the double-click — that is the easy half — but the attempt that
-- succeeded on the server and whose reply never reached the customer. A
-- client retrying that call must be handed the first response, not made to
-- perform the effect a second time, so what is stored here is the response
-- itself rather than a marker saying "seen".
--
-- This table is a cache, deliberately. `lib/http.mjs` treats its absence as
-- "run the handler again" rather than as a failure, because a customer
-- pressing Place order should never meet a 500 because a convenience table
-- is missing. The effects that genuinely cannot happen twice do not depend
-- on it: a payment capture is guarded by its own partial unique index, and a
-- design save is idempotent by content address.
--
-- Re-runnable, like every migration in this directory.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id         bigserial   PRIMARY KEY,
  key        text        NOT NULL,
  -- Scoped per operation, so the same key presented to `orders:place` and to
  -- `orders:advance` is two different requests rather than one collision.
  scope      text        NOT NULL,
  status     int         NOT NULL,
  body       jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_key_scope_ix
  ON idempotency_keys (key, scope);

-- The read is always bounded to the last 24 hours; the index carries the
-- timestamp so that window is a range scan rather than a filter.
CREATE INDEX IF NOT EXISTS idempotency_keys_created_ix
  ON idempotency_keys (created_at DESC);

-- Nothing here is worth keeping once the retry window has closed. Run this
-- from a scheduled job; it is written as a function so the schedule does not
-- have to carry the interval.
CREATE OR REPLACE FUNCTION idempotency_keys_prune(older_than interval DEFAULT '7 days')
RETURNS bigint AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM idempotency_keys WHERE created_at < now() - older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$ LANGUAGE plpgsql;
