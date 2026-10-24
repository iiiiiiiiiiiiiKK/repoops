/**
 * OAuth + session routes.
 *
 * Scope policy (minimum necessary):
 *   default  -> `read:user public_repo`  (public repositories only)
 *   private  -> `read:user repo`         (explicit opt-in for private repos)
 *
 * The authorization code is exchanged server-side; the access token is sealed
 * with AES-GCM and written to D1. It is never sent to the browser.
 */
import { ApiError, json, type Env } from './env';
import { randomId, safeEqual } from './crypto';
import { clearCookie, createSession, destroySession, loadSession, purgeAccountData, requireSession, sessionCookie } from './session';
import type { SessionInfo } from '../shared/types';

const STATE_COOKIE = 'repoops_oauth_state';
const STATE_TTL = 600;

function originOf(request: Request, env: Env): string {
  const configured = env.APP_ORIGIN;
  if (configured) return configured.replace(/\/$/, '');
  const url = new URL(request.url);
  return url.origin;
}

export function callbackUrl(request: Request, env: Env): string {
  return originOf(request, env) + env.OAUTH_REDIRECT_PATH;
}

export async function handleSessionInfo(env: Env, request: Request): Promise<Response> {
  const session = await loadSession(env, request);
  const oauthConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  const info: SessionInfo = {
    authenticated: Boolean(session),
    login: session?.login ?? null,
    avatarUrl: session?.avatarUrl ?? null,
    scopes: session?.scopes ?? [],
    tokenExpiresAt: session?.tokenExpiresAt ?? null,
    mode: session ? 'live' : 'demo',
    appName: env.APP_NAME,
    oauthConfigured,
    demoRepo: env.DEMO_REPO,
  };
  return json(info);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID) {
    throw new ApiError(
      501,
      'OAUTH_NOT_CONFIGURED',
      'GITHUB_CLIENT_ID is not set on this deployment. Use token sign-in or the public demo instead.',
    );
  }
  const url = new URL(request.url);
  const wantsPrivate = url.searchParams.get('private') === '1';
  const scope = wantsPrivate ? 'read:user repo' : 'read:user public_repo';
  const state = randomId(24);
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', callbackUrl(request, env));
  authorize.searchParams.set('scope', scope);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'false');

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL}${
        originOf(request, env).startsWith('https://') ? '; Secure' : ''
      }`,
      'cache-control': 'no-store',
    },
  });
}

function readCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const origin = originOf(request, env);
  const failRedirect = (reason: string) => {
    const target = new URL(origin);
    target.searchParams.set('auth', 'error');
    target.searchParams.set('reason', reason);
    return new Response(null, {
      status: 302,
      headers: { location: target.toString(), 'set-cookie': clearCookie(origin), 'cache-control': 'no-store' },
    });
  };

  if (oauthError) return failRedirect(oauthError);
  const expected = readCookieValue(request, STATE_COOKIE);
  if (!state || !expected || !safeEqual(state, expected)) return failRedirect('state_mismatch');
  if (!code) return failRedirect('missing_code');
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return failRedirect('oauth_not_configured');

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'repoops' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl(request, env),
      }),
    });
  } catch {
    return failRedirect('token_endpoint_unreachable');
  }

  const payload = (await tokenResponse.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  } | null;

  if (!payload?.access_token) {
    return failRedirect(payload?.error ?? 'no_access_token');
  }

  const profile = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${payload.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'repoops',
    },
  });
  if (!profile.ok) return failRedirect(`profile_${profile.status}`);
  const me = (await profile.json()) as { login: string; avatar_url: string };
  const avatar = me.avatar_url ?? null;

  const scopes = (payload.scope ?? '').split(/[,\s]+/).filter(Boolean);
  const expiresAt = payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null;
  const sid = await createSession(env, { login: me.login, avatarUrl: avatar, scopes, token: payload.access_token, tokenExpiresAt: expiresAt });

  const target = new URL(origin);
  target.searchParams.set('auth', 'ok');
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      'set-cookie': sessionCookie(sid, STATE_TTL * 2 * 24 * 7, origin),
      'cache-control': 'no-store',
    },
  });
}

/**
 * Token sign-in fallback.
 *
 * Some maintainers already have a fine-grained PAT and would rather not create
 * an OAuth App. The token is validated against /user, then stored exactly like
 * an OAuth token (encrypted). This is opt-in and documented as the fallback.
 */
export async function handleTokenLogin(env: Env, request: Request): Promise<Response> {
  let body: { token?: string } = {};
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    throw new ApiError(400, 'BAD_BODY', 'Expected a JSON body of the form {"token":"ghp_..."}');
  }
  const token = (body.token ?? '').trim();
  if (!token) throw new ApiError(400, 'MISSING_TOKEN', 'A GitHub token is required.');
  if (token.length < 20 || /\s/.test(token)) throw new ApiError(400, 'BAD_TOKEN', 'That does not look like a GitHub token.');

  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'repoops' },
  });
  if (res.status === 401) throw new ApiError(401, 'TOKEN_INVALID', 'GitHub rejected this token (401).');
  if (!res.ok) throw new ApiError(502, 'GITHUB_ERROR', `GitHub returned ${res.status} while validating the token.`);

  const me = (await res.json()) as { login: string; avatar_url: string };
  const scopesHeader = res.headers.get('x-oauth-scopes') ?? '';
  const sid = await createSession(env, {
    login: me.login,
    avatarUrl: me.avatar_url ?? null,
    scopes: scopesHeader.split(/[,\s]+/).filter(Boolean),
    token,
    tokenExpiresAt: null,
  });

  return json(
    { ok: true, login: me.login, scopes: scopesHeader.split(/[,\s]+/).filter(Boolean) },
    { headers: { 'set-cookie': sessionCookie(sid, STATE_TTL * 2 * 24 * 7, originOf(request, env)) } },
  );
}

/**
 * Disconnect: destroy the session and delete every row derived from the
 * account (tracked repos, cached items, sync state, reports).
 */
export async function handleLogout(env: Env, request: Request): Promise<Response> {
  const session = await requireSession(env, request);
  await purgeAccountData(env, session.login);
  await destroySession(env, session.sid);
  return json(
    { ok: true, purged: true },
    { headers: { 'set-cookie': clearCookie(originOf(request, env)) } },
  );
}
