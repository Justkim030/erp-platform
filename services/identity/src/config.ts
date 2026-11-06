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
  return problems;
}

export type AppConfig = ReturnType<typeof config>;
