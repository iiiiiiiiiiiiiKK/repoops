/** Worker bindings + vars. Kept in one place so every module agrees. */

export interface Env {
  // Cloudflare resources
  DB: D1Database;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc)
  APP_NAME: string;
  DEMO_REPO: string;
  GITHUB_API_BASE: string;
  OAUTH_REDIRECT_PATH: string;

  // Secrets (wrangler secret put ...) — never committed
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Optional server-side token used only for read-only demo data. */
  GITHUB_TOKEN?: string;
  /** Key material for encrypting OAuth tokens at rest in D1. */
  SESSION_SECRET?: string;
  /** Optional extra origin allowed for OAuth redirect, e.g. https://repoops.example.workers.dev */
  APP_ORIGIN?: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** JSON with a public cache lifetime (used for the edge-cached demo snapshot). */
export function jsonCacheable(data: unknown, maxAgeSeconds: number, extra: Record<string, string> = {}): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', `public, max-age=${maxAgeSeconds}`);
  return new Response(JSON.stringify(data), { status: 200, headers });
}

/**
 * D1 reports quota exhaustion as an opaque SQL error string that would otherwise
 * leak to the browser. Detect it so we can answer with an honest 503 instead of
 * a raw `D1_ERROR: ...` dump.
 */
export function isDbQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /exceeded D1'?s? .*limit|daily row read limit|Too many requests|D1_ERROR/i.test(msg);
}

/** Turn any storage failure into a typed, user-actionable error. */
export function dbError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (isDbQuotaError(err)) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    return new ApiError(
      503,
      'DB_QUOTA_EXCEEDED',
      '数据库今日读取配额已用尽（Cloudflare D1 免费额度），UTC 次日 00:00 自动恢复。演示数据仍可浏览，登录态相关功能暂时不可用。',
      { resetsAt: midnight.toISOString() },
    );
  }
  return new ApiError(503, 'DB_UNAVAILABLE', `数据库暂时不可用：${msg.slice(0, 200)}`);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, { status: err.status });
  }
  if (isDbQuotaError(err)) {
    return errorResponse(dbError(err));
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  return json({ error: { code: 'INTERNAL', message } }, { status: 500 });
}
