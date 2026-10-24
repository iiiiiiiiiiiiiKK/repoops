import { describe, expect, it } from 'vitest';
import {
  buildApiUrl,
  parseRateLimit,
} from '../../worker/github';
import {
  dedupeItems,
  isLastPage,
  normalizeItem,
  normalizeLabels,
  parseLinkHeader,
} from '../../worker/normalize';
import { type GhIssue as GhIssueType } from '../../worker/github';
import { parseRepoFullName } from '../../worker/sync';
import { ApiError } from '../../worker/env';

const rawIssue: GhIssueType = {
  number: 7,
  title: 'Something broke',
  body: 'a'.repeat(1200),
  state: 'open',
  html_url: 'https://github.com/acme/widgets/issues/7',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-02-01T00:00:00Z',
  closed_at: null,
  comments: 4,
  labels: [
    { name: 'bug', color: 'd73a4a' },
    'triage',
  ],
  user: { login: 'alice', avatar_url: 'https://avatars/alice.png' },
  assignees: [{ login: 'bob' }],
};

describe('buildApiUrl (SSRF guard)', () => {
  const base = 'https://api.github.com';

  it('builds a relative path on api.github.com', () => {
    const url = buildApiUrl(base, '/repos/acme/widgets/issues', { state: 'open', page: 2 });
    expect(url.origin).toBe('https://api.github.com');
    expect(url.pathname).toBe('/repos/acme/widgets/issues');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('rejects absolute URLs from callers', () => {
    expect(() => buildApiUrl(base, 'https://evil.example.com/x')).toThrow(ApiError);
    expect(() => buildApiUrl(base, 'http://169.254.169.254/latest/meta-data')).toThrow(ApiError);
    expect(() => buildApiUrl(base, '//evil.example.com')).toThrow(ApiError);
  });

  it('rejects a base that is not api.github.com', () => {
    expect(() => buildApiUrl('https://evil.example.com', '/repos/a/b')).toThrow(ApiError);
  });

  it('omits undefined params', () => {
    const url = buildApiUrl(base, '/x', { a: undefined, b: 'v' });
    expect(url.searchParams.has('a')).toBe(false);
    expect(url.searchParams.get('b')).toBe('v');
  });
});

describe('parseRateLimit', () => {
  it('returns null without headers', () => {
    expect(parseRateLimit(new Headers())).toBeNull();
  });

  it('parses a snapshot', () => {
    const headers = new Headers({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '42',
      'x-ratelimit-used': '4958',
      'x-ratelimit-reset': '1800000000',
      'x-ratelimit-resource': 'core',
    });
    const snap = parseRateLimit(headers);
    expect(snap).toEqual({
      limit: 5000,
      remaining: 42,
      used: 4958,
      resetAt: new Date(1_800_000_000 * 1000).toISOString(),
      resource: 'core',
    });
  });
});

describe('normalizeLabels', () => {
  it('handles both object and string label shapes', () => {
    expect(normalizeLabels([{ name: 'bug', color: 'd73a4a' }, 'triage'])).toEqual([
      { name: 'bug', color: 'd73a4a' },
      { name: 'triage', color: 'ededed' },
    ]);
  });
  it('tolerates null', () => {
    expect(normalizeLabels(null as unknown as GhIssueType['labels'])).toEqual([]);
  });
});

describe('normalizeItem', () => {
  it('maps an issue', () => {
    const item = normalizeItem('acme/widgets', rawIssue);
    expect(item.id).toBe('acme/widgets#7');
    expect(item.kind).toBe('issue');
    expect(item.state).toBe('open');
    expect(item.author).toBe('alice');
    expect(item.assignees).toEqual(['bob']);
    expect(item.labels.map((l) => l.name)).toEqual(['bug', 'triage']);
    expect(item.reviewDecision).toBeNull();
    expect(item.commentsCount).toBe(4);
    expect(item.hasOtherParticipants).toBe(true);
  });

  it('truncates long bodies instead of storing megabytes', () => {
    const item = normalizeItem('acme/widgets', rawIssue);
    expect(item.body?.length).toBe(800);
  });

  it('treats a merged PR as closed even when state says open', () => {
    const item = normalizeItem('acme/widgets', {
      ...rawIssue,
      state: 'open',
      pull_request: { merged_at: '2025-03-01T00:00:00Z', html_url: 'x' },
    });
    expect(item.kind).toBe('pr');
    expect(item.state).toBe('closed');
    expect(item.mergedAt).toBe('2025-03-01T00:00:00Z');
  });

  it('carries reviewDecision only for PRs', () => {
    const pr = normalizeItem(
      'acme/widgets',
      { ...rawIssue, pull_request: { merged_at: null, html_url: 'x' } },
      { reviewDecision: 'CHANGES_REQUESTED' },
    );
    expect(pr.reviewDecision).toBe('CHANGES_REQUESTED');
    const issue = normalizeItem('acme/widgets', rawIssue, { reviewDecision: 'APPROVED' });
    expect(issue.reviewDecision).toBeNull();
  });

  it('falls back to "ghost" for deleted accounts', () => {
    const item = normalizeItem('acme/widgets', { ...rawIssue, user: null });
    expect(item.author).toBe('ghost');
  });
});

describe('dedupeItems', () => {
  it('keeps the freshest record per id', () => {
    const older = normalizeItem('acme/widgets', rawIssue);
    const newer = normalizeItem('acme/widgets', { ...rawIssue, updated_at: '2025-05-05T00:00:00Z', title: 'newer' });
    const out = dedupeItems([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('newer');
  });

  it('keeps distinct numbers', () => {
    const a = normalizeItem('acme/widgets', rawIssue);
    const b = normalizeItem('acme/widgets', { ...rawIssue, number: 8 });
    expect(dedupeItems([a, b])).toHaveLength(2);
  });
});

describe('parseLinkHeader / isLastPage', () => {
  it('detects the next and last pages', () => {
    const header =
      '<https://api.github.com/repositories/1/issues?page=3>; rel="next", <https://api.github.com/repositories/1/issues?page=9>; rel="last"';
    const parsed = parseLinkHeader(header, 2);
    expect(parsed.next).toContain('page=3');
    expect(parsed.last).toContain('page=9');
    expect(parsed.page).toBe(3);
    expect(isLastPage(header, 2)).toBe(false);
  });

  it('treats a missing header as the last page', () => {
    expect(isLastPage(null, 1)).toBe(true);
    expect(parseLinkHeader(null, 1).next).toBeNull();
  });
});

describe('parseRepoFullName', () => {
  it('accepts owner/name and full URLs', () => {
    expect(parseRepoFullName('facebook/react')).toEqual({ owner: 'facebook', name: 'react' });
    expect(parseRepoFullName('https://github.com/facebook/react')).toEqual({ owner: 'facebook', name: 'react' });
    expect(parseRepoFullName('https://github.com/facebook/react.git')).toEqual({ owner: 'facebook', name: 'react' });
    expect(parseRepoFullName('  facebook/react/  ')).toEqual({ owner: 'facebook', name: 'react' });
  });

  it('rejects malformed input and traversal attempts', () => {
    expect(() => parseRepoFullName('justaname')).toThrow(ApiError);
    expect(() => parseRepoFullName('a/b/c')).toThrow(ApiError);
    expect(() => parseRepoFullName('../../etc/passwd')).toThrow(ApiError);
    expect(() => parseRepoFullName('owner/na me')).toThrow(ApiError);
    expect(() => parseRepoFullName('')).toThrow(ApiError);
  });
});
