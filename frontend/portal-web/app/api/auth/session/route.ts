import { NextRequest, NextResponse } from 'next/server';
import { identity } from '@/lib/identity';
import { clearSession, setSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

// Used by the splash screen to decide where to send the visitor.
export async function GET(req: NextRequest) {
  let token = req.cookies.get('ph_at')?.value;
  const rt = req.cookies.get('ph_rt')?.value;
  let renewed: any = null;
  if (!token && rt) {
    const r = await identity('/v1/auth/refresh', { method: 'POST', body: { refreshToken: rt } }).catch(() => null);
    if (r?.ok) { renewed = r.data; token = r.data.accessToken; }
  }
  if (!token) { const res = NextResponse.json({ authenticated: false }); if (rt) clearSession(res); return res; }
  const me = await identity('/v1/me', { token }).catch(() => null);
  const res = NextResponse.json({ authenticated: !!me?.ok });
  if (me?.ok && renewed) setSession(res, renewed);
  return res;
}
