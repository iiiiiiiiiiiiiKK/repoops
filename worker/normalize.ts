/**
 * Convert raw GitHub payloads into the flat NormalizedItem shape used by the UI.
 * Kept pure so the mapping rules are unit-testable without any network.
 */
import type { NormalizedItem } from '../shared/types';
import type { GhIssue } from './github';

const MAX_BODY = 800;

export function normalizeLabels(labels: GhIssue['labels']): { name: string; color: string }[] {
  const out: { name: string; color: string }[] = [];
  for (const label of labels ?? []) {
    if (typeof label === 'string') out.push({ name: label, color: 'ededed' });
    else if (label?.name) out.push({ name: label.name, color: label.color ?? 'ededed' });
  }
  return out;
}

export function normalizeItem(
  repoFullName: string,
  raw: GhIssue,
  extra: { reviewDecision?: string | null } = {},
): NormalizedItem {
  const kind = raw.pull_request ? 'pr' : 'issue';
  const body = raw.body ? raw.body.slice(0, MAX_BODY) : null;
  const state: 'open' | 'closed' = raw.state === 'closed' || raw.pull_request?.merged_at ? 'closed' : 'open';
  return {
    id: `${repoFullName}#${raw.number}`,
    repo: repoFullName,
    number: raw.number,
    kind,
    title: raw.title,
    body,
    state,
    htmlUrl: raw.html_url,
    author: raw.user?.login ?? 'ghost',
    authorAvatar: raw.user?.avatar_url ?? null,
    labels: normalizeLabels(raw.labels),
    assignees: (raw.assignees ?? []).map((a) => a.login),
    commentsCount: raw.comments ?? 0,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
    isDraft: Boolean(raw.draft),
    reviewDecision:
      kind === 'pr'
        ? ((extra.reviewDecision as NormalizedItem['reviewDecision']) ?? null)
        : null,
    requestedReviewers: (raw.requested_reviewers ?? []).map((r) => r.login),
    hasOtherParticipants: (raw.comments ?? 0) > 0,
    mergedAt: raw.pull_request?.merged_at ?? null,
  };
}

/**
 * Dedupe by `repo#number`, keeping the freshest record. GitHub can return the
 * same issue once per label filter, so callers must dedupe before rendering.
 */
export function dedupeItems(items: NormalizedItem[]): NormalizedItem[] {
  const map = new Map<string, NormalizedItem>();
  for (const item of items) {
    const prev = map.get(item.id);
    if (!prev || Date.parse(item.updatedAt) >= Date.parse(prev.updatedAt)) map.set(item.id, item);
  }
  return [...map.values()];
}

export interface LinkHeaderPages {
  next: string | null;
  last: string | null;
  page: number;
}

/** Parse GitHub's RFC 5988 `link` header without trusting arbitrary URLs. */
export function parseLinkHeader(header: string | null, currentPage: number): LinkHeaderPages {
  const out: LinkHeaderPages = { next: null, last: null, page: currentPage };
  if (!header) return out;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (!match) continue;
    const [, url, rel] = match;
    if (rel === 'next') {
      out.next = url;
      const p = url.match(/[?&]page=(\d+)/);
      if (p) out.page = Number(p[1]);
    }
    if (rel === 'last') out.last = url;
  }
  return out;
}

/** True when the `link` header has no `next` — i.e. we reached the last page. */
export function isLastPage(header: string | null, currentPage: number): boolean {
  return parseLinkHeader(header, currentPage).next === null;
}
