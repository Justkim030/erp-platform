// In-memory token bucket, keyed per bucket name and client address.
// Guards the portal's own auth routes (login, activate) and the svc proxy against
// password guessing and code brute-force at the browser-facing edge.
//
// Scope: this is per process instance. With more than one portal instance, move the
// buckets to a shared store (Redis) — the interface here is kept deliberately narrow
// so that swap is a one-file change.

const DEFAULT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 10); // attempts per window
const DEFAULT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 5 * 60_000); // 5 minutes
const MAX_BUCKETS = 10_000; // hard cap so key flooding cannot exhaust memory
const SWEEP_INTERVAL_MS = 60_000;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

export function clientIpOf(req: Request): string {
  // Next.js sets req.ip only when trusted proxy information is configured; fall back
  // to a single bucket for unknown clients rather than trusting forwarded headers.
  const ip = (req as unknown as { ip?: string }).ip;
  return ip && ip.length <= 64 ? ip : 'unknown';
}

/** Consumes one slot. Returns null when allowed, or the retry delay in seconds. */
export function takeRateLimit(bucketName: string, ip: string, max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  sweep(now);
  if (buckets.size >= MAX_BUCKETS && !buckets.has(`${bucketName}:${ip}`)) {
    // Under flood: fail closed for auth routes is too disruptive, so fail open but log-worthy.
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const key = `${bucketName}:${ip}`;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** True when this request is over its bucket limit; callers answer 429. */
export function isRateLimited(bucketName: string, req: Request, max?: number, windowMs?: number): boolean {
  return !takeRateLimit(bucketName, clientIpOf(req), max, windowMs).allowed;
}

export const RATE_LIMIT_MESSAGE = 'Too many attempts. Please wait a minute and try again.';
