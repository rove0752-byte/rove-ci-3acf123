import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createExampleNetwork, evidenceDirectory, readEvidence, resolveExampleHost, runExampleContainer } from './example-container.ts';

const id = `rove-example-${process.pid}`;
const evidence = evidenceDirectory(id);
const host = await resolveExampleHost();
const network = createExampleNetwork(id);
process.stdout.write(`Example proof network ipv6=${network.ipv6}\n`);
let failed = true;
try {
  const run = runExampleContainer('example-pin', evidence, id);
  if (run.status !== 0 || !run.stdout.includes('Example pin verification passed')) {
    process.stderr.write(`${run.stdout}\n${run.stderr}\n`);
    throw new Error(`Example pin verification failed. Evidence kept at ${evidence}`);
  }
  const result = readEvidence(evidence, 'example-pin.json') as { address?: string };
  if (!result.address || !host.answers.includes(result.address)) {
    throw new Error(`Pinned address is not a current example.com answer. Evidence kept at ${evidence}`);
  }
  failed = false;
  process.stdout.write(`Example pin verification passed ${result.address}\n`);
} finally {
  spawnSync('docker', ['rm', '-f', id], { encoding: 'utf8' });
  spawnSync('docker', ['network', 'rm', id], { encoding: 'utf8' });
  if (!failed) rmSync(evidence, { recursive: true, force: true });
}
