-- Demo cache split into meta + item rows.
--
-- A single JSON blob for 300 issues exceeds D1's per-statement size limit
-- (SQLITE_TOOBIG), so the snapshot is stored one item per row and assembled at
-- read time. This also lets the demo cache be re-seeded incrementally.

DROP TABLE IF EXISTS demo_cache;

CREATE TABLE IF NOT EXISTS demo_meta (
  repo_full_name TEXT PRIMARY KEY,
  payload        TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_items (
  repo_full_name TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  PRIMARY KEY (repo_full_name, item_id)
);

CREATE INDEX IF NOT EXISTS idx_demo_items_repo ON demo_items(repo_full_name);
