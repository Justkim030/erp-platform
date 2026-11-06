import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ATTENDANCE_URL, IDENTITY_URL, REFRESH_DAYS, Role, SessionUser, Tokens, identity } from './identity';

const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production';

export function setSession(res: NextResponse, t: Pick<Tokens, 'accessToken' | 'refreshToken' | 'expiresIn'>) {
  res.cookies.set('ph_at', t.accessToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: t.expiresIn });
  res.cookies.set('ph_rt', t.refreshToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: REFRESH_DAYS * 86400 });
}
export function clearSession(res: NextResponse) {
  res.cookies.set('ph_at', '', { path: '/', maxAge: 0 });
  res.cookies.set('ph_rt', '', { path: '/', maxAge: 0 });
}

/** Access token for the current request. Middleware may forward a freshly renewed one in a header. */
export function accessToken() {
  return headers().get('x-ph-at') ?? cookies().get('ph_at')?.value;
}

export async function getSession(): Promise<SessionUser | null> {
  const token = accessToken();
  if (!token) return null;
  const r = await identity('/v1/me', { token });
  return r.ok ? (r.data as SessionUser) : null;
}

/** Signed-in user, optionally restricted to some roles. Others are sent away. */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const u = await getSession();
  if (!u) redirect('/login');
  if (roles && !roles.includes(u.role)) redirect('/home');
  return u;
}

/** Reads data from a microservice on behalf of the signed-in user. Returns null when unavailable. */
export async function svc<T = any>(service: 'identity' | 'attendance', path: string): Promise<T | null> {
  const token = accessToken();
  if (!token) return null;
  try {
    const r = await fetch(`${service === 'identity' ? IDENTITY_URL : ATTENDANCE_URL}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}

export function friendlyError(status: number, data: any, fallback: string) {
  if (status === 429) return 'Too many attempts. Please wait a minute and try again.';
  if (status === 401) return 'Staff number or password or PIN is incorrect.';
  if (status === 400 && typeof data?.message === 'string') return data.message;
  if (status === 400 && Array.isArray(data?.message)) return 'Please check the details you entered.';
  return fallback;
}
