import { NextResponse } from 'next/server';

export async function GET() {
  const services = [process.env.IDENTITY_URL, process.env.ATTENDANCE_URL];
  if (services.some((url) => !url)) {
    return NextResponse.json({ status: 'not_ready' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const checks = await Promise.all(services.map((url) =>
      fetch(`${url}/readyz`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })));
    if (checks.some((response) => !response.ok)) throw new Error('A backend service is not ready.');
    return NextResponse.json({ status: 'ready' }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ status: 'not_ready' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
