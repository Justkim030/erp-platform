export const CONFIG = 'APP_CONFIG';

export const config = () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3002),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:5432/attendance',
  issuer: process.env.JWT_ISSUER ?? 'platform-identity',
  audience: process.env.JWT_AUDIENCE ?? 'platform',
  jwksUrl: process.env.IDENTITY_JWKS_URL ?? 'http://localhost:3001/.well-known/jwks.json',
  identityUrl: process.env.IDENTITY_URL ?? 'http://localhost:3001',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
  trustProxy: process.env.TRUST_PROXY as string | undefined,
  retentionDays: Number(process.env.RETENTION_DAYS ?? 90),          // exact coordinates are erased after this many days
  purgeIntervalMs: Number(process.env.PURGE_INTERVAL_MS ?? 86_400_000), // 0 disables the scheduled purge
  tzOffsetMinutes: Number(process.env.TZ_OFFSET_MINUTES ?? 180),      // day boundaries for reports (Kenya: UTC+3, no daylight saving)
  rosterTtlMs: Number(process.env.ROSTER_TTL_MS ?? 30_000),
});

/** Required configuration in production. Services must not start without a real database. */
export function validateProductionConfig(c: AppConfig): string[] {
  if (c.env !== 'production') return [];
  const problems: string[] = [];
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is required in production (refusing to start with a fallback database).');
  if (c.databaseUrl.includes('pg-mem') || c.databaseUrl.includes(':memory:')) problems.push('In-memory database URLs are not permitted in production.');
  return problems;
}
export type AppConfig = ReturnType<typeof config>;
