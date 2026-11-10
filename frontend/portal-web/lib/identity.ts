// Server-side only: talks to the platform's microservices. Tokens never reach browser JavaScript.
export const IDENTITY_URL = process.env.IDENTITY_URL ?? 'http://localhost:3001';
export const ATTENDANCE_URL = process.env.ATTENDANCE_URL ?? 'http://localhost:3002';
export const DEFAULT_ORG = process.env.DEFAULT_ORG; // required in production; the sign-in form asks for the organisation when unset
export const REFRESH_DAYS = Number(process.env.REFRESH_TTL_DAYS ?? 14);

export type Role = 'worker' | 'supervisor' | 'management' | 'admin';
export type SessionUser = {
  id: string; staffNumber: string; fullName: string; email: string | null; phone: string | null; role: Role;
  tenant: { id: string; slug: string; name: string };
};
export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number; user: SessionUser };

export async function identity(path: string, init?: { method?: string; body?: unknown; token?: string }) {
  const res = await fetch(`${IDENTITY_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: res.ok, data };
}
