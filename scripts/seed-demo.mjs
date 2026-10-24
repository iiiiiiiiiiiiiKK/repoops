/**
 * One-off ops helper: build a demo snapshot from the public GitHub API and emit
 * a SQL file that seeds `demo_cache` in D1.
 *
 * Why: Cloudflare's egress IPs share the unauthenticated GitHub quota, so the
 * very first `/api/demo` request from a cold cache can 429. Seeding the cache
 * makes the public demo deterministic, and the worker keeps it fresh on a cron.
 *
 * Usage: node scripts/seed-demo.mjs [owner/name] > .seed-demo.sql
 */
import { writeFileSync } from 'node:fs';

const repoArg = process.argv[2] ?? 'facebook/react';
const [owner, name] = repoArg.split('/');
const PER_PAGE = 100;
const MAX_PAGES = 3;

const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'repoops-seed',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function json(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const meta = await json(`https://api.github.com/repos/${owner}/${name}`);
const raw = [];
for (let page = 1; page <= MAX_PAGES; page += 1) {
  const batch = await json(
    `https://api.github.com/repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
  );
  raw.push(...batch);
  if (batch.length < PER_PAGE) break;
}

// reviewDecision is REST-invisible; one GraphQL call covers open PRs.
let decisions = {};
if (process.env.GITHUB_TOKEN) {
  const gql = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(first:100,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number reviewDecision isDraft}}}}`,
      variables: { o: owner, n: name },
    }),
  });
  const payload = await gql.json();
  for (const node of payload?.data?.repository?.pullRequests?.nodes ?? []) {
    decisions[node.number] = { reviewDecision: node.reviewDecision, isDraft: node.isDraft };
  }
}

const fullName = meta.full_name;
const items = [];
const seen = new Set();
for (const r of raw) {
  if (seen.has(r.number)) continue;
  seen.add(r.number);
  const isPr = Boolean(r.pull_request);
  items.push({
    id: `${fullName}#${r.number}`,
    repo: fullName,
    number: r.number,
    kind: isPr ? 'pr' : 'issue',
    title: r.title,
    body: r.body ? r.body.slice(0, 800) : null,
    state: r.state === 'closed' || r.pull_request?.merged_at ? 'closed' : 'open',
    htmlUrl: r.html_url,
    author: r.user?.login ?? 'ghost',
    authorAvatar: r.user?.avatar_url ?? null,
    labels: (r.labels ?? []).map((l) => (typeof l === 'string' ? { name: l, color: 'ededed' } : { name: l.name, color: l.color ?? 'ededed' })),
    assignees: (r.assignees ?? []).map((a) => a.login),
    commentsCount: r.comments ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at ?? null,
    isDraft: Boolean(r.draft) || Boolean(decisions[r.number]?.isDraft),
    reviewDecision: isPr ? (decisions[r.number]?.reviewDecision ?? null) : null,
    requestedReviewers: (r.requested_reviewers ?? []).map((x) => x.login),
    hasOtherParticipants: (r.comments ?? 0) > 0,
    mergedAt: r.pull_request?.merged_at ?? null,
  });
}

const now = new Date().toISOString();
const repo = {
  owner: meta.owner.login,
  name: meta.name,
  fullName,
  htmlUrl: meta.html_url,
  description: meta.description,
  stargazers: meta.stargazers_count,
  isPrivate: meta.private,
  pushedAt: meta.pushed_at,
  language: meta.language,
  addedAt: now,
  sync: {
    repo: fullName,
    lastSyncAt: now,
    itemCount: items.length,
    pagesFetched: Math.min(MAX_PAGES, Math.ceil(raw.length / PER_PAGE)),
    complete: raw.length < MAX_PAGES * PER_PAGE,
    cursor: null,
    errors: [],
    rateLimit: null,
    lastRunDurationMs: null,
    mode: 'demo',
  },
};

const payload = JSON.stringify({ repo, items });
const esc = (s) => s.replace(/'/g, "''");
const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const lines = [
  `DELETE FROM demo_items WHERE repo_full_name = '${fullName}';`,
  `DELETE FROM demo_meta WHERE repo_full_name = '${fullName}';`,
  `INSERT INTO demo_meta (repo_full_name, payload, fetched_at, expires_at) VALUES ('${fullName}', '${esc(JSON.stringify(repo))}', '${now}', '${expires}');`,
  ...items.map(
    (item) =>
      `INSERT INTO demo_items (repo_full_name, item_id, updated_at, payload) VALUES ('${fullName}', '${esc(item.id)}', '${item.updatedAt}', '${esc(JSON.stringify(item))}');`,
  ),
];
const sql = lines.join('\n') + '\n';
void payload;

writeFileSync('.seed-demo.sql', sql, 'utf8');
console.log(
  `seeded ${fullName}: ${items.length} items (${items.filter((i) => i.kind === 'issue').length} issues / ${
    items.filter((i) => i.kind === 'pr').length
  } PRs) -> .seed-demo.sql (${(sql.length / 1024).toFixed(1)} KiB, longest statement ${(
    Math.max(...lines.map((l) => l.length)) / 1024
  ).toFixed(1)} KiB)`,
);
