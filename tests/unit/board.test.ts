import { describe, expect, it } from 'vitest';
import {
  boardItems,
  bucketOf,
  buildWeeklyReport,
  daysSince,
  draftChecklist,
  draftComment,
  groupByBucket,
  healthScore,
  matchesFilters,
  reportToMarkdown,
  sortItems,
  EMPTY_FILTERS,
  type FilterState,
} from '../../shared/board';
import { BUCKET_ORDER, DEFAULT_THRESHOLDS, type NormalizedItem } from '../../shared/types';
import { daysAgo, makeItem, makePr } from './fixtures';

const T = DEFAULT_THRESHOLDS;

describe('daysSince', () => {
  it('returns 0 for null/invalid and never goes negative', () => {
    expect(daysSince(null)).toBe(0);
    expect(daysSince('not-a-date')).toBe(0);
    expect(daysSince(new Date(Date.now() + 86_400_000).toISOString())).toBe(0);
  });

  it('counts whole days', () => {
    expect(daysSince(daysAgo(5))).toBe(5);
    expect(daysSince(daysAgo(0))).toBe(0);
  });
});

describe('bucketOf', () => {
  it('puts a fresh labelled+assigned issue in "author"', () => {
    expect(bucketOf(makeItem({ updatedAt: daysAgo(2) }), T)).toBe('author');
  });

  it('puts an unlabelled issue in "triage"', () => {
    expect(bucketOf(makeItem({ labels: [] }), T)).toBe('triage');
  });

  it('puts an unassigned issue in "triage"', () => {
    expect(bucketOf(makeItem({ assignees: [] }), T)).toBe('triage');
  });

  it('puts an open PR in "review"', () => {
    expect(bucketOf(makePr({ updatedAt: daysAgo(1) }), T)).toBe('review');
  });

  it('puts a draft PR in "author"', () => {
    expect(bucketOf(makePr({ isDraft: true, updatedAt: daysAgo(1) }), T)).toBe('author');
  });

  it('puts a CHANGES_REQUESTED PR in "author"', () => {
    expect(bucketOf(makePr({ reviewDecision: 'CHANGES_REQUESTED', updatedAt: daysAgo(1) }), T)).toBe('author');
  });

  it('marks anything idle beyond the threshold as stalled', () => {
    expect(bucketOf(makeItem({ updatedAt: daysAgo(31) }), T)).toBe('stalled');
    expect(bucketOf(makePr({ updatedAt: daysAgo(31) }), T)).toBe('stalled');
    // exactly at the threshold is not yet stalled
    expect(bucketOf(makeItem({ updatedAt: daysAgo(30) }), T)).not.toBe('stalled');
  });

  it('honours a custom stale threshold', () => {
    const strict = { staleDays: 7, doneDays: 14 };
    expect(bucketOf(makeItem({ updatedAt: daysAgo(10) }), strict)).toBe('stalled');
    expect(bucketOf(makeItem({ updatedAt: daysAgo(10) }), T)).toBe('author');
  });

  it('keeps closed items out of the open flow', () => {
    const closed = makeItem({ state: 'closed', closedAt: daysAgo(3) });
    expect(bucketOf(closed, T)).toBe('done');
  });
});

describe('boardItems / groupByBucket', () => {
  const items = [
    makeItem({ number: 1, updatedAt: daysAgo(1) }),
    makePr({ number: 2, updatedAt: daysAgo(1) }),
    makeItem({ number: 3, updatedAt: daysAgo(90) }),
    makeItem({ number: 4, state: 'closed', closedAt: daysAgo(2), mergedAt: null }),
    makeItem({ number: 5, state: 'closed', closedAt: daysAgo(200) }),
  ];

  it('drops closed items outside the done window', () => {
    const onBoard = boardItems(items, T);
    expect(onBoard.map((i) => i.number)).not.toContain(5);
    expect(onBoard.map((i) => i.number)).toContain(4);
  });

  it('groups every item into exactly one bucket and preserves the total', () => {
    const grouped = groupByBucket(boardItems(items, T), T);
    const total = BUCKET_ORDER.reduce((sum, b) => sum + grouped[b].length, 0);
    expect(total).toBe(boardItems(items, T).length);
    expect(grouped.review.map((i) => i.number)).toEqual([2]);
    expect(grouped.stalled.map((i) => i.number)).toEqual([3]);
    expect(grouped.done.map((i) => i.number)).toEqual([4]);
  });
});

describe('matchesFilters', () => {
  const item = makeItem({
    number: 42,
    title: 'Crash on startup with large config',
    body: 'stacktrace mentions parser',
    author: 'alice',
    labels: [
      { name: 'bug', color: 'd73a4a' },
      { name: 'p1', color: 'ff0000' },
    ],
    assignees: ['bob'],
    updatedAt: daysAgo(40),
  });

  const f = (over: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTERS, ...over });

  it('matches an empty filter', () => {
    expect(matchesFilters(item, EMPTY_FILTERS, T)).toBe(true);
  });

  it('searches number, title, body, author and labels', () => {
    expect(matchesFilters(item, f({ query: '#42' }), T)).toBe(true);
    expect(matchesFilters(item, f({ query: 'crash' }), T)).toBe(true);
    expect(matchesFilters(item, f({ query: 'parser' }), T)).toBe(true);
    expect(matchesFilters(item, f({ query: 'alice' }), T)).toBe(true);
    expect(matchesFilters(item, f({ query: 'p1' }), T)).toBe(true);
    expect(matchesFilters(item, f({ query: 'nope' }), T)).toBe(false);
  });

  it('requires every search term (AND semantics)', () => {
    expect(matchesFilters(item, f({ query: 'crash config' }), T)).toBe(true);
    expect(matchesFilters(item, f({ query: 'crash missing' }), T)).toBe(false);
  });

  it('filters by label and assignee', () => {
    expect(matchesFilters(item, f({ labels: ['bug'] }), T)).toBe(true);
    expect(matchesFilters(item, f({ labels: ['bug', 'p1'] }), T)).toBe(true);
    expect(matchesFilters(item, f({ labels: ['bug', 'docs'] }), T)).toBe(false);
    expect(matchesFilters(item, f({ assignees: ['bob'] }), T)).toBe(true);
    expect(matchesFilters(item, f({ assignees: ['carol'] }), T)).toBe(false);
  });

  it('filters by kind and staleness', () => {
    expect(matchesFilters(item, f({ kinds: ['pr'] }), T)).toBe(false);
    expect(matchesFilters(item, f({ kinds: ['issue'] }), T)).toBe(true);
    expect(matchesFilters(item, f({ age: 'stalled' }), T)).toBe(true);
    expect(matchesFilters(item, f({ age: 'fresh' }), T)).toBe(false);
  });

  it('hides closed items when showClosed is false', () => {
    const closed = makeItem({ state: 'closed', closedAt: daysAgo(1) });
    expect(matchesFilters(closed, f({}), T)).toBe(true);
    expect(matchesFilters(closed, f({ showClosed: false }), T)).toBe(false);
  });
});

describe('sortItems', () => {
  const a = makeItem({ number: 1, updatedAt: daysAgo(10), createdAt: daysAgo(100), commentsCount: 3 });
  const b = makeItem({ number: 2, updatedAt: daysAgo(1), createdAt: daysAgo(50), commentsCount: 9 });
  const c = makeItem({ number: 3, updatedAt: daysAgo(40), createdAt: daysAgo(10), commentsCount: 0 });
  const list: NormalizedItem[] = [a, b, c];

  it('sorts by updated desc (default)', () => {
    expect(sortItems(list, 'updated-desc').map((i) => i.number)).toEqual([2, 1, 3]);
  });
  it('sorts by updated asc', () => {
    expect(sortItems(list, 'updated-asc').map((i) => i.number)).toEqual([3, 1, 2]);
  });
  it('sorts by created desc', () => {
    expect(sortItems(list, 'created-desc').map((i) => i.number)).toEqual([3, 2, 1]);
  });
  it('sorts by comments desc', () => {
    expect(sortItems(list, 'comments-desc').map((i) => i.number)).toEqual([2, 1, 3]);
  });
  it('sorts by number asc', () => {
    expect(sortItems([c, a, b], 'number-asc').map((i) => i.number)).toEqual([1, 2, 3]);
  });
  it('does not mutate the input array', () => {
    const before = list.map((i) => i.number);
    sortItems(list, 'number-asc');
    expect(list.map((i) => i.number)).toEqual(before);
  });
});

describe('healthScore', () => {
  it('is 100 with an empty queue', () => {
    expect(healthScore({ triage: 0, review: 0, author: 0, stalled: 0, done: 0 }, 0)).toBe(100);
  });
  it('drops when everything is stalled', () => {
    expect(healthScore({ triage: 0, review: 0, author: 0, stalled: 10, done: 0 }, 10)).toBeLessThan(50);
  });
  it('stays within 0..100', () => {
    const score = healthScore({ triage: 10, review: 10, author: 10, stalled: 10, done: 0 }, 40);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('buildWeeklyReport', () => {
  const items: NormalizedItem[] = [
    makeItem({ number: 1, updatedAt: daysAgo(2), labels: [{ name: 'bug', color: 'd73a4a' }] }),
    makeItem({ number: 2, updatedAt: daysAgo(2), labels: [] }),
    makePr({ number: 3, updatedAt: daysAgo(2) }),
    makeItem({ number: 4, updatedAt: daysAgo(120) }),
    makeItem({ number: 5, state: 'closed', closedAt: daysAgo(3), mergedAt: daysAgo(3) }),
  ];

  const report = buildWeeklyReport('acme/widgets', items, T);

  it('counts the buckets exactly like the board', () => {
    const grouped = groupByBucket(boardItems(items, T), T);
    expect(report.buckets.triage).toBe(grouped.triage.length);
    expect(report.buckets.review).toBe(grouped.review.length);
    expect(report.buckets.stalled).toBe(grouped.stalled.length);
    expect(report.buckets.done).toBe(grouped.done.length);
  });

  it('reports open totals split by kind', () => {
    expect(report.totals.open).toBe(4);
    expect(report.totals.issues).toBe(3);
    expect(report.totals.prs).toBe(1);
  });

  it('counts unlabelled and unassigned open items', () => {
    expect(report.totals.unlabelled).toBe(1);
    expect(report.totals.unassigned).toBe(0);
  });

  it('counts window openings, closings and merges', () => {
    expect(report.totals.closedInWindow).toBe(1);
    expect(report.totals.mergedInWindow).toBe(1);
    expect(report.totals.openedInWindow).toBe(0);
  });

  it('lists the oldest stalled item first', () => {
    expect(report.oldestStalled[0].number).toBe(4);
    expect(report.oldestStalled[0].days).toBeGreaterThanOrEqual(119);
  });

  it('aggregates labels and authors', () => {
    // Items 1, 3 (a PR that inherits the bug label) and 4 all carry "bug";
    // item 2 has no labels, so the count must be exactly 3.
    expect(report.topLabels.find((l) => l.name === 'bug')?.count).toBe(3);
    const manual = items.filter((i) => i.state === 'open' && i.labels.some((l) => l.name === 'bug')).length;
    expect(report.topLabels.find((l) => l.name === 'bug')?.count).toBe(manual);
    // Every open item shares the same author in this fixture.
    expect(report.busiestAuthors[0].count).toBe(report.totals.open);
  });

  it('produces an actionable markdown export', () => {
    const md = reportToMarkdown(report);
    expect(md).toContain('## acme/widgets 维护周报');
    expect(md).toContain('| 已停滞');
    expect(md).toContain('**本周建议**');
    expect(md).toContain(String(report.healthScore));
  });
});

describe('draftComment', () => {
  it('never emits an auto-close instruction', () => {
    const draft = draftComment(makeItem({ updatedAt: daysAgo(80) }), T);
    expect(draft.toLowerCase()).not.toContain('closing this now');
    expect(draft).toContain('@contributor');
  });

  it('asks a draft PR author about intent', () => {
    const draft = draftComment(makePr({ isDraft: true }), T);
    expect(draft).toContain('草稿 PR');
  });

  it('asks for triage info when the issue has no labels', () => {
    const draft = draftComment(makeItem({ labels: [] }), T);
    expect(draft).toContain('复现步骤');
  });
});

describe('draftChecklist', () => {
  it('uses PR-specific steps for pull requests and issue steps otherwise', () => {
    expect(draftChecklist(makePr())).toContain('阅读改动 diff');
    expect(draftChecklist(makeItem())).toContain('复现问题');
  });
});
