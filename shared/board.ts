/**
 * Pure board-analytics helpers.
 *
 * Everything in this file is deterministic and side-effect free so it can be
 * unit tested in isolation and reused by both the worker (report generation)
 * and the client (instant re-bucketing when the user moves the sliders).
 */
import {
  BUCKET_ORDER,
  type BoardThresholds,
  type Bucket,
  type NormalizedItem,
  type WeeklyReport,
} from './types';

export const MS_PER_DAY = 86_400_000;

/** Whole days between `iso` and `now` (never negative). */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

/**
 * Bucket rules, evaluated top to bottom — first match wins:
 *
 * 1. closed/merged inside the "recently done" window  -> done
 * 2. no activity for longer than the stale threshold   -> stalled
 * 3. open PR that is a draft, or was sent back by a
 *    reviewer (CHANGES_REQUESTED)                      -> author
 * 4. any other open PR                                 -> review
 * 5. open issue with no labels or no assignee          -> triage
 * 6. every other open issue                            -> author (needs a reply)
 */
export function bucketOf(item: NormalizedItem, thresholds: BoardThresholds, now: number = Date.now()): Bucket {
  // Closed/merged work lives in `done`. `boardItems()` is responsible for
  // dropping the ones that fell outside the completion window, so this branch
  // can stay unconditional — a closed item never appears in an open queue.
  if (item.state === 'closed') return 'done';
  if (daysSince(item.updatedAt, now) > thresholds.staleDays) return 'stalled';

  if (item.kind === 'pr') {
    if (item.isDraft || item.reviewDecision === 'CHANGES_REQUESTED') return 'author';
    return 'review';
  }

  if (item.labels.length === 0 || item.assignees.length === 0) return 'triage';
  return 'author';
}

/** Items that belong on the board right now (closed items only if recently done). */
export function boardItems(
  items: NormalizedItem[],
  thresholds: BoardThresholds,
  now: number = Date.now(),
): NormalizedItem[] {
  return items.filter((item) => {
    if (item.state !== 'closed') return true;
    const closedAt = item.mergedAt ?? item.closedAt;
    return daysSince(closedAt, now) <= thresholds.doneDays;
  });
}

export function groupByBucket(
  items: NormalizedItem[],
  thresholds: BoardThresholds,
  now: number = Date.now(),
): Record<Bucket, NormalizedItem[]> {
  const out = Object.fromEntries(BUCKET_ORDER.map((b) => [b, [] as NormalizedItem[]])) as Record<
    Bucket,
    NormalizedItem[]
  >;
  for (const item of items) out[bucketOf(item, thresholds, now)].push(item);
  return out;
}

export interface FilterState {
  query: string;
  labels: string[];
  assignees: string[];
  kinds: Array<'issue' | 'pr'>;
  /** 'any' | 'stalled' | 'fresh' */
  age: 'any' | 'stalled' | 'fresh';
  showClosed: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  query: '',
  labels: [],
  assignees: [],
  kinds: [],
  age: 'any',
  showClosed: true,
};

export type SortKey = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'comments-desc' | 'number-asc';

export function matchesFilters(item: NormalizedItem, f: FilterState, thresholds: BoardThresholds, now: number = Date.now()): boolean {
  if (f.kinds.length > 0 && !f.kinds.includes(item.kind)) return false;
  if (!f.showClosed && item.state === 'closed') return false;
  if (f.labels.length > 0) {
    const own = item.labels.map((l) => l.name);
    if (!f.labels.every((l) => own.includes(l))) return false;
  }
  if (f.assignees.length > 0) {
    if (!f.assignees.every((a) => item.assignees.includes(a))) return false;
  }
  if (f.age !== 'any') {
    const stale = daysSince(item.updatedAt, now) > thresholds.staleDays;
    if (f.age === 'stalled' && !stale) return false;
    if (f.age === 'fresh' && stale) return false;
  }
  const q = f.query.trim().toLowerCase();
  if (q) {
    const haystack = [
      item.title,
      item.body ?? '',
      item.author,
      item.repo,
      `#${item.number}`,
      ...item.labels.map((l) => l.name),
      ...item.assignees,
    ]
      .join('\n')
      .toLowerCase();
    if (!q.split(/\s+/).every((term) => haystack.includes(term))) return false;
  }
  return true;
}

export function sortItems(items: NormalizedItem[], key: SortKey): NormalizedItem[] {
  const copy = [...items];
  const by = (a: string | null, b: string | null) => (a ?? '').localeCompare(b ?? '');
  switch (key) {
    case 'updated-asc':
      return copy.sort((a, b) => by(a.updatedAt, b.updatedAt));
    case 'created-desc':
      return copy.sort((a, b) => by(b.createdAt, a.createdAt));
    case 'created-asc':
      return copy.sort((a, b) => by(a.createdAt, b.createdAt));
    case 'comments-desc':
      return copy.sort((a, b) => b.commentsCount - a.commentsCount);
    case 'number-asc':
      return copy.sort((a, b) => a.number - b.number);
    case 'updated-desc':
    default:
      return copy.sort((a, b) => by(b.updatedAt, a.updatedAt));
  }
}

/**
 * Health score: 100 when the queue is small, fresh and reviewed;
 * it degrades with stalled share, unreviewed PR backlog and unlabelled issues.
 */
export function healthScore(buckets: Record<Bucket, number>, openTotal: number): number {
  if (openTotal === 0) return 100;
  const stalledShare = buckets.stalled / openTotal;
  const reviewShare = buckets.review / openTotal;
  const triageShare = buckets.triage / openTotal;
  const raw = 100 - stalledShare * 55 - reviewShare * 25 - triageShare * 20;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function buildWeeklyReport(
  repo: string,
  items: NormalizedItem[],
  thresholds: BoardThresholds,
  now: number = Date.now(),
): WeeklyReport {
  const windowStart = now - thresholds.doneDays * MS_PER_DAY;
  const bucketsList = groupByBucket(boardItems(items, thresholds, now), thresholds, now);
  const buckets = Object.fromEntries(BUCKET_ORDER.map((b) => [b, bucketsList[b].length])) as Record<Bucket, number>;
  const open = items.filter((i) => i.state === 'open');

  const labelCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  for (const item of open) {
    for (const label of item.labels) labelCounts.set(label.name, (labelCounts.get(label.name) ?? 0) + 1);
    authorCounts.set(item.author, (authorCounts.get(item.author) ?? 0) + 1);
  }

  const stalled = bucketsList.stalled
    .map((item) => ({ item, days: daysSince(item.updatedAt, now) }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 8)
    .map(({ item, days }) => ({
      id: item.id,
      title: item.title,
      repo: item.repo,
      number: item.number,
      days,
      htmlUrl: item.htmlUrl,
    }));

  const notes: string[] = [];
  if (buckets.stalled > 0) notes.push(`${buckets.stalled} 项超过 ${thresholds.staleDays} 天没有任何更新，建议本周优先清理。`);
  if (buckets.review > 0) notes.push(`${buckets.review} 个 PR 在等审查，这是当前最大的合并瓶颈。`);
  if (buckets.triage > 0) notes.push(`${buckets.triage} 个 Issue 还缺少标签或负责人，先分诊再排期。`);
  const unlabelled = open.filter((i) => i.labels.length === 0).length;
  if (unlabelled > 0) notes.push(`${unlabelled} 个开启中的事项没有标签，筛选和统计会失真。`);
  if (notes.length === 0) notes.push('队列很干净：没有停滞项目，也没有等待审查的 PR。');
  if (buckets.done === 0) notes.push(`过去 ${thresholds.doneDays} 天没有关闭或合并的事项，可以考虑对外说明节奏。`);

  const openedInWindow = items.filter((i) => Date.parse(i.createdAt) >= windowStart).length;
  const closedInWindow = items.filter((i) => i.closedAt && Date.parse(i.closedAt) >= windowStart).length;
  const mergedInWindow = items.filter((i) => i.mergedAt && Date.parse(i.mergedAt) >= windowStart).length;

  return {
    repo,
    generatedAt: new Date(now).toISOString(),
    windowFrom: new Date(windowStart).toISOString(),
    windowTo: new Date(now).toISOString(),
    thresholds,
    totals: {
      open: open.length,
      issues: open.filter((i) => i.kind === 'issue').length,
      prs: open.filter((i) => i.kind === 'pr').length,
      openedInWindow,
      closedInWindow,
      mergedInWindow,
      stalled: buckets.stalled,
      awaitingReview: buckets.review,
      awaitingAuthor: buckets.author,
      unlabelled,
      unassigned: open.filter((i) => i.assignees.length === 0).length,
    },
    buckets,
    topLabels: [...labelCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    busiestAuthors: [...authorCounts.entries()]
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    oldestStalled: stalled,
    healthScore: healthScore(buckets, open.length),
    notes,
  };
}

/** Markdown export of a weekly report, ready to paste into a GitHub release note. */
export function reportToMarkdown(report: WeeklyReport): string {
  const from = report.windowFrom.slice(0, 10);
  const to = report.windowTo.slice(0, 10);
  const lines: string[] = [
    `## ${report.repo} 维护周报 (${from} → ${to})`,
    '',
    `**健康度：${report.healthScore}/100** · 开启 ${report.totals.open} 项（Issue ${report.totals.issues} / PR ${report.totals.prs}）`,
    '',
    '| 分类 | 数量 |',
    '| --- | --- |',
    `| 待处理 | ${report.buckets.triage} |`,
    `| 等待审查 | ${report.buckets.review} |`,
    `| 等待作者 | ${report.buckets.author} |`,
    `| 已停滞（>${report.thresholds.staleDays} 天） | ${report.buckets.stalled} |`,
    `| 近期完成 | ${report.buckets.done} |`,
    '',
    `过去 ${report.thresholds.doneDays} 天：新开 ${report.totals.openedInWindow} · 关闭 ${report.totals.closedInWindow} · 合并 ${report.totals.mergedInWindow}`,
    '',
  ];
  if (report.topLabels.length) {
    lines.push('**热点标签**：' + report.topLabels.map((l) => `\`${l.name}\` (${l.count})`).join(' · '), '');
  }
  if (report.oldestStalled.length) {
    lines.push(`**最久未动（阈值 ${report.thresholds.staleDays} 天）**`);
    for (const row of report.oldestStalled) {
      lines.push(`- [#${row.number}](${row.htmlUrl}) ${row.title} — ${row.days} 天`);
    }
    lines.push('');
  }
  lines.push('**本周建议**');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('', `<sub>由 RepoOps 于 ${report.generatedAt.slice(0, 19).replace('T', ' ')} UTC 生成 · 数据来源 GitHub 官方 API</sub>`);
  return lines.join('\n');
}

/** Deterministic review-comment draft. Never posted automatically. */
export function draftComment(item: NormalizedItem, thresholds: BoardThresholds, now: number = Date.now()): string {
  const idle = daysSince(item.updatedAt, now);
  if (item.kind === 'pr') {
    if (item.isDraft) {
      return [
        `感谢 @${item.author} 提交这个草稿 PR！`,
        '',
        '想确认一下后续计划：',
        `- [ ] 这个改动是准备正式提交审查，还是先放着征求意见？`,
        `- [ ] 需要我帮忙看哪一部分？`,
        '',
        `标记为草稿已经 ${idle} 天，如果没有新的计划我会先把它挪到 backlog。`,
      ].join('\n');
    }
    if (item.reviewDecision === 'CHANGES_REQUESTED') {
      return [
        `@${item.author} 之前的审查意见还需要处理一下：`,
        '',
        '- [ ] 逐条回复或修复 review comment',
        '- [ ] 推送新 commit 后 re-request review',
        '',
        `如果最近没时间继续，也可以先关掉，等有精力再重开——不影响贡献记录。`,
      ].join('\n');
    }
    return [
      `感谢 @${item.author} 的 PR，这个改动已经进入审查队列。`,
      '',
      '- [ ] 我会在本周内给出第一轮 review',
      `- [ ] 如果 ${thresholds.staleDays} 天内没有进展，我会在这里同步一次状态`,
      '',
      '在此之前如果 CI 红了，麻烦先本地跑一遍测试。',
    ].join('\n');
  }
  if (idle > thresholds.staleDays) {
    return [
      `@${item.author} 这个 issue 已经 ${idle} 天没有更新了，想确认一下现在的状态：`,
      '',
      '- [ ] 问题仍然存在，需要继续跟进',
      '- [ ] 已经有 workaround，可以先关闭',
      '- [ ] 我能自己提 PR 修复',
      '',
      '两周内没有回复的话我会先关闭，之后随时可以重开。',
    ].join('\n');
  }
  if (item.labels.length === 0) {
    return [
      `感谢 @${item.author} 的报告！`,
      '',
      '为了让它进入正确的队列，我需要一点额外信息：',
      '',
      '- [ ] 复现步骤（最小示例）',
      '- [ ] 版本 / 运行环境',
      '- [ ] 期望结果与实际结果',
      '',
      '补齐后我会加上对应的标签并排期。',
    ].join('\n');
  }
  return [
    `@${item.author} 谢谢补充，这个问题现在在我们的队列里。`,
    '',
    '- [ ] 确认影响范围',
    '- [ ] 给出修复方案或 workaround',
    '',
    '有进展我会在这里更新。',
  ].join('\n');
}

/** Checklist draft used by the "task list" tab in the detail panel. */
export function draftChecklist(item: NormalizedItem): string {
  const base =
    item.kind === 'pr'
      ? [
          '- [ ] 阅读改动 diff 并确认范围',
          '- [ ] 本地跑测试 / CI 结果确认',
          '- [ ] 检查是否有破坏性变更或迁移需求',
          '- [ ] 给出 review 结论（approve / request changes）',
        ]
      : [
          '- [ ] 复现问题',
          '- [ ] 判断是 bug / 特性 / 用法问题',
          '- [ ] 添加标签与负责人',
          '- [ ] 给出下一步（修复 / 排期 / 关闭）',
        ];
  return [`### ${item.repo}#${item.number} — ${item.title}`, '', ...base].join('\n');
}
