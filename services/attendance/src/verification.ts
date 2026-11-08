// Server-side presence verification. Pure functions: easy to test and to tune per site.
export interface SiteRow {
  id: string; tenant_id: string; name: string; lat: number; lng: number; radius_m: number; accuracy_limit_m: number;
  timezone: string; shift_start: string; grace_minutes: number; allowed_ips: string; require_network: boolean;
}
export interface Reading { lat?: number; lng?: number; accuracy?: number; capturedAt?: string }
export interface GeoPoint { lat: number | null; lng: number | null; occurred_at?: Date | string }
export type Outcome = 'accepted' | 'review' | 'declined';
export interface Verdict { outcome: Outcome; reasons: string[]; distanceM: number | null }

export function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const normaliseIp = (ip?: string) => (ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip ?? '');
const v4 = (ip: string): number | null => {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { const v = Number(x); if (x === '' || !Number.isInteger(v) || v < 0 || v > 255) return null; n = n * 256 + v; }
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

const same6 = (a: number, b: number) => Math.abs(a - b) < 5e-7;

export function evaluate(
  site: SiteRow, r: Reading,
  ctx: { ip?: string; now: Date; prev?: GeoPoint | null; recent: GeoPoint[] },
): Verdict {
  const ok = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
  if (!ok(r.lat, -90, 90) || !ok(r.lng, -180, 180) || !ok(r.accuracy, 0, 100_000)) {
    return { outcome: 'declined', reasons: ['location_unavailable'], distanceM: null };
  }
  const distance = haversine(site.lat, site.lng, r.lat, r.lng);
  const decline: string[] = [], review: string[] = [];

  if (distance - r.accuracy > site.radius_m) decline.push('outside_site');
  else if (distance > site.radius_m) review.push('uncertain_boundary');
  if (r.accuracy > site.accuracy_limit_m) review.push('low_accuracy');
  if (r.accuracy < 1) review.push('unrealistic_accuracy');

  const ips: string[] = JSON.parse(site.allowed_ips || '[]');
  if (ips.length && !ips.some((c) => ipInCidr(ctx.ip, c))) (site.require_network ? decline : review).push('network_not_recognised');

  if (r.capturedAt) {
    const age = Math.abs(ctx.now.getTime() - Date.parse(r.capturedAt));
    if (!Number.isFinite(age) || age > 120_000) review.push('stale_reading');
  }
  const prev = ctx.prev;
  if (prev?.lat != null && prev.lng != null && prev.occurred_at) {
    const dist = haversine(prev.lat, prev.lng, r.lat, r.lng);
    const hours = Math.max((ctx.now.getTime() - new Date(prev.occurred_at).getTime()) / 3_600_000, 1 / 3600);
    if (dist > 1000 && dist / 1000 / hours > 200) review.push('impossible_travel');
  }
  if (ctx.recent.length >= 3 && ctx.recent.slice(0, 3).every((p) => p.lat != null && p.lng != null && same6(p.lat, r.lat!) && same6(p.lng, r.lng!))) {
    review.push('identical_coordinates');
  }

  const reasons = [...decline, ...review];
  return { outcome: decline.length ? 'declined' : review.length ? 'review' : 'accepted', reasons, distanceM: Math.round(distance) };
}

/** True when a clock-in is later than shift start plus grace, judged in the site's own time zone. */
export function isLate(site: Pick<SiteRow, 'timezone' | 'shift_start' | 'grace_minutes'>, at: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: site.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')!.value), m = Number(parts.find((p) => p.type === 'minute')!.value);
  const [sh, sm] = site.shift_start.split(':').map(Number);
  return h * 60 + m > sh * 60 + sm + site.grace_minutes;
}

export const clockTime = (tz: string, at: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

const niceDistance = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

/** Plain-language result for the worker. Success says little; problems say what to do next, without naming internal checks. */
export function workerMessage(kind: 'in' | 'out', v: Verdict, site: SiteRow, at: Date): string {
  const t = clockTime(site.timezone, at);
  if (v.outcome === 'accepted') return kind === 'in' ? `Clocked in at ${t}.` : `Clocked out at ${t}. Your attendance has been recorded.`;
  if (v.outcome === 'review') return `Recorded at ${t}. Your supervisor will review this entry.`;
  if (v.reasons.includes('network_not_recognised')) return `Please connect to the ${site.name} staff network and try again.`;
  if (v.reasons.includes('outside_site') && v.distanceM != null) return `We could not confirm you are at ${site.name}. You appear to be about ${niceDistance(v.distanceM)} away. Move closer and try again, or ask your supervisor to review.`;
  return 'Your location could not be read. Allow location access and try again, or ask your supervisor to review.';
}
