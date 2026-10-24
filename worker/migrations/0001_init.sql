-- RepoOps schema (Cloudflare D1 / SQLite)
-- One row per browser session; OAuth tokens are AES-GCM encrypted before insert.

CREATE TABLE IF NOT EXISTS sessions (
  sid            TEXT PRIMARY KEY,
  login          TEXT NOT NULL,
  avatar_url     TEXT,
  scopes         TEXT NOT NULL DEFAULT '',
  token_cipher   TEXT NOT NULL,
  token_iv       TEXT NOT NULL,
  token_expires_at TEXT,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_login ON sessions(login);

-- Repositories a user has added to their war room. Scoped by login so two
-- users can track the same repo without seeing each other's cache.
CREATE TABLE IF NOT EXISTS tracked_repos (
  login          TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  html_url       TEXT NOT NULL,
  description    TEXT,
  stars          INTEGER,
  is_private     INTEGER,
  language       TEXT,
  pushed_at      TEXT,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (login, repo_full_name)
);

-- Normalized issue/PR cache, written by the sync job only.
CREATE TABLE IF NOT EXISTS cached_items (
  login          TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  number         INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  payload        TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (login, item_id)
);

CREATE INDEX IF NOT EXISTS idx_items_repo ON cached_items(login, repo_full_name);

-- Incremental sync bookkeeping: last cursor, page progress, quota, errors.
CREATE TABLE IF NOT EXISTS sync_state (
  login            TEXT NOT NULL,
  repo_full_name   TEXT NOT NULL,
  last_sync_at     TEXT,
  cursor           TEXT,
  pages_fetched    INTEGER NOT NULL DEFAULT 0,
  item_count       INTEGER NOT NULL DEFAULT 0,
  complete         INTEGER NOT NULL DEFAULT 0,
  rate_limit_json  TEXT,
  errors_json      TEXT NOT NULL DEFAULT '[]',
  last_duration_ms INTEGER,
  last_mode        TEXT NOT NULL DEFAULT 'live',
  PRIMARY KEY (login, repo_full_name)
);

-- Cached weekly reports so an export is reproducible for the same window.
CREATE TABLE IF NOT EXISTS reports (
  login          TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  window_key     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  generated_at   TEXT NOT NULL,
  PRIMARY KEY (login, repo_full_name, window_key)
);
