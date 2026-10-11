import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicAddress } from './public-address.ts';
export { publicAddress };
export async function validateUrl(raw: string, allowed = process.env.ROVE_ALLOWED_HOSTS): Promise<URL> {
  const url = new URL(raw);
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port))) throw new Error('Only public HTTP(S) URLs on standard ports are supported.');
  const host = url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const hosts = (allowed??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if (process.env.NODE_ENV==='production' && !hosts.length) throw new Error('Set ROVE_ALLOWED_HOSTS before production use.');
  if (hosts.length && !hosts.includes(host)) throw new Error('This hostname is outside the configured allowlist.');
  const addresses = isIP(host) ? [{address:host}] : await lookup(host,{all:true});
  if (!addresses.length||addresses.some(x=>!publicAddress(x.address))) throw new Error('Private and reserved network targets are blocked.');
  return url;
}
