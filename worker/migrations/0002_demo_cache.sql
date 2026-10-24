-- Demo-mode cache: one short-lived snapshot per public repo.
-- Refreshing at most every 30 minutes keeps unauthenticated GitHub quota
-- (60 req/h per IP) far below the limit, and lets the worker serve stale data
-- when GitHub is unreachable instead of showing an error page.

CREATE TABLE IF NOT EXISTS demo_cache (
  repo_full_name TEXT PRIMARY KEY,
  payload        TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
