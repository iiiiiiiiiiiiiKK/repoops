import { execSync } from 'node:child_process';

const PATTERNS = [
  ['GitHub classic PAT', /ghp_[A-Za-z0-9]{30,}/g],
  ['GitHub fine-grained PAT', /github_pat_[A-Za-z0-9_]{30,}/g],
  ['Cloudflare API token', /cfat_[A-Za-z0-9]{20,}/g],
  ['Cloudflare user token', /cfut_[A-Za-z0-9]{20,}/g],
  ['Cloudflare account id', /\b[0-9a-f]{32}\b(?![0-9a-f])/g],
  ['AWS access key', /AKIA[0-9A-Z]{16}/g],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Vercel token', /vercel_[A-Za-z0-9]{20,}/g],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['Generic secret assignment', /(?:secret|password|token|api_key)\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{24,}["']/gi],
];

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !/package-lock\.json$/.test(f));

let findings = 0;
for (const file of files) {
  let content;
  try {
    content = execSync(`git show :${file}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    continue;
  }
  for (const [label, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length;
      const sample = m[0].slice(0, 14) + '…';
      console.log(`LEAK  ${file}:${line}  [${label}]  ${sample}`);
      findings += 1;
    }
  }
}

console.log(`\nscanned ${files.length} tracked files, ${findings} finding(s)`);
if (findings > 0) process.exitCode = 1;
