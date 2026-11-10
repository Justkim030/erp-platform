process.env.AUTH_RATE_LIMIT = '1000';
process.env.GLOBAL_RATE_LIMIT = '10000';

/**
 * pg-mem shim for native functions used by the service (see attendance/test/setup.ts
 * for the full rationale). Real-PostgreSQL behaviour is covered by the real-db suite.
 */
const pgmem = require('pg-mem');
const originalNewDb = pgmem.newDb;
pgmem.newDb = (...args: any[]) => {
  const db = originalNewDb(...args);
  db.public.registerFunction({ name: 'hashtextextended', args: ['text', 'bigint'], returns: 'bigint', implementation: (s: string, seed: number) => {
    let h = BigInt(seed & 0xffffffff);
    for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
    return h;
  } });
  db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['bigint'], returns: 'int', implementation: () => null });
  return db;
};
