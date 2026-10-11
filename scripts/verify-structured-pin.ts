import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStructuredNetwork, evidenceDirectory, readEvidence, resolveStructuredHost, runStructuredContainer } from './structured-container.ts';

const root = resolve(import.meta.dirname, '..');
const id = `rove-structured-${process.pid}`;
const evidence = evidenceDirectory(id);
const reportDir = resolve(root, 'reports/readonly-pilot/structured');
const host = await resolveStructuredHost();
const network = createStructuredNetwork(id);
process.stdout.write(`Structured proof network ipv6=${network.ipv6}\n`);
let failed = true;
try {
  const run = runStructuredContainer(evidence, id);
  if (run.status !== 0 || !run.stdout.includes('Structured pin verification passed')) {
    process.stderr.write(`${run.stdout}\n${run.stderr}\n`);
    throw new Error(`Structured pin verification failed. Evidence kept at ${evidence}`);
  }
  const result = readEvidence(evidence, 'structured-pin.json') as {
    address?: string;
    documentRequested?: boolean;
    tls?: { open?: boolean; authorized?: boolean; pythonDocsName?: boolean };
  };
  if (!result.address || !host.answers.includes(result.address) || result.documentRequested !== false ||
    result.tls?.open !== true || result.tls.authorized !== true || result.tls.pythonDocsName !== true) {
    throw new Error(`Pinned address is not a current public answer for docs.python.org. Evidence kept at ${evidence}`);
  }
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(resolve(reportDir, 'pin.json'), readFileSync(`${evidence}/structured-pin.json`));
  failed = false;
  process.stdout.write(`Structured pin verification passed ${result.address}\n`);
} finally {
  spawnSync('docker', ['rm', '-f', id], { encoding: 'utf8' });
  spawnSync('docker', ['network', 'rm', id], { encoding: 'utf8' });
  if (!failed) rmSync(evidence, { recursive: true, force: true });
}
