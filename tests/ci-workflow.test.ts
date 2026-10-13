// Static guards for the A3 CI wiring (review t25 H2/H3, F-INFO1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const wf = readFileSync('.github/workflows/a3-harness-smoke.yml', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('H2: test:all runs the unit suite and every harness suite, and CI calls it', () => {
  assert.match(pkg.scripts['test:all'], /npm test/);
  assert.match(pkg.scripts['test:all'], /test:a3-safety/);
  if (existsSync('harness/stage-a-runner/tests')) assert.match(pkg.scripts['test:all'], /test:stage-a-runner/);
  assert.doesNotMatch(pkg.scripts['test:all'], /\|\|\s*true/, 'failures must not be swallowed');
  assert.match(wf, /run: npm run test:all/);
});

test('H3: smoke step survives sudo env_reset (no runner env read inside sudo), apt-get update first, getent not curl', () => {
  assert.match(wf, /sudo apt-get update && sudo apt-get install -y zsh/);
  const step = wf.slice(wf.indexOf('name: Harness smoke'));
  const inner = step.match(/sudo unshare --net -- sh -c '([^']*)'/)![1];
  assert.doesNotMatch(inner, /\$(PATH|HOME|RUNNER_TEMP|PLAYWRIGHT)/, 'variables inside sudo would be root\'s');
  assert.match(inner, /! getent hosts example\.com/);
  assert.match(step, /NODE="\$\(command -v node\)"/);
  assert.match(wf, /PLAYWRIGHT_BROWSERS_PATH: \/home\/runner\/\.cache\/ms-playwright/);
  assert.match(wf, /persist-credentials: false/);
  assert.match(wf, /permissions: \{ contents: read \}/);
  for (const u of wf.match(/uses: \S+/g)!) assert.match(u, /@[0-9a-f]{40}$/, `${u} pinned by SHA`);
});

test('F-INFO1: README placeholder token is allow-listed by fingerprint only', () => {
  const ig = readFileSync('.gitleaksignore', 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  assert.deepEqual(ig, ['a4d28fb2cd43f40151e1d897af4f6176ea9548e1:README.md:curl-auth-header:38', 'README.md:curl-auth-header:38']);
});
