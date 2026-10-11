import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { publicAddress } from '../agent/lib/public-address.ts';

const root = resolve(import.meta.dirname, '..');
const image = 'rove-browser-pilot:local';

export type HostResolution = { answers: string[] };

export async function resolveStructuredHost(): Promise<HostResolution> {
  const answers = await lookup('docs.python.org', { all: true, verbatim: true });
  const addresses = answers.map(item => item.address);
  if (addresses.length === 0 || addresses.some(address => !publicAddress(address))) {
    throw new Error('docs.python.org did not resolve to a public address.');
  }
  return { answers: addresses };
}

export function createStructuredNetwork(id: string): { ipv6: boolean } {
  const v6 = spawnSync('docker', ['network', 'create', '--ipv6', id], { encoding: 'utf8' });
  if (v6.status === 0) return { ipv6: true };
  spawnSync('docker', ['network', 'rm', id], { encoding: 'utf8' });
  const v4 = spawnSync('docker', ['network', 'create', id], { encoding: 'utf8' });
  if (v4.status !== 0) throw new Error((v4.stderr || v6.stderr || 'docker network create failed').trim());
  return { ipv6: false };
}

export function runStructuredContainer(
  evidence: string,
  id: string,
  program: 'structured-pin' | 'structured-fetch' = 'structured-pin',
  pinAddress?: string,
): { status: number | null; stdout: string; stderr: string } {
  mkdirSync(evidence, { recursive: true });
  const scripts = program === 'structured-fetch'
    ? ['container-egress-entry.ts', 'container-egress-launch.sh', 'fetch-structured-page.ts', 'structured-document.ts']
    : ['container-egress-entry.ts', 'container-egress-launch.sh', 'structured-pin-probe.ts'];
  const args = [
    'run', '--rm', '--name', id, '--network', id,
    '--cap-add', 'NET_ADMIN',
    '--sysctl', 'net.ipv4.ping_group_range=0 2147483647',
    '-e', 'ROVE_EGRESS_APPLY=dedicated-container',
    '-e', 'ROVE_EGRESS_MODE=enforce',
    '-e', 'ROVE_EGRESS_STRUCTURED_READ=1',
    '-e', 'ROVE_EGRESS_STRUCTURED_HOST=docs.python.org',
    '-e', `ROVE_EGRESS_NEXT=${program}`,
    '-e', 'HOME=/tmp',
    '-v', `${join(root, 'agent')}:/app/agent:ro`,
    '-v', `${evidence}:/evidence`,
  ];
  if (program === 'structured-fetch') {
    if (!pinAddress || !publicAddress(pinAddress)) throw new Error('Structured document pin is not a public address.');
    args.push('-e', `ROVE_STRUCTURED_PIN_ADDRESS=${pinAddress}`);
  }
  for (const script of scripts) args.push('-v', `${join(root, 'scripts', script)}:/app/scripts/${script}:ro`);
  args.push('--entrypoint', 'sh', image, '/app/scripts/container-egress-launch.sh');
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function readEvidence(evidence: string, name: string): unknown {
  return JSON.parse(readFileSync(join(evidence, name), 'utf8'));
}

export function evidenceDirectory(name: string): string {
  return join(tmpdir(), name);
}
