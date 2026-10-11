import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'git ls-files failed\n');
  process.exit(1);
}

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-pat', /\bghp_[A-Za-z0-9]{20,}\b/],
  ['github-fine', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['openai-style', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['google-api', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['stripe-live', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
];

let failed = false;
for (const file of listed.stdout.split('\0')) {
  if (!file) continue;
  const stat = statSync(file);
  if (!stat.isFile()) continue;
  if (stat.size > 2_000_000) {
    process.stderr.write(`${file}:oversized\n`);
    failed = true;
    continue;
  }
  const text = readFileSync(file);
  if (text.includes(0)) continue;
  const lines = text.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    for (const [name, pattern] of patterns) {
      if (pattern.test(lines[index])) {
        process.stderr.write(`${file}:${index + 1}:${name}\n`);
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log('secret scan passed');
