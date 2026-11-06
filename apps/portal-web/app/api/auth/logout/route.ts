import { NextRequest, NextResponse } from 'next/server';
import { identity } from '@/lib/identity';
import { sameOrigin } from '@/lib/origin';
import { clearSession } from '@/lib/session';

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const rt = req.cookies.get('ph_rt')?.value;
  if (rt) await identity('/v1/auth/logout', { method: 'POST', body: { refreshToken: rt } }).catch(() => null);
  const res = NextResponse.json({ ok: true });
  clearSession(res);
  return res;
}
