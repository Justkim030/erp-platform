export const CONFIG = 'APP_CONFIG';

export const config = () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:5432/identity',
  issuer: process.env.JWT_ISSUER ?? 'platform-identity',
  audience: process.env.JWT_AUDIENCE ?? 'platform',
  accessTtl: Number(process.env.ACCESS_TTL_SECONDS ?? 600),
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 14),
  signingKeyJwk: process.env.SIGNING_KEY_JWK as string | undefined,
  bootstrapToken: process.env.PLATFORM_BOOTSTRAP_TOKEN as string | undefined,
  lockoutThreshold: Number(process.env.LOCKOUT_THRESHOLD ?? 5),
  lockoutMinutes: Number(process.env.LOCKOUT_MINUTES ?? 15),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
  webauthnRpId: process.env.WEBAUTHN_RP_ID ?? 'localhost',
  webauthnRpName: process.env.WEBAUTHN_RP_NAME ?? 'ERP Platform',
  webauthnOrigins: (process.env.WEBAUTHN_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: process.env.TRUST_PROXY as string | undefined,
  platformAllowedIps: (process.env.PLATFORM_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});

/** Required configuration in production. Services must not start without a real database and signing key. */
export function validateProductionConfig(c: AppConfig): string[] {
  if (c.env !== 'production') return [];
  const problems: string[] = [];
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is required in production (refusing to start with a fallback database).');
  if (c.databaseUrl.includes('pg-mem') || c.databaseUrl.includes(':memory:')) problems.push('In-memory database URLs are not permitted in production.');
  if (!c.signingKeyJwk) problems.push('SIGNING_KEY_JWK is required in production (no signing key, no tokens).');
  if (!c.bootstrapToken) problems.push('PLATFORM_BOOTSTRAP_TOKEN is required in production.');
  else if (Buffer.byteLength(c.bootstrapToken, 'utf8') < 32) problems.push('PLATFORM_BOOTSTRAP_TOKEN must contain at least 32 bytes in production.');
  if (!process.env.WEBAUTHN_RP_ID) problems.push('WEBAUTHN_RP_ID is required in production.');
  if (!process.env.WEBAUTHN_ORIGINS) problems.push('WEBAUTHN_ORIGINS is required in production.');
  try {
    const rp = new URL(`https://${c.webauthnRpId}`);
    if (rp.host !== c.webauthnRpId || rp.pathname !== '/') problems.push('WEBAUTHN_RP_ID must be a hostname without a scheme, port, or path.');
  } catch {
    problems.push('WEBAUTHN_RP_ID must be a valid hostname.');
  }
  for (const origin of c.webauthnOrigins) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== 'https:' && url.hostname !== 'localhost')) {
        problems.push('WEBAUTHN_ORIGINS must contain exact HTTPS origins (HTTP is allowed only for localhost).');
        break;
      }
      if (url.hostname !== c.webauthnRpId && !url.hostname.endsWith(`.${c.webauthnRpId}`)) {
        problems.push('Each WEBAUTHN_ORIGINS host must match WEBAUTHN_RP_ID or be its subdomain.');
        break;
      }
    } catch {
      problems.push('WEBAUTHN_ORIGINS must contain valid origins.');
      break;
    }
  }
  return problems;
}

export type AppConfig = ReturnType<typeof config>;
