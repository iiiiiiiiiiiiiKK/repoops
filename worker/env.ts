/** Worker bindings + vars. Kept in one place so every module agrees. */

export interface Env {
  // Cloudflare resources
  DB: D1Database;
  ASSETS: Fetcher;
  RATE_LIMITER: DurableObjectNamespace;

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

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  return json({ error: { code: 'INTERNAL', message } }, { status: 500 });
}
