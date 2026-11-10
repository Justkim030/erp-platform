// Runs the Attendance service against an in-memory database, with no Docker needed. FOR LOCAL DEVELOPMENT ONLY.
// Identity must be running too, because tokens are verified with its public key.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataType, newDb } from 'pg-mem';
import { AppModule } from './app.module';
import { config } from './config';
import { PG_POOL } from './db';
import { configureApp } from './setup';

async function main() {
  const memory = newDb();
  memory.public.registerFunction({
    name: 'hashtextextended', args: [DataType.text, DataType.integer], returns: DataType.bigint,
    implementation: (s: string, seed: number) => {
      let h = BigInt(seed & 0xffffffff);
      for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
      return h;
    },
  });
  // The local single-process database has no concurrent writers to serialize.
  memory.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.bigint], returns: DataType.integer, implementation: () => null });
  const pool = new (memory.adapters.createPg().Pool)();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PG_POOL).useValue(pool).compile();
  const app = mod.createNestApplication();
  const cfg = config();
  configureApp(app, cfg as any);
  await app.listen(cfg.port);
  console.log(`Attendance (in-memory) on :${cfg.port}`);
}
main();
