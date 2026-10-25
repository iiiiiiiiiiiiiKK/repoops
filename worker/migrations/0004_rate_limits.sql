-- Rate limiting moved off Durable Objects.
--
-- Why: the Worker's per-request limiter used a Durable Object, and a public
-- deployment burns thousands of DO storage reads per day (one get + one put per
-- API call, per client IP). The DO free tier reports "Exceeded allowed rows read
-- in Durable Objects free tier", which took the whole API down — a protection
-- mechanism must never be able to break the thing it protects.
--
-- D1 gives the same fixed-window counter with a single UPSERT, and the read
-- path already depends on D1, so there is no new subsystem to fail.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
