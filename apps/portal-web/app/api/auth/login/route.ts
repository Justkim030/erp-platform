import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_ORG, identity } from '@/lib/identity';
import { sameOrigin } from '@/lib/origin';
import { friendlyError, setSession } from '@/lib/session';

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  if (!b.organisation && !DEFAULT_ORG) return NextResponse.json({ error: 'This portal is not linked to an organisation. Add DEFAULT_ORG to the environment.' }, { status: 503 });
  const r = await identity('/v1/auth/login', { method: 'POST', body: { organisation: b.organisation || DEFAULT_ORG, staffNumber: b.staffNumber, password: b.password } });
  if (!r.ok) return NextResponse.json({ error: friendlyError(r.status, r.data, 'Log in is unavailable. Please try again shortly.') }, { status: r.status === 401 || r.status === 429 ? r.status : 400 });
  const res = NextResponse.json({ user: r.data.user });
  setSession(res, r.data);
  return res;
}
