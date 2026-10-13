import { isIP } from 'node:net';

function canonicalIpv6(address: string): string | null {
  if (address.includes('.')) return null;
  const sides = address.split('::');
  if (sides.length > 2) return null;
  const fields = (side: string) => side.length === 0 ? [] : side.split(':');
  const left = fields(sides[0] ?? '');
  const right = sides.length === 2 ? fields(sides[1] ?? '') : [];
  if (sides.length === 1 ? left.length !== 8 : left.length + right.length > 7) return null;
  const hextets = sides.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const normalized = hextets.map(field => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(field)) return '';
    return field.toLowerCase().replace(/^0+/, '') || '0';
  });
  if (normalized.some(field => field === '')) return null;
  return normalized.join(':');
}

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 88 && c === 99));
  }
  if (isIP(address) !== 6) return false;
  const canonical = canonicalIpv6(address);
  // 6to4 (2002::/16) embeds an IPv4 address in bits 16-47, so it is never treated as public.
  return canonical !== null && /^2[0-9a-f]{3}:/.test(canonical) && !/^2001:(?:db8|0|2):/.test(canonical) && !/^2002:/.test(canonical);
}
