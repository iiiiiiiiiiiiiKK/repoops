/**
 * Push the local working tree to GitHub through the Git Data API.
 *
 * git-over-HTTPS is intermittently reset on this network, so this script builds
 * a tree + commit + ref update via the REST API instead. It only uploads files
 * whose content differs from the remote tree, so it is safe to re-run.
 *
 * Usage:
 *   GH_TOKEN=... node scripts/api-sync.mjs "commit message" [--dry]
 *
 * The result is a single commit on `main` that matches the local working tree
 * for every file tracked by git (honouring .gitignore).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const token = process.env.GH_TOKEN;
const repo = process.env.GH_REPO ?? 'iiiiiiiiiiiiiKK/repoops';
const message = process.argv[2] ?? 'chore: sync working tree';
const dry = process.argv.includes('--dry');

if (!token) {
  console.error('GH_TOKEN required');
  process.exit(2);
}

const api = `https://api.github.com/repos/${repo}`;
const headers = {
  authorization: `Bearer ${token}`,
  'user-agent': 'repoops',
  'content-type': 'application/json',
  accept: 'application/vnd.github+json',
};

async function gh(path, init = {}) {
  const res = await fetch(api + path, { ...init, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

/** Blob sha for a file, computed locally the same way git does. */
function localBlobSha(buffer) {
  return createHash('sha1')
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest('hex');
}

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  // never publish a local secret file, even if it slipped past .gitignore
  .filter((f) => !/(\.dev\.vars|\.session-secret|\.seed-demo\.sql|\.env\.local)$/.test(f));

const headRef = await gh('/git/ref/heads/main');
const headSha = headRef.object.sha;
const headCommit = await gh(`/git/commits/${headSha}`);
const baseTreeSha = headCommit.tree.sha;

const remoteTree = await gh(`/git/trees/${baseTreeSha}?recursive=1`);
const remoteBlobs = new Map();
for (const entry of remoteTree.tree ?? []) {
  if (entry.type === 'blob') remoteBlobs.set(entry.path, entry.sha);
}

const changed = [];
for (const path of files) {
  const buf = readFileSync(path);
  const sha = localBlobSha(buf);
  if (remoteBlobs.get(path) !== sha) changed.push({ path, buf, sha });
}

// Files that exist on the remote but are no longer tracked locally must be
// deleted from the tree (a `null` sha removes the entry).
const tracked = new Set(files);
const deleted = [...remoteBlobs.keys()].filter((p) => !tracked.has(p));

console.log(`tracked files: ${files.length} · changed: ${changed.length} · deleted: ${deleted.length}`);
for (const c of changed) console.log(`  M ${c.path}`);
for (const d of deleted) console.log(`  D ${d}`);
if (changed.length === 0 && deleted.length === 0) {
  console.log('nothing to push');
  process.exit(0);
}
if (dry) process.exit(0);

// Upload only the changed blobs.
for (const c of changed) {
  const blob = await gh('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: c.buf.toString('base64'), encoding: 'base64' }),
  });
  c.newSha = blob.sha;
}

// Build the new tree: reuse unchanged entries by omitting them (GitHub keeps
// the base tree when `base_tree` is supplied).
const tree = await gh('/git/trees', {
  method: 'POST',
  body: JSON.stringify({
    base_tree: baseTreeSha,
    tree: [
      ...changed.map((c) => ({ path: c.path, mode: '100644', type: 'blob', sha: c.newSha })),
      ...deleted.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
    ],
  }),
});

const commit = await gh('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
});

await gh('/git/refs/heads/main', {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
});

console.log(`pushed ${commit.sha.slice(0, 7)} — ${message}`);
