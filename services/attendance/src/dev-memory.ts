// Runs the Attendance service against an in-memory database, with no Docker needed. FOR LOCAL DEVELOPMENT ONLY.
// Identity must be running too, because tokens are verified with its public key.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { newDb } from 'pg-mem';
import { AppModule } from './app.module';
import { config } from './config';
import { PG_POOL } from './db';
import { configureApp } from './setup';

async function main() {
  const pool = new (newDb().adapters.createPg().Pool)();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PG_POOL).useValue(pool).compile();
  const app = mod.createNestApplication();
  const cfg = config();
  configureApp(app, cfg as any);
  await app.listen(cfg.port);
  console.log(`Attendance (in-memory) on :${cfg.port}`);
}
main();
