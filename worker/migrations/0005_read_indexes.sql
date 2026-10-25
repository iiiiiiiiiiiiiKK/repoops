-- Index the read paths that actually run on every page load.
--
-- `readDemoItems` does `WHERE repo_full_name = ? ORDER BY updated_at DESC`,
-- which SQLite can only satisfy by reading every matching row and sorting it.
-- With a covering index D1 reads just the rows returned. Same for the per-user
-- item cache. This matters on the free tier, where row reads are the quota.

CREATE INDEX IF NOT EXISTS idx_demo_items_repo_updated
  ON demo_items(repo_full_name, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_repo_updated
  ON cached_items(login, repo_full_name, updated_at DESC);
