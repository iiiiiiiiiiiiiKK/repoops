/**
 * Push a single-file update through the GitHub Contents API.
 *
 * Used because the local network intermittently resets git-over-HTTPS
 * connections; the REST API goes through reliably.
 *
 * Usage: node scripts/api-commit.mjs <path> "<commit message>"
 */
import { readFileSync } from 'node:fs';

const token = process.env.GH_TOKEN;
const repo = process.env.GH_REPO ?? 'iiiiiiiiiiiiiKK/repoops';
if (!token) {
  console.error('GH_TOKEN required');
  process.exit(2);
}
const path = process.argv[2];
const message = process.argv[3] ?? `chore: update ${path}`;
if (!path) {
  console.error('usage: node scripts/api-commit.mjs <path> "<message>"');
  process.exit(2);
}

const headers = {
  authorization: `Bearer ${token}`,
  'user-agent': 'repoops',
  'content-type': 'application/json',
  accept: 'application/vnd.github+json',
};

const api = `https://api.github.com/repos/${repo}/contents/${path}`;

const existing = await fetch(`${api}?ref=main`, { headers });
let sha;
if (existing.status === 200) {
  sha = (await existing.json()).sha;
} else if (existing.status !== 404) {
  console.error('lookup failed', existing.status, await existing.text());
  process.exit(1);
}

const content = readFileSync(path).toString('base64');
const res = await fetch(api, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ message, content, sha, branch: 'main' }),
});
const json = await res.json();
if (!res.ok) {
  console.error('commit failed', res.status, JSON.stringify(json).slice(0, 400));
  process.exit(1);
}
console.log('committed', json.commit.sha.slice(0, 7), path);
