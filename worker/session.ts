/**
 * Session handling.
 *
 * The browser only ever holds an opaque session id in an HttpOnly, Secure,
 * SameSite=Lax cookie. The GitHub token lives encrypted in D1 and is decrypted
 * per-request inside the worker. There is no endpoint that returns a token.
 */
import { ApiError, type Env } from './env';
import { openToken, randomId, sealToken } from './crypto';

export const COOKIE_NAME = 'repoops_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export interface Session {
  sid: string;
  login: string;
  avatarUrl: string | null;
  scopes: string[];
  token: string;
  tokenExpiresAt: string | null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(sid: string, maxAgeSeconds: number, origin: string): string {
  const secure = origin.startsWith('https://') ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearCookie(origin: string): string {
  return sessionCookie('', 0, origin) + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

function secretOrThrow(env: Env): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
    throw new ApiError(
      500,
      'MISSING_SECRET',
      'SESSION_SECRET is not configured on this deployment, so sessions cannot be stored safely.',
    );
  }
  return env.SESSION_SECRET;
}

export async function createSession(
  env: Env,
  data: { login: string; avatarUrl: string | null; scopes: string[]; token: string; tokenExpiresAt: string | null },
): Promise<string> {
  const secret = secretOrThrow(env);
  const sealed = await sealToken(data.token, secret);
  const sid = randomId(32);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (sid, login, avatar_url, scopes, token_cipher, token_iv, token_expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(sid, data.login, data.avatarUrl, data.scopes.join(','), sealed.cipher, sealed.iv, data.tokenExpiresAt, now, now)
    .run();
  return sid;
}

export async function loadSession(env: Env, request: Request): Promise<Session | null> {
  const sid = readCookie(request, COOKIE_NAME);
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT sid, login, avatar_url, scopes, token_cipher, token_iv, token_expires_at, created_at, last_seen_at
     FROM sessions WHERE sid = ?`,
  )
    .bind(sid)
    .first<{
      sid: string;
      login: string;
      avatar_url: string | null;
      scopes: string;
      token_cipher: string;
      token_iv: string;
      token_expires_at: string | null;
      created_at: string;
      last_seen_at: string;
    }>();
  if (!row) return null;

  const age = Date.now() - Date.parse(row.created_at);
  if (!Number.isFinite(age) || age > SESSION_TTL_MS) {
    await destroySession(env, sid);
    return null;
  }

  const secret = secretOrThrow(env);
  let token: string;
  try {
    token = await openToken({ cipher: row.token_cipher, iv: row.token_iv }, secret);
  } catch {
    // Key rotation or corrupted row: force a re-login instead of crashing.
    await destroySession(env, sid);
    return null;
  }

  return {
    sid: row.sid,
    login: row.login,
    avatarUrl: row.avatar_url,
    scopes: row.scopes ? row.scopes.split(',').filter(Boolean) : [],
    token,
    tokenExpiresAt: row.token_expires_at,
  };
}

export async function requireSession(env: Env, request: Request): Promise<Session> {
  const session = await loadSession(env, request);
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Connect GitHub first — no active session.');
  return session;
}

export async function destroySession(env: Env, sid: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE sid = ?').bind(sid).run();
}

/**
 * "Disconnect" also purges everything derived from the account: tracked repos,
 * cached items, sync state and reports. Required by the privacy policy.
 */
export async function purgeAccountData(env: Env, login: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE login = ?').bind(login),
    env.DB.prepare('DELETE FROM tracked_repos WHERE login = ?').bind(login),
    env.DB.prepare('DELETE FROM cached_items WHERE login = ?').bind(login),
    env.DB.prepare('DELETE FROM sync_state WHERE login = ?').bind(login),
    env.DB.prepare('DELETE FROM reports WHERE login = ?').bind(login),
  ]);
}
