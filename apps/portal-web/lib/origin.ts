import { NextRequest } from 'next/server';

/**
 * CSRF defence for state-changing requests: browsers always send Origin on POST/PUT,
 * and it must match this site.
 *
 * The comparison target is chosen carefully:
 * - `x-forwarded-host` is browser-supplied when TRUST_PROXY is not configured, so
 *   trusting it blindly would let an attacker make their own origin "match".
 * - We therefore only accept x-forwarded-host when the deployment declares trusted
 *   proxy hops (TRUST_PROXY >= 1). Otherwise we fall back to the connection Host,
 *   which the platform controls.
 */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const hops = Number(process.env.TRUST_PROXY ?? '0');
  const forwarded = req.headers.get('x-forwarded-host');
  const host = hops >= 1 && forwarded ? forwarded : req.headers.get('host');
  try { return new URL(origin).host === host; } catch { return false; }
}
