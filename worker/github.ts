/**
 * Minimal, strictly read-only GitHub REST/GraphQL client.
 *
 * Invariants enforced here (see tests/integration for the assertions):
 *  - only GET requests reach the REST API, only `query` operations reach GraphQL
 *  - the base URL is fixed to api.github.com, so callers can never point the
 *    worker at an arbitrary host (SSRF guard)
 *  - every response is classified into a small error vocabulary the UI can act on
 */
import { ApiError } from './env';
import type { RateLimitSnapshot } from '../shared/types';

export interface GhResponse<T> {  status: number;
  data: T | null;
  headers: Headers;
  rateLimit: RateLimitSnapshot | null;
}

export function parseRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const used = headers.get('x-ratelimit-used');
  const reset = headers.get('x-ratelimit-reset');
  if (!limit || !remaining) return null;
  const resetSec = Number(reset ?? 0);
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    used: Number(used ?? 0),
    resetAt: new Date((Number.isFinite(resetSec) ? resetSec : 0) * 1000).toISOString(),
    resource: headers.get('x-ratelimit-resource') ?? 'core',
  };
}

const ALLOWED_HOST = 'api.github.com';

/**
 * Build a URL on api.github.com. `path` must be a relative API path; any
 * attempt to supply a scheme or host is rejected, which is the SSRF boundary.
 */
export function buildApiUrl(base: string, path: string, params?: Record<string, string | number | undefined>): URL {
  if (/^[a-z]+:\/\//i.test(path) || path.startsWith('//')) {
    throw new ApiError(400, 'BAD_URL', 'Only relative GitHub API paths are allowed');
  }
  const url = new URL(base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path));
  if (url.hostname !== ALLOWED_HOST) {
    throw new ApiError(400, 'BAD_URL', `Refusing to call ${url.hostname}`);
  }
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url;
}

function classify(status: number, rateLimit: RateLimitSnapshot | null, body: unknown): ApiError {
  let message = `GitHub responded ${status}`;
  if (body && typeof body === 'object' && 'message' in body) {
    const raw = (body as { message: unknown }).message;
    if (typeof raw === 'string' && raw.length > 0) message = raw;
  }
  if (status === 401) return new ApiError(401, 'TOKEN_INVALID', 'GitHub token is invalid, expired or revoked.');
  if (status === 403 && rateLimit && rateLimit.remaining === 0) {
    return new ApiError(429, 'RATE_LIMITED', `GitHub API rate limit exhausted, resets at ${rateLimit.resetAt}`, rateLimit);
  }
  if (status === 403) return new ApiError(403, 'FORBIDDEN', message);
  if (status === 404) return new ApiError(404, 'NOT_FOUND', 'Repository not found or not visible to this token.');
  if (status === 429) return new ApiError(429, 'RATE_LIMITED', message, rateLimit);
  if (status >= 500) return new ApiError(502, 'GITHUB_UNAVAILABLE', `GitHub is unavailable (${status}).`);
  return new ApiError(status, 'GITHUB_ERROR', message);
}

export async function ghGet<T>(
  base: string,
  token: string | null,
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<GhResponse<T>> {
  const url = buildApiUrl(base, path, params);
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    'user-agent': 'repoops-maintainer-war-room',
    'x-github-api-version': '2022-11-28',
  });
  if (token) headers.set('authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(url.toString(), { method: 'GET', headers });
  } catch (err) {
    throw new ApiError(503, 'NETWORK_ERROR', `Cannot reach GitHub: ${(err as Error).message}`);
  }

  const rateLimit = parseRateLimit(res.headers);
  if (res.status >= 400) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw classify(res.status, rateLimit, body);
  }
  const data = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, data, headers: res.headers, rateLimit };
}

/**
 * GraphQL is used for exactly one thing: `reviewDecision`, which the REST
 * issues/pulls endpoints do not expose. The query shape is fixed in code —
 * no caller-supplied GraphQL text ever reaches the API.
 */
export async function ghGraphqlPullDecisions(
  token: string,
  owner: string,
  name: string,
): Promise<{ decisions: Map<number, { reviewDecision: string | null; isDraft: boolean }>; rateLimit: RateLimitSnapshot | null }> {
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number reviewDecision isDraft}}}}`;
  let res: Response;
  try {
    res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'repoops-maintainer-war-room',
      },
      body: JSON.stringify({ query, variables: { owner, name } }),
    });
  } catch (err) {
    throw new ApiError(503, 'NETWORK_ERROR', `Cannot reach GitHub GraphQL: ${(err as Error).message}`);
  }
  const rateLimit = parseRateLimit(res.headers);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw classify(res.status, rateLimit, body);
  }
  const payload = (await res.json().catch(() => null)) as {
    data?: { repository?: { pullRequests?: { nodes?: { number: number; reviewDecision: string | null; isDraft: boolean }[] } } };
    errors?: { message: string }[];
  } | null;

  const decisions = new Map<number, { reviewDecision: string | null; isDraft: boolean }>();
  const nodes = payload?.data?.repository?.pullRequests?.nodes ?? [];
  for (const node of nodes) decisions.set(node.number, { reviewDecision: node.reviewDecision, isDraft: node.isDraft });
  return { decisions, rateLimit };
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  labels: (string | { name?: string; color?: string })[];
  user: { login: string; avatar_url: string } | null;
  assignees: { login: string }[] | null;
  draft?: boolean;
  pull_request?: { merged_at: string | null; html_url: string };
  requested_reviewers?: { login: string }[] | null;
}
