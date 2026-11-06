process.env.CLOCK_RATE_LIMIT = '1000';
process.env.GLOBAL_RATE_LIMIT = '10000';

/**
 * pg-mem implements very few native PostgreSQL functions. The service uses
 * pg_advisory_xact_lock(hashtextextended(key, 0)) to serialise attendance
 * transitions; register a stand-in so the fast unit tests can run.
 * Real-PostgreSQL behaviour (the actual lock semantics) is covered by the
 * real-database concurrency tests, which do NOT use this shim.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgmem = require('pg-mem');
const originalNewDb = pgmem.newDb;
pgmem.newDb = (...args: any[]) => {
  const db = originalNewDb(...args);
  db.public.registerFunction({ name: 'hashtextextended', args: ['text', 'bigint'], returns: 'bigint', implementation: (s: string, seed: number) => {
    // Deterministic FNV-1a-style stand-in; value only needs to be stable within a test run.
    let h = BigInt(seed & 0xffffffff);
    for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
    return h;
  } });
  db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['bigint'], returns: 'int', implementation: () => null });
  return db;
};
