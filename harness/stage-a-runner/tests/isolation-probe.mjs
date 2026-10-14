// TEST-ONLY isolation probe: from the browser container, everything except the proxy socket must be unreachable.
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { writeFileSync } from 'node:fs';
const tcp = (host, port) => new Promise(r => { const s = connect({ host, port, timeout: 2500 }); s.on('connect', () => { s.destroy(); r('REACHED'); }); s.on('error', () => r('blocked')); s.on('timeout', () => { s.destroy(); r('blocked'); }); });
const dns = h => lookup(h).then(() => 'REACHED', () => 'blocked');
const r = {
  ifaces: Object.keys(networkInterfaces()).sort().join(','),
  gw_up_111: await tcp('10.89.1.1', 111), gw_in_111: await tcp('10.89.2.1', 111), gw_up_2375: await tcp('10.89.1.1', 2375),
  fixture_old_bridge: await tcp('10.89.1.10', 80), fixture_loopback: await tcp('127.0.0.1', 8081), internet: await tcp('1.1.1.1', 80), dns8: await tcp('8.8.8.8', 53),
  metadata: await tcp('169.254.169.254', 80), desktop_vm: await tcp('192.168.65.254', 80), ipv6: await tcp('2606:4700:4700::1111', 80),
  host_internal: await dns('host.docker.internal'), gateway_internal: await dns('gateway.docker.internal'), public_dns: await dns('example.com'),
  proxy_socket: await new Promise(res => { const s = connect('/sock/proxy.sock'); s.on('connect', () => { s.destroy(); res('REACHED'); }); s.on('error', () => res('blocked')); }),
};
writeFileSync(process.argv[2] ?? '/scratch/probe.json', JSON.stringify(r), { mode: 0o600 });
