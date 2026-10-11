import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createExampleNetwork, readEvidence, resolveExampleHost, runExampleContainer } from './example-container.ts';

const root = resolve(import.meta.dirname, '..');
const id = `rove-fetch-${process.pid}`;
const evidence = resolve(root, 'reports/readonly-pilot/example.com');
rmSync(evidence, { recursive: true, force: true });
mkdirSync(evidence, { recursive: true });
const host = await resolveExampleHost();
const network = createExampleNetwork(id);
process.stdout.write(`Example proof network ipv6=${network.ipv6}\n`);
try {
  const run = runExampleContainer('example-fetch', evidence, id);
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0 || !run.stdout.includes('Example page fetch passed')) {
    throw new Error('Example page fetch failed.');
  }
  const result = readEvidence(evidence, 'result.json') as { address?: string; status?: number; title?: string };
  if (!result.address || !host.answers.includes(result.address) || result.status !== 200 || !result.title) {
    throw new Error('Fetched address is not a current public answer for example.com.');
  }
  process.stdout.write(`Example page captured ${result.address} ${result.status} ${result.title}\n`);
} finally {
  spawnSync('docker', ['rm', '-f', id], { encoding: 'utf8' });
  spawnSync('docker', ['network', 'rm', id], { encoding: 'utf8' });
}
