/** Typed client for the RepoOps worker API. */

import type {
  BoardThresholds,
  DashboardPayload,
  NormalizedItem,
  SessionInfo,
  SyncState,
  TrackerRepo,
  WeeklyReport,
} from '../shared/types';

export class ApiClientError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  } catch (err) {
    throw new ApiClientError(0, 'NETWORK', `Network unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
    try {
      payload = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    } catch {
      payload = null;
    }
    throw new ApiClientError(
      res.status,
      payload?.error?.code ?? 'HTTP_ERROR',
      payload?.error?.message ?? `Request failed with ${res.status}`,
      payload?.error?.details ?? null,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  session: () => request<SessionInfo>('/api/session'),

  demo: (repo: string) =>
    request<{
      mode: 'demo';
      repo: TrackerRepo;
      items: NormalizedItem[];
      fetchedAt: string;
      stale: boolean;
      notice: string;
    }>(`/api/demo?repo=${encodeURIComponent(repo)}`),

  repos: () => request<{ repos: TrackerRepo[] }>('/api/repos'),

  addRepo: (repo: string) =>
    request<{ repo: TrackerRepo; itemCount: number }>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({ repo }),
    }),

  removeRepo: (fullName: string) => {
    const [owner, name] = fullName.split('/');
    return request<{ ok: boolean; removed: string }>(`/api/repos/${owner}/${name}`, { method: 'DELETE' });
  },

  sync: (fullName: string) => {
    const [owner, name] = fullName.split('/');
    return request<DashboardPayload & { incremental: boolean }>(`/api/repos/${owner}/${name}/sync`, { method: 'POST' });
  },

  dashboard: (fullName: string) => {
    const [owner, name] = fullName.split('/');
    return request<DashboardPayload>(`/api/repos/${owner}/${name}/dashboard`);
  },

  state: (fullName: string) => {
    const [owner, name] = fullName.split('/');
    return request<{ state: SyncState | null }>(`/api/repos/${owner}/${name}/state`);
  },

  report: (fullName: string, thresholds: BoardThresholds) => {
    const [owner, name] = fullName.split('/');
    return request<{ report: WeeklyReport }>(
      `/api/repos/${owner}/${name}/report?staleDays=${thresholds.staleDays}&doneDays=${thresholds.doneDays}`,
    );
  },

  tokenLogin: (token: string) =>
    request<{ ok: boolean; login: string; scopes: string[] }>('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  logout: () => request<{ ok: boolean; purged: boolean }>('/api/auth/logout', { method: 'POST' }),
};
