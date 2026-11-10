import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'node:net';
import { ATTENDANCE_URL, IDENTITY_URL, identity } from '@/lib/identity';
import { sameOrigin } from '@/lib/origin';
import { setSession } from '@/lib/session';

// Backend-for-frontend: the browser never sees tokens or service addresses, and can only reach these routes.
const ALLOW = [
  /^identity\/v1\/users(\/[\w-]+\/reset-access)?$/,
  /^identity\/v1\/workers\/[\w-]+\/supervisor$/,
  /^identity\/v1\/auth\/passkeys$/,
  /^identity\/v1\/auth\/passkeys\/(registration\/(options|verify)|clock\/(options|verify))$/,
  /^identity\/v1\/auth\/passkeys\/[\w-]+\/remove$/,
  /^attendance\/v1\/attendance\/(state|issues|clock-in|clock-out|history)$/,
  /^attendance\/v1\/attendance\/events\/[\w-]+\/review$/,
  /^attendance\/v1\/attendance\/exceptions$/,
  /^attendance\/v1\/attendance\/exceptions\/[\w-]+\/verifications$/,
  /^attendance\/v1\/attendance\/sessions\/[\w-]+\/verifications$/,
  /^attendance\/v1\/team\/attendance\/exceptions$/,
  /^attendance\/v1\/team\/attendance\/exceptions\/[\w-]+\/(review|override)$/,
  /^attendance\/v1\/team\/attendance\/physical-verification-issues$/,
  /^attendance\/v1\/work-reports(\/[\w-]+(\/(submit|review))?)?$/,
  /^attendance\/v1\/tasks(\/[\w-]+(\/progress)?)?$/,
  /^attendance\/v1\/management\/(insights|reports\/export\.csv)$/,
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
  // Only forward the address supplied by the trusted Next.js adapter, never a browser-provided forwarding header.
  const clientIp = req.ip;
  if (clientIp && isIP(clientIp)) headers['x-forwarded-for'] = clientIp;
  // Correlation: propagate the browser's id or mint one, so a request can be traced Portal -> service.
  const requestedCid = req.headers.get('x-correlation-id');
  const cid = requestedCid && /^[A-Za-z0-9._:-]{8,128}$/.test(requestedCid) ? requestedCid : crypto.randomUUID();
  headers['x-correlation-id'] = cid;

  let upstream: Response;
  try {
    upstream = await fetch(`${TARGET[params.service]}/${params.path.join('/')}${req.nextUrl.search}`, {
      method: req.method, headers, body: req.method === 'GET' ? undefined : await req.text(), cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ message: 'The service is unavailable. Please try again shortly.' }, { status: 503 });
  }
  const outHeaders = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    'x-correlation-id': cid,
  });
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) outHeaders.set('content-disposition', disposition);
  const out = new NextResponse(await upstream.text(), { status: upstream.status, headers: outHeaders });
  if (renewed) setSession(out, renewed);
  return out;
}
export { handle as GET, handle as POST, handle as PUT };
