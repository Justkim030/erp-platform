import { NextRequest, NextResponse } from 'next/server';
import { ATTENDANCE_URL, IDENTITY_URL, identity } from '@/lib/identity';
import { sameOrigin } from '@/lib/origin';
import { setSession } from '@/lib/session';

// Backend-for-frontend: the browser never sees tokens or service addresses, and can only reach these routes.
const ALLOW = [
  /^identity\/v1\/users(\/[\w-]+\/reset-access)?$/,
  /^attendance\/v1\/attendance\/(state|clock-in|clock-out|history)$/,
  /^attendance\/v1\/attendance\/events\/[\w-]+\/review$/,
  /^attendance\/v1\/sites(\/[\w-]+)?$/,
  /^attendance\/v1\/team\/(attendance|map|reviews)$/,
];
const TARGET: Record<string, string> = { identity: IDENTITY_URL, attendance: ATTENDANCE_URL };

async function handle(req: NextRequest, { params }: { params: { service: string; path: string[] } }) {
  const key = `${params.service}/${params.path.join('/')}`;
  if (!TARGET[params.service] || !ALLOW.some((r) => r.test(key))) return NextResponse.json({ message: 'Not found' }, { status: 404 });
  if (req.method !== 'GET' && !sameOrigin(req)) return NextResponse.json({ message: 'Forbidden' }, { status: 403 });

  let token = req.cookies.get('ph_at')?.value;
  let renewed: any = null;
  const rt = req.cookies.get('ph_rt')?.value;
  if (!token && rt) {
    const r = await identity('/v1/auth/refresh', { method: 'POST', body: { refreshToken: rt } }).catch(() => null);
    if (r?.ok) { renewed = r.data; token = r.data.accessToken; }
  }
  if (!token) return NextResponse.json({ message: 'Unauthorised' }, { status: 401 });

  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const ua = req.headers.get('user-agent'); if (ua) headers['user-agent'] = ua;
  // Forward the visitor's address so the service sees the real client (needed for the staff-network check).
  const xff = req.headers.get('x-forwarded-for'); if (xff) headers['x-forwarded-for'] = xff;
  // Correlation: propagate the browser's id or mint one, so a request can be traced Portal -> service.
  const cid = req.headers.get('x-correlation-id') ?? crypto.randomUUID();
  headers['x-correlation-id'] = cid;

  let upstream: Response;
  try {
    upstream = await fetch(`${TARGET[params.service]}/${params.path.join('/')}${req.nextUrl.search}`, {
      method: req.method, headers, body: req.method === 'GET' ? undefined : await req.text(), cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ message: 'The service is unavailable. Please try again shortly.' }, { status: 503 });
  }
  const out = new NextResponse(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-correlation-id': cid } });
  if (renewed) setSession(out, renewed);
  return out;
}
export { handle as GET, handle as POST, handle as PUT };
