/** Factory for NormalizedItem fixtures used across the unit tests. */
import type { NormalizedItem } from '../../shared/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

export function makeItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  const number = overrides.number ?? 1;
  return {
    id: `acme/widgets#${number}`,
    repo: 'acme/widgets',
    number,
    kind: 'issue',
    title: `Item ${number}`,
    body: 'body',
    state: 'open',
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
    author: 'contributor',
    authorAvatar: null,
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: ['maintainer'],
    commentsCount: 0,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(1),
    closedAt: null,
    isDraft: false,
    reviewDecision: null,
    requestedReviewers: [],
    hasOtherParticipants: false,
    mergedAt: null,
    ...overrides,
  };
}

export function makePr(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return makeItem({
    kind: 'pr',
    htmlUrl: 'https://github.com/acme/widgets/pull/1',
    ...overrides,
  });
}
