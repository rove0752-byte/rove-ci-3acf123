import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { publicAddress } from '../agent/lib/public-address.ts';

const root = resolve(import.meta.dirname, '..');
const image = 'rove-browser-pilot:local';

export type HostResolution = { answers: string[] };

export async function resolveExampleHost(): Promise<HostResolution> {
  const answers = await lookup('example.com', { all: true, verbatim: true });
  const addresses = answers.map(item => item.address);
  if (addresses.length === 0 || addresses.some(address => !publicAddress(address))) {
    throw new Error('example.com did not resolve to a public address.');
  }
  return { answers: addresses };
}

export function createExampleNetwork(id: string): { ipv6: boolean } {
  const v6 = spawnSync('docker', ['network', 'create', '--ipv6', id], { encoding: 'utf8' });
  if (v6.status === 0) return { ipv6: true };
  spawnSync('docker', ['network', 'rm', id], { encoding: 'utf8' });
  const v4 = spawnSync('docker', ['network', 'create', id], { encoding: 'utf8' });
  if (v4.status !== 0) throw new Error((v4.stderr || v6.stderr || 'docker network create failed').trim());
  return { ipv6: false };
}

export function runExampleContainer(program: 'example-pin' | 'example-fetch', evidence: string, id: string): { status: number | null; stdout: string; stderr: string } {
  mkdirSync(evidence, { recursive: true });
  const scripts = [
    'container-egress-entry.ts',
    'container-egress-launch.sh',
    'example-pin-probe.ts',
    'fetch-example-page.ts',
  ];
  const args = [
    'run', '--rm', '--name', id, '--network', id,
    '--cap-add', 'NET_ADMIN',
    '--sysctl', 'net.ipv4.ping_group_range=0 2147483647',
    '-e', 'ROVE_EGRESS_APPLY=dedicated-container',
    '-e', 'ROVE_EGRESS_MODE=enforce',
    '-e', 'ROVE_EGRESS_EXAMPLE_READ=1',
    '-e', 'ROVE_EGRESS_EXAMPLE_HOST=example.com',
    '-e', `ROVE_EGRESS_NEXT=${program}`,
    '-e', 'HOME=/tmp',
    '-v', `${join(root, 'agent')}:/app/agent:ro`,
    '-v', `${evidence}:/evidence`,
  ];
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
