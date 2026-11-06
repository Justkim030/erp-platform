// Runs the Identity service against an in-memory database, with no Docker needed. FOR LOCAL DEVELOPMENT ONLY.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { newDb } from 'pg-mem';
import { AppModule } from './app.module';
import { CONFIG, config } from './config';
import { PG_POOL } from './db';
import { configureApp } from './setup';

async function main() {
  const pool = new (newDb().adapters.createPg().Pool)();
  const cfg = { ...config(), bootstrapToken: process.env.PLATFORM_BOOTSTRAP_TOKEN ?? 'dev-bootstrap-token' };
  const seed = process.env.DEV_SEED_ORG === '1';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PG_POOL).useValue(pool).overrideProvider(CONFIG).useValue(cfg).compile();
  const app = mod.createNestApplication();
  configureApp(app, cfg);
  await app.listen(cfg.port);
  const base = `http://localhost:${cfg.port}`;
  const json = { 'content-type': 'application/json' };
  if (seed) {
    // Optional seeding for local development: opt in with DEV_SEED_ORG=1.
    // The organisation name/slug/staff number come from env, and the administrator
    // sets their own password through /v1/auth/activate like any other user.
    const org = await (await fetch(`${base}/v1/platform/organisations`, { method: 'POST', headers: { ...json, 'x-bootstrap-token': cfg.bootstrapToken! }, body: JSON.stringify({ name: process.env.ORG_NAME ?? 'Dev Organisation', slug: process.env.ORG_SLUG ?? 'dev', adminStaffNumber: process.env.ADMIN_STAFF_NUMBER ?? '0001', adminName: process.env.ADMIN_NAME ?? 'Administrator' }) })).json();
    console.log(`Identity (in-memory) on :${cfg.port}. Organisation "${process.env.ORG_SLUG ?? 'dev'}" created. Activation code: ${org.activationCode}. It is shown only here, once.`);
  } else {
    console.log(`Identity (in-memory) on :${cfg.port}. No organisation seeded — set DEV_SEED_ORG=1 to create one via the platform endpoints.`);
  }
}
main();
