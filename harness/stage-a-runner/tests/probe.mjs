// TEST-ONLY probe (run via STAGE_A_TEST=1 CMD). PROBE = JSON array of raw HTTP requests sent to the proxy socket.
import { connect } from 'node:net';
import { writeFileSync } from 'node:fs';
const spec = JSON.parse(process.env.PROBE || '[]'); const parallel = !Array.isArray(spec) && spec.parallel; const reqs = Array.isArray(spec) ? spec : spec.reqs; let out = [];
const one = raw => new Promise(res => {
    const s = connect('/sock/proxy.sock'); let buf = '';
    s.on('data', d => { buf += d; }); s.on('error', e => res('error ' + e.code));
    s.on('close', () => res(buf.split('\r\n')[0] || 'closed'));
    s.write(raw); setTimeout(() => s.destroy(), parallel ? 8000 : 3000);
  });
if (parallel) out = await Promise.all(reqs.map(one)); else for (const raw of reqs) out.push(await one(raw));
writeFileSync('/evidence/probe.json', JSON.stringify(out), { mode: 0o600 });
