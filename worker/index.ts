/**
 * RepoOps worker: API router + static asset host.
 *
 * Every /api route is handled here; anything else falls through to the bundled
 * SPA (Workers Static Assets). Route handlers are thin — they validate input,
 * enforce ownership, and delegate to the service modules.
 */
import { ApiError, errorResponse, json, type Env } from './env';
import { handleCallback, handleLogin, handleLogout, handleSessionInfo, handleTokenLogin } from './auth';
import { loadSession, requireSession } from './session';
import {
  listTrackedRepos,
  loadDemoSnapshot,
  refreshDemoSnapshot,
  parseRepoFullName,
  readCachedItems,
  readSyncState,
  syncRepo,
  fetchRepoSnapshot,
} from './sync';
import { buildWeeklyReport } from '../shared/board';
import { DEFAULT_THRESHOLDS, type BoardThresholds, type TrackerRepo } from '../shared/types';

export { RateLimiter } from './rate-limiter';

/* ----------------------------- helpers ----------------------------- */

const RATE_LIMIT_PER_MIN = 90;

async function enforceRateLimit(env: Env, request: Request, bucket: string, cost = 1): Promise<void> {
  if (!env.RATE_LIMITER) return; // limiter binding absent in unit tests
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const id = env.RATE_LIMITER.idFromName(`${bucket}:${ip}`);
  const stub = env.RATE_LIMITER.get(id);
  const url = new URL('https://rate-limiter.internal/check');
  url.searchParams.set('limit', String(RATE_LIMIT_PER_MIN));
  url.searchParams.set('windowMs', '60000');
  url.searchParams.set('bucket', bucket);
  url.searchParams.set('cost', String(cost));
  const res = await stub.fetch(url.toString());
  const result = (await res.json()) as { allowed: boolean; remaining: number; resetAt: string; limit: number };
  if (!result.allowed) {
    throw new ApiError(
      429,
      'LOCAL_RATE_LIMITED',
      `Too many requests from this client. Try again after ${result.resetAt}.`,
      result,
    );
  }
}

function parseThresholds(url: URL): BoardThresholds {
  const staleRaw = Number(url.searchParams.get('staleDays') ?? DEFAULT_THRESHOLDS.staleDays);
  const doneRaw = Number(url.searchParams.get('doneDays') ?? DEFAULT_THRESHOLDS.doneDays);
  const clamp = (n: number, min: number, max: number, fallback: number) =>
    Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  return {
    staleDays: clamp(staleRaw, 1, 365, DEFAULT_THRESHOLDS.staleDays),
    doneDays: clamp(doneRaw, 1, 120, DEFAULT_THRESHOLDS.doneDays),
  };
}

/**
 * Ownership guard: a session can only ever read repos it added itself, because
 * every cache row is keyed by (login, repo). The explicit check here also
 * returns a clean 403 instead of an empty board for a repo the user never added.
 */
async function requireTrackedRepo(env: Env, login: string, repoFullName: string): Promise<TrackerRepo> {
  const repos = await listTrackedRepos(env, login);
  const found = repos.find((r) => r.fullName.toLowerCase() === repoFullName.toLowerCase());
  if (!found) {
    throw new ApiError(403, 'NOT_TRACKED', 'This repository is not in your workspace. Add it first.');
  }
  return found;
}

/* ------------------------------ router ------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      const response = errorResponse(err);
      if (response.status >= 500) {
        console.error('[repoops] unhandled', url.pathname, err instanceof Error ? err.message : err);
      }
      return response;
    }
  },

  /**
   * Cron (every 6h): warm the demo snapshot so the public demo never shows a
   * cold-cache 429, and drop sessions that are past their TTL.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const { owner, name } = parseRepoFullName(env.DEMO_REPO);
          // Refresh in place: a failure here must not destroy the previous good
          // snapshot that the public demo falls back to.
          await refreshDemoSnapshot(env, `${owner}/${name}`);
          console.log('[repoops] cron: demo cache refreshed for', `${owner}/${name}`);
        } catch (err) {
          console.error('[repoops] cron: demo refresh failed', err instanceof Error ? err.message : err);
        }
        try {
          const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
          const { meta } = await env.DB.prepare('DELETE FROM sessions WHERE created_at < ?').bind(cutoff).run();
          console.log('[repoops] cron: purged expired sessions', meta.changes);
        } catch (err) {
          console.error('[repoops] cron: session purge failed', err instanceof Error ? err.message : err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  // ---- auth ----
  if (path === '/api/session' && method === 'GET') {
    await enforceRateLimit(env, request, 'session');
    return handleSessionInfo(env, request);
  }
  if (path === '/api/auth/login' && method === 'GET') {
    await enforceRateLimit(env, request, 'auth');
    return handleLogin(request, env);
  }
  if (path === '/api/auth/callback' && method === 'GET') {
    await enforceRateLimit(env, request, 'auth');
    return handleCallback(request, env);
  }
  if (path === '/api/auth/token' && method === 'POST') {
    await enforceRateLimit(env, request, 'auth', 3);
    return handleTokenLogin(env, request);
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    return handleLogout(env, request);
  }

  // ---- demo (no auth, read-only, labelled) ----
  if (path === '/api/demo' && method === 'GET') {
    await enforceRateLimit(env, request, 'demo', 2);
    const repoParam = url.searchParams.get('repo') ?? env.DEMO_REPO;
    const { owner, name } = parseRepoFullName(repoParam);
    const snapshot = await loadDemoSnapshot(env, `${owner}/${name}`);
    return json({
      mode: 'demo',
      repo: snapshot.repo,
      items: snapshot.items,
      fetchedAt: snapshot.fetchedAt,
      stale: snapshot.stale,
      notice: '演示数据来自公开 GitHub API，只读，不属于任何登录用户。',
    });
  }

  // ---- authenticated workspace ----
  if (path === '/api/repos' && method === 'GET') {
    const session = await requireSession(env, request);
    await enforceRateLimit(env, request, 'read');
    const repos = await listTrackedRepos(env, session.login);
    return json({ repos });
  }

  if (path === '/api/repos' && method === 'POST') {
    const session = await requireSession(env, request);
    await enforceRateLimit(env, request, 'write', 10);
    let body: { repo?: string } = {};
    try {
      body = (await request.json()) as { repo?: string };
    } catch {
      throw new ApiError(400, 'BAD_BODY', 'Expected {"repo":"owner/name"}');
    }
    if (!body.repo) throw new ApiError(400, 'MISSING_REPO', 'Provide a repository in the form owner/name.');
    const { owner, name } = parseRepoFullName(body.repo);
    const repoFullName = `${owner}/${name}`;

    // Probe access before persisting so an unauthorized repo never becomes a row.
    const existing = await listTrackedRepos(env, session.login);
    if (existing.some((r) => r.fullName.toLowerCase() === repoFullName.toLowerCase())) {
      throw new ApiError(409, 'ALREADY_TRACKED', `${repoFullName} is already in your workspace.`);
    }
    if (existing.length >= 12) {
      throw new ApiError(400, 'TOO_MANY_REPOS', 'A workspace can track up to 12 repositories.');
    }

    // Probe the repo with the user's own token first. This is the authorization
    // check: if the token cannot see the repo (private repo, no access, typo),
    // nothing is written to D1 at all.
    const probe = await fetchRepoSnapshot(env, repoFullName, session.token, { maxPages: 1 });

    await env.DB.prepare(
      `INSERT INTO tracked_repos (login, repo_full_name, owner, name, html_url, description, stars, is_private, language, pushed_at, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(login, repo_full_name) DO UPDATE SET html_url = excluded.html_url`,
    )
      .bind(
        session.login,
        repoFullName,
        probe.repo.owner,
        probe.repo.name,
        probe.repo.htmlUrl,
        probe.repo.description ?? null,
        probe.repo.stargazers ?? null,
        probe.repo.isPrivate ? 1 : 0,
        probe.repo.language ?? null,
        probe.repo.pushedAt ?? null,
        new Date().toISOString(),
      )
      .run();

    // First full sync (the probe only paged once).
    const result = await syncRepo(env, session.login, session.token, repoFullName);
    return json({ repo: result.repo, itemCount: result.items.length }, { status: 201 });
  }

  const repoMatch = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)(\/[a-z]+)?$/);
  if (repoMatch) {
    const repoFullName = `${repoMatch[1]}/${repoMatch[2]}`;
    const action = repoMatch[3] ?? '';
    const session = await requireSession(env, request);

    if (!action && method === 'DELETE') {
      await enforceRateLimit(env, request, 'write');
      const tracked = await requireTrackedRepo(env, session.login, repoFullName);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM tracked_repos WHERE login = ? AND repo_full_name = ?').bind(session.login, tracked.fullName),
        env.DB.prepare('DELETE FROM cached_items WHERE login = ? AND repo_full_name = ?').bind(session.login, tracked.fullName),
        env.DB.prepare('DELETE FROM sync_state WHERE login = ? AND repo_full_name = ?').bind(session.login, tracked.fullName),
        env.DB.prepare('DELETE FROM reports WHERE login = ? AND repo_full_name = ?').bind(session.login, tracked.fullName),
      ]);
      return json({ ok: true, removed: tracked.fullName });
    }

    if (action === '/sync' && method === 'POST') {
      await enforceRateLimit(env, request, 'sync', 5);
      const tracked = await requireTrackedRepo(env, session.login, repoFullName);
      const result = await syncRepo(env, session.login, session.token, tracked.fullName);
      return json({
        repo: result.repo,
        items: result.items,
        incremental: result.incremental,
        fetchedAt: new Date().toISOString(),
        mode: 'live',
      });
    }

    if (action === '/dashboard' && method === 'GET') {
      await enforceRateLimit(env, request, 'read');
      const tracked = await requireTrackedRepo(env, session.login, repoFullName);
      const items = await readCachedItems(env, session.login, tracked.fullName);
      return json({ repo: tracked, items, fetchedAt: new Date().toISOString(), mode: 'live' });
    }

    if (action === '/report' && method === 'GET') {
      await enforceRateLimit(env, request, 'read', 2);
      const tracked = await requireTrackedRepo(env, session.login, repoFullName);
      const items = await readCachedItems(env, session.login, tracked.fullName);
      if (items.length === 0) {
        throw new ApiError(409, 'NO_DATA', 'No cached items yet — run a sync first.');
      }
      const thresholds = parseThresholds(url);
      const report = buildWeeklyReport(tracked.fullName, items, thresholds);
      const windowKey = `${thresholds.staleDays}-${thresholds.doneDays}-${new Date().toISOString().slice(0, 10)}`;
      await env.DB.prepare(
        `INSERT INTO reports (login, repo_full_name, window_key, payload, generated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(login, repo_full_name, window_key) DO UPDATE SET payload = excluded.payload, generated_at = excluded.generated_at`,
      )
        .bind(session.login, tracked.fullName, windowKey, JSON.stringify(report), report.generatedAt)
        .run();
      return json({ report });
    }

    if (action === '/state' && method === 'GET') {
      await enforceRateLimit(env, request, 'read');
      const tracked = await requireTrackedRepo(env, session.login, repoFullName);
      const state = await readSyncState(env, session.login, tracked.fullName);
      return json({ state });
    }
  }

  // ---- diagnostics ----
  if (path === '/api/health' && method === 'GET') {
    const session = await loadSession(env, request);
    return json({
      ok: true,
      app: env.APP_NAME,
      mode: session ? 'live' : 'demo',
      oauthConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      serverTime: new Date().toISOString(),
    });
  }

  throw new ApiError(404, 'NOT_FOUND', `No route for ${method} ${path}`);
}
