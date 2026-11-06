export function normaliseIp(ip?: string): string {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
const v4 = (ip: string): number | null => {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { const v = Number(x); if (!Number.isInteger(v) || v < 0 || v > 255 || x === '') return null; n = n * 256 + v; }
  return n;
};
/** IPv4 CIDR or exact match. IPv6 supports exact match only. */
export function ipInCidr(ip: string | undefined, cidr: string): boolean {
  const addr = normaliseIp(ip);
  const [base, bits] = cidr.split('/');
  if (!addr || !base) return false;
  if (addr.includes(':') || base.includes(':')) return addr.toLowerCase() === base.toLowerCase();
  const a = v4(addr), b = v4(base);
  if (a === null || b === null) return false;
  const n = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > 32) return false;
  if (n === 0) return true;
  const mask = (0xffffffff << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
