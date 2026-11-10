import { NextRequest, NextResponse } from 'next/server';

const IDENTITY_URL = process.env.IDENTITY_URL ?? 'http://localhost:3001';
const PROTECTED = ['/home', '/history', '/profile', '/team', '/map', '/sites'];

function configuredTileOrigin() {
  const template = process.env.NEXT_PUBLIC_MAP_TILE_URL?.trim();
  if (!template) return null;
  let url: URL;
  try {
    url = new URL(template.replace(/\{(?:z|x|y|apiKey)\}/g, '0'));
  } catch {
    throw new Error('MAP_TILE_URL must be an absolute HTTPS tile template.');
  }
  if (url.protocol !== 'https:') throw new Error('MAP_TILE_URL must use HTTPS.');
  return url.origin;
}

// CSP_MODE: "enforce" | "report-only" (default) | "off". Check the app in a real browser, then switch to "enforce".
function csp(nonce: string) {
  const dev = process.env.NODE_ENV !== 'production';
  const tileOrigins = new Set(['https://tile.openstreetmap.org', 'https://a.basemaps.cartocdn.com']);
  const configuredOrigin = configuredTileOrigin();
  if (configuredOrigin) tileOrigins.add(configuredOrigin);
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: blob: ${[...tileOrigins].join(' ')}`,
    "connect-src 'self'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

export async function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const mode = process.env.CSP_MODE ?? 'report-only';
  const policy = csp(nonce);
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  if (mode !== 'off') headers.set('content-security-policy', policy); // Next.js reads the nonce from here for its own scripts

  let renewed: any = null;
  const path = req.nextUrl.pathname;
  if (PROTECTED.some((p) => path === p || path.startsWith(`${p}/`)) && !req.cookies.get('ph_at')) {
    const rt = req.cookies.get('ph_rt')?.value;
    if (rt) {
      try {
        const r = await fetch(`${IDENTITY_URL}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
        if (r.ok) { renewed = await r.json(); headers.set('x-ph-at', renewed.accessToken); }
      } catch { /* fall through to login */ }
    }
    if (!renewed) {
      const res = NextResponse.redirect(new URL('/login', req.url));
      res.cookies.set('ph_rt', '', { path: '/', maxAge: 0 });
      return res;
    }
  }
  const res = NextResponse.next({ request: { headers } });
  if (renewed) {
    const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production';
    res.cookies.set('ph_at', renewed.accessToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: renewed.expiresIn });
    res.cookies.set('ph_rt', renewed.refreshToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 14 * 86400 });
  }
  if (mode === 'enforce') res.headers.set('Content-Security-Policy', policy);
  else if (mode === 'report-only') res.headers.set('Content-Security-Policy-Report-Only', policy);
  return res;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'] };
