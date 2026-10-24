/**
 * Sync service: the only place that talks to GitHub and writes the cache.
 *
 * Design notes
 *  - Pagination is capped (`MAX_PAGES`) so a pathological 20k-issue repo cannot
 *    burn the whole API quota in one click; the cap is reported to the UI via
 *    `sync.complete === false`.
 *  - Incremental runs send `since=<lastSyncAt>`, so the second run costs one
 *    request per changed page instead of re-walking everything.
 *  - Partial failures are recorded in `sync_state.errors_json` and never
 *    silently discarded: the UI surfaces them verbatim.
 */
import type { ApiError } from './env';
import { ApiError as Err, type Env } from './env';
import { ghGet, ghGraphqlPullDecisions, type GhIssue } from './github';
import { dedupeItems, normalizeItem } from './normalize';
import type { NormalizedItem, RateLimitSnapshot as SharedRateLimit, RepoRef, SyncError, SyncState, TrackerRepo } from '../shared/types';
import type { RateLimitSnapshot } from '../shared/types';

export const MAX_PAGES = 6;
const PER_PAGE = 100;

export interface SyncResult {
  repo: TrackerRepo;
  items: NormalizedItem[];
  incremental: boolean;
}

export function parseRepoFullName(input: string): { owner: string; name: string } {
  const cleaned = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = cleaned.split('/');
  if (parts.length !== 2) throw new Err(400, 'BAD_REPO', 'Repository must look like "owner/name" or a github.com URL.');
  const [owner, name] = parts;
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) && /^[A-Za-z0-9._-]{1,100}$/.test(name);
  if (!valid) throw new Err(400, 'BAD_REPO', 'Repository owner or name contains invalid characters.');
  return { owner, name };
}

export function toSharedRateLimit(snapshot: RateLimitSnapshot | null): SharedRateLimit | null {
  return snapshot ? { ...snapshot } : null;
}

/**
 * Fetch repo metadata + issues/PRs. `token` may be null (demo mode), in which
 * case GraphQL review decisions are skipped.
 */
export async function fetchRepoSnapshot(
  env: Env,
  repoFullName: string,
  token: string | null,
  options: { since?: string | null; maxPages?: number } = {},
): Promise<{
  repo: RepoRef;
  items: NormalizedItem[];
  pages: number;
  complete: boolean;
  rateLimit: SharedRateLimit | null;
  errors: SyncError[];
  cursor: string | null;
}> {
  const { owner, name } = parseRepoFullName(repoFullName);
  const base = env.GITHUB_API_BASE;
  const errors: SyncError[] = [];
  const maxPages = Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES);

  const meta = await ghGet<{
    full_name: string;
    name: string;
    owner: { login: string };
    html_url: string;
    description: string | null;
    stargazers_count: number;
    private: boolean;
    pushed_at: string | null;
    language: string | null;
  }>(base, token, `/repos/${owner}/${name}`);

  if (!meta.data) throw new Err(502, 'EMPTY_RESPONSE', 'GitHub returned no repository data.');
  const repo: RepoRef = {
    owner: meta.data.owner.login,
    name: meta.data.name,
    fullName: meta.data.full_name,
    htmlUrl: meta.data.html_url,
    description: meta.data.description,
    stargazers: meta.data.stargazers_count,
    isPrivate: meta.data.private,
    pushedAt: meta.data.pushed_at,
    language: meta.data.language,
  };

  let rateLimit = toSharedRateLimit(meta.rateLimit);
  const raw: GhIssue[] = [];
  let page = 1;
  let pages = 0;
  let complete = false;
  let lastUpdated: string | null = null;

  while (page <= maxPages) {
    let res;
    try {
      res = await ghGet<GhIssue[]>(base, token, `/repos/${owner}/${name}/issues`, {
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: PER_PAGE,
        page,
        since: options.since ?? undefined,
      });
    } catch (err) {
      // A failure mid-pagination keeps what we already collected.
      const e = err as ApiError;
      errors.push({ message: e.message, at: new Date().toISOString(), code: (e as unknown as { code?: string }).code });
      break;
    }
    const batch = res.data ?? [];
    pages += 1;
    rateLimit = toSharedRateLimit(res.rateLimit) ?? rateLimit;
    for (const item of batch) {
      raw.push(item);
      if (!lastUpdated || item.updated_at > lastUpdated) lastUpdated = item.updated_at;
    }
    if (batch.length < PER_PAGE) {
      complete = true;
      break;
    }
    page += 1;
  }

  // reviewDecision is REST-invisible; one GraphQL call covers the open PRs.
  let decisions = new Map<number, { reviewDecision: string | null; isDraft: boolean }>();
  if (token && raw.some((r) => r.pull_request)) {
    try {
      const result = await ghGraphqlPullDecisions(token, owner, name);
      decisions = result.decisions;
    } catch (err) {
      const e = err as ApiError;
      errors.push({
        message: `Review decisions unavailable: ${e.message}`,
        at: new Date().toISOString(),
        code: 'REVIEW_DECISION_UNAVAILABLE',
      });
    }
  }

  const items = dedupeItems(
    raw.map((item) =>
      normalizeItem(repo.fullName, item, { reviewDecision: decisions.get(item.number)?.reviewDecision ?? null }),
    ),
  );

  return { repo, items, pages, complete, rateLimit, errors, cursor: complete ? lastUpdated : null };
}

function emptySyncState(repo: string, mode: 'live' | 'demo'): SyncState {
  return {
    repo,
    lastSyncAt: null,
    itemCount: 0,
    pagesFetched: 0,
    complete: false,
    cursor: null,
    errors: [],
    rateLimit: null,
    lastRunDurationMs: null,
    mode,
  };
}

export async function readSyncState(env: Env, login: string, repo: string): Promise<SyncState | null> {
  const row = await env.DB.prepare(
    `SELECT last_sync_at, cursor, pages_fetched, item_count, complete, rate_limit_json, errors_json, last_duration_ms, last_mode
     FROM sync_state WHERE login = ? AND repo_full_name = ?`,
  )
    .bind(login, repo)
    .first<{
      last_sync_at: string | null;
      cursor: string | null;
      pages_fetched: number;
      item_count: number;
      complete: number;
      rate_limit_json: string | null;
      errors_json: string;
      last_duration_ms: number | null;
      last_mode: string;
    }>();
  if (!row) return null;
  let errors: SyncError[] = [];
  try {
    errors = JSON.parse(row.errors_json) as SyncError[];
  } catch {
    errors = [];
  }
  let rateLimit: SharedRateLimit | null = null;
  try {
    rateLimit = row.rate_limit_json ? (JSON.parse(row.rate_limit_json) as SharedRateLimit) : null;
  } catch {
    rateLimit = null;
  }
  return {
    repo,
    lastSyncAt: row.last_sync_at,
    itemCount: row.item_count,
    pagesFetched: row.pages_fetched,
    complete: row.complete === 1,
    cursor: row.cursor,
    errors,
    rateLimit,
    lastRunDurationMs: row.last_duration_ms,
    mode: row.last_mode === 'demo' ? 'demo' : 'live',
  };
}

export async function writeSyncState(
  env: Env,
  login: string,
  state: SyncState,
  extra: { complete: boolean; pages: number; cursor: string | null; errorList: SyncError[]; durationMs: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (login, repo_full_name, last_sync_at, cursor, pages_fetched, item_count, complete, rate_limit_json, errors_json, last_duration_ms, last_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(login, repo_full_name) DO UPDATE SET
       last_sync_at = excluded.last_sync_at,
       cursor = excluded.cursor,
       pages_fetched = excluded.pages_fetched,
       item_count = excluded.item_count,
       complete = excluded.complete,
       rate_limit_json = excluded.rate_limit_json,
       errors_json = excluded.errors_json,
       last_duration_ms = excluded.last_duration_ms,
       last_mode = excluded.last_mode`,
  )
    .bind(
      login,
      state.repo,
      state.lastSyncAt,
      extra.cursor,
      extra.pages,
      state.itemCount,
      extra.complete ? 1 : 0,
      state.rateLimit ? JSON.stringify(state.rateLimit) : null,
      JSON.stringify(extra.errorList),
      extra.durationMs,
      state.mode,
    )
    .run();
}

/**
 * Run a sync for one tracked repo and persist items + state.
 * `incremental` reuses the stored cursor so repeat runs are cheap.
 */
export async function syncRepo(env: Env, login: string, token: string, repoFullName: string): Promise<SyncResult> {
  const started = Date.now();
  const previous = await readSyncState(env, login, repoFullName);
  const since = previous?.cursor ?? null;

  const tracked = await env.DB.prepare(
    'SELECT repo_full_name, owner, name, html_url, description, stars, is_private, language, pushed_at, added_at FROM tracked_repos WHERE login = ? AND repo_full_name = ?',
  )
    .bind(login, repoFullName)
    .first<{
      repo_full_name: string;
      owner: string;
      name: string;
      html_url: string;
      description: string | null;
      stars: number | null;
      is_private: number | null;
      language: string | null;
      pushed_at: string | null;
      added_at: string;
    }>();
  if (!tracked) throw new Err(403, 'NOT_TRACKED', 'This repository is not in your workspace.');

  const snapshot = await fetchRepoSnapshot(env, repoFullName, token, { since, maxPages: MAX_PAGES });

  // A full (non-incremental) sync replaces the cache so deleted items disappear.
  // An incremental sync only upserts: it fetched "changed since the cursor", so
  // deleting first would throw away every unchanged item.
  if (!since && snapshot.complete) {
    await env.DB.prepare('DELETE FROM cached_items WHERE login = ? AND repo_full_name = ?').bind(login, repoFullName).run();
  }

  const now = new Date().toISOString();
  const statements = snapshot.items.map((item) =>
    env.DB.prepare(
      `INSERT INTO cached_items (login, repo_full_name, item_id, number, kind, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(login, item_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, kind = excluded.kind`,
    ).bind(login, repoFullName, item.id, item.number, item.kind, JSON.stringify(item), item.updatedAt),
  );
  // D1 batches are capped; chunk to stay well inside the limit.
  for (let i = 0; i < statements.length; i += 40) {
    await env.DB.batch(statements.slice(i, i + 40));
  }

  await env.DB.prepare(
    `UPDATE tracked_repos SET html_url = ?, description = ?, stars = ?, is_private = ?, language = ?, pushed_at = ? WHERE login = ? AND repo_full_name = ?`,
  )
    .bind(
      snapshot.repo.htmlUrl,
      snapshot.repo.description ?? null,
      snapshot.repo.stargazers ?? null,
      snapshot.repo.isPrivate ? 1 : 0,
      snapshot.repo.language ?? null,
      snapshot.repo.pushedAt ?? null,
      login,
      repoFullName,
    )
    .run();

  const allItems = await readCachedItems(env, login, repoFullName);
  const state: SyncState = {
    repo: repoFullName,
    lastSyncAt: now,
    itemCount: allItems.length,
    pagesFetched: snapshot.pages,
    complete: snapshot.complete,
    cursor: snapshot.cursor ?? since,
    errors: snapshot.errors,
    rateLimit: snapshot.rateLimit,
    lastRunDurationMs: Date.now() - started,
    mode: 'live',
  };
  await writeSyncState(env, login, state, {
    complete: snapshot.complete,
    pages: snapshot.pages,
    cursor: state.cursor,
    errorList: snapshot.errors,
    durationMs: state.lastRunDurationMs ?? 0,
  });

  return {
    repo: {
      ...snapshot.repo,
      addedAt: tracked.added_at,
      sync: state,
    },
    items: allItems,
    incremental: Boolean(since),
  };
}

export async function readCachedItems(env: Env, login: string, repoFullName: string): Promise<NormalizedItem[]> {
  const { results } = await env.DB.prepare(
    'SELECT payload FROM cached_items WHERE login = ? AND repo_full_name = ? ORDER BY updated_at DESC LIMIT 2000',
  )
    .bind(login, repoFullName)
    .all<{ payload: string }>();
  const items: NormalizedItem[] = [];
  for (const row of results) {
    try {
      items.push(JSON.parse(row.payload) as NormalizedItem);
    } catch {
      // Skip a single corrupted row rather than failing the whole dashboard.
    }
  }
  return items;
}

export async function listTrackedRepos(env: Env, login: string): Promise<TrackerRepo[]> {
  const { results } = await env.DB.prepare(
    'SELECT repo_full_name, owner, name, html_url, description, stars, is_private, language, pushed_at, added_at FROM tracked_repos WHERE login = ? ORDER BY added_at ASC',
  )
    .bind(login)
    .all<{
      repo_full_name: string;
      owner: string;
      name: string;
      html_url: string;
      description: string | null;
      stars: number | null;
      is_private: number | null;
      language: string | null;
      pushed_at: string | null;
      added_at: string;
    }>();

  const repos: TrackerRepo[] = [];
  for (const row of results) {
    const sync = (await readSyncState(env, login, row.repo_full_name)) ?? emptySyncState(row.repo_full_name, 'live');
    repos.push({
      owner: row.owner,
      name: row.name,
      fullName: row.repo_full_name,
      htmlUrl: row.html_url,
      description: row.description,
      stargazers: row.stars,
      isPrivate: row.is_private === 1,
      language: row.language,
      pushedAt: row.pushed_at,
      addedAt: row.added_at,
      sync,
    });
  }
  return repos;
}

/* ------------------------------------------------------------------ */
/* Demo mode                                                            */
/* ------------------------------------------------------------------ */

/**
 * Demo snapshots live for 6 hours. Cloudflare egress IPs share GitHub's
 * unauthenticated 60 req/h quota, so a short TTL would make the public demo
 * flap between fresh and stale data. Six hours keeps refresh cost negligible
 * and the cron job tops the cache up in the background.
 */
const DEMO_TTL_MS = 1000 * 60 * 60 * 6;

export interface DemoSnapshot {
  repo: TrackerRepo;
  items: NormalizedItem[];
  fetchedAt: string;
  stale: boolean;
}

/**
 * Demo data is real GitHub data for one public repo, cached in D1.
 * It is always labelled `mode: 'demo'` and is never merged into a user's
 * own tracked-repo cache — the two data paths share no rows.
 */
export async function loadDemoSnapshot(env: Env, repoFullName: string): Promise<DemoSnapshot> {
  const meta = await env.DB.prepare('SELECT payload, fetched_at, expires_at FROM demo_meta WHERE repo_full_name = ?')
    .bind(repoFullName)
    .first<{ payload: string; fetched_at: string; expires_at: string }>();

  const fresh = meta && Date.parse(meta.expires_at) > Date.now();
  if (meta && fresh) {
    const repo = JSON.parse(meta.payload) as TrackerRepo;
    const items = await readDemoItems(env, repoFullName);
    return { repo, items, fetchedAt: meta.fetched_at, stale: false };
  }

  try {
    const snapshot = await fetchRepoSnapshot(env, repoFullName, env.GITHUB_TOKEN ?? null, { maxPages: 2 });
    const nowIso = new Date().toISOString();
    const repo: TrackerRepo = {
      ...snapshot.repo,
      addedAt: nowIso,
      sync: {
        repo: repoFullName,
        lastSyncAt: nowIso,
        itemCount: snapshot.items.length,
        pagesFetched: snapshot.pages,
        complete: snapshot.complete,
        cursor: snapshot.cursor,
        errors: snapshot.errors,
        rateLimit: snapshot.rateLimit,
        lastRunDurationMs: null,
        mode: 'demo',
      },
    };
    await env.DB.prepare(
      `INSERT INTO demo_meta (repo_full_name, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_full_name) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    )
      .bind(repoFullName, JSON.stringify(repo), nowIso, new Date(Date.now() + DEMO_TTL_MS).toISOString())
      .run();

    // One row per item keeps every statement far below D1's size ceiling.
    const statements = snapshot.items.map((item) =>
      env.DB.prepare(
        `INSERT INTO demo_items (repo_full_name, item_id, updated_at, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_full_name, item_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      ).bind(repoFullName, item.id, item.updatedAt, JSON.stringify(item)),
    );
    for (let i = 0; i < statements.length; i += 40) {
      await env.DB.batch(statements.slice(i, i + 40));
    }
    return { repo, items: snapshot.items, fetchedAt: nowIso, stale: false };
  } catch (err) {
    if (meta) {
      // Serve the last good snapshot rather than an error screen.
      const repo = JSON.parse(meta.payload) as TrackerRepo;
      const items = await readDemoItems(env, repoFullName);
      if (items.length > 0) return { repo, items, fetchedAt: meta.fetched_at, stale: true };
    }
    throw err;
  }
}

async function readDemoItems(env: Env, repoFullName: string): Promise<NormalizedItem[]> {  const { results } = await env.DB.prepare(
    'SELECT payload FROM demo_items WHERE repo_full_name = ? ORDER BY updated_at DESC LIMIT 600',
  )
    .bind(repoFullName)
    .all<{ payload: string }>();
  const items: NormalizedItem[] = [];
  for (const row of results) {
    try {
      items.push(JSON.parse(row.payload) as NormalizedItem);
    } catch {
      // skip a single corrupted row
    }
  }
  return items;
}
