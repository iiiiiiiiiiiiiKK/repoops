/**
 * Shared domain types for RepoOps.
 * Used by the worker (API) and the React client so both sides agree on shapes.
 */

export type ItemKind = 'issue' | 'pr';

/** Board columns. Order matters: it is the render order. */
export type Bucket = 'triage' | 'review' | 'author' | 'stalled' | 'done';

export const BUCKET_ORDER: Bucket[] = ['triage', 'review', 'author', 'stalled', 'done'];

export const BUCKET_META: Record<Bucket, { zh: string; en: string; hint: string }> = {
  triage: { zh: '待处理', en: 'Needs triage', hint: '还没有进入审查流程的事项' },
  review: { zh: '等待审查', en: 'Waiting for review', hint: '需要维护者亲自过一眼' },
  author: { zh: '等待作者', en: 'Waiting for author', hint: '球在作者那边' },
  stalled: { zh: '已停滞', en: 'Stalled', hint: '超过停滞阈值没有任何更新' },
  done: { zh: '近期完成', en: 'Recently done', hint: '窗口期内关闭或合并' },
};

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  description?: string | null;
  stargazers?: number | null;
  isPrivate?: boolean | null;
  pushedAt?: string | null;
  language?: string | null;
}

export interface NormalizedItem {
  /** `${repoFullName}#${number}` — stable across syncs. */
  id: string;
  repo: string;
  number: number;
  kind: ItemKind;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  htmlUrl: string;
  author: string;
  authorAvatar: string | null;
  labels: { name: string; color: string }[];
  assignees: string[];
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** PR-only */
  isDraft: boolean;
  /** PR-only: GitHub's review decision, null for issues. */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  /** PR-only: reviewers still pending */
  requestedReviewers: string[];
  /** Whether the item was ever commented on by someone other than the author. */
  hasOtherParticipants: boolean;
  /** Merged at, PR-only. */
  mergedAt: string | null;
}

export interface SyncError {
  message: string;
  at: string;
  code?: string;
}

export interface SyncState {
  repo: string;
  lastSyncAt: string | null;
  /** Items captured across the last full/incremental sync. */
  itemCount: number;
  /** How many GitHub pages were consumed in the last run. */
  pagesFetched: number;
  /** True when the last run reached the end of pagination. */
  complete: boolean;
  /** Where the next incremental run starts (GitHub cursor). */
  cursor: string | null;
  errors: SyncError[];
  rateLimit: RateLimitSnapshot | null;
  lastRunDurationMs: number | null;
  mode: 'live' | 'demo';
}

export interface RateLimitSnapshot {
  limit: number;
  remaining: number;
  used: number;
  resetAt: string;
  resource: string;
}

export interface TrackerRepo extends RepoRef {
  addedAt: string;
  sync: SyncState;
}

export interface DashboardPayload {
  repo: TrackerRepo;
  items: NormalizedItem[];
  fetchedAt: string;
  mode: 'live' | 'demo';
}

export interface BoardThresholds {
  /** Days without activity before an item is considered stalled. */
  staleDays: number;
  /** Days back to look for recently completed work. */
  doneDays: number;
}

export const DEFAULT_THRESHOLDS: BoardThresholds = { staleDays: 30, doneDays: 14 };

export interface WeeklyReport {
  repo: string;
  generatedAt: string;
  windowFrom: string;
  windowTo: string;
  thresholds: BoardThresholds;
  totals: {
    open: number;
    issues: number;
    prs: number;
    openedInWindow: number;
    closedInWindow: number;
    mergedInWindow: number;
    stalled: number;
    awaitingReview: number;
    awaitingAuthor: number;
    unlabelled: number;
    unassigned: number;
  };
  buckets: Record<Bucket, number>;
  topLabels: { name: string; count: number }[];
  busiestAuthors: { login: string; count: number }[];
  oldestStalled: { id: string; title: string; repo: string; number: number; days: number; htmlUrl: string }[];
  healthScore: number;
  notes: string[];
}

export interface SessionInfo {
  authenticated: boolean;
  login: string | null;
  avatarUrl: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  mode: 'live' | 'demo';
  appName: string;
  oauthConfigured: boolean;
  demoRepo: string;
}
