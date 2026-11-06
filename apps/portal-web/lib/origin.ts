import { NextRequest } from 'next/server';

/** CSRF defence for state-changing requests: browsers always send Origin on POST/PUT, and it must match this site. */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try { return new URL(origin).host === host; } catch { return false; }
}
