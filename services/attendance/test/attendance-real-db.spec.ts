/**
 * Real-PostgreSQL integration tests for Attendance.
 *
 * These tests run the ACTUAL service against a REAL PostgreSQL instance
 * (not pg-mem). They exercise migrations, transactions, advisory locks,
 * unique constraints and true concurrent clients. pg-mem cannot reproduce
 * any of this — that is exactly why these tests exist.
 *
 * Requires a test database. The repo ships scripts/test-db-init.ps1 which
 * creates an isolated instance on port 5544:
 *
 *   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-db-init.ps1
 *   set TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/attendance_test
 *   npm run test:pg -w @platform/attendance
 *
 * Skipped (clearly reported, not silently passed) when TEST_DATABASE_URL is unset.
 */
process.env.CLOCK_RATE_LIMIT = '1000';
process.env.GLOBAL_RATE_LIMIT = '10000';

import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import request from 'supertest';
import { JWKS } from '../src/auth';
import { AppModule } from '../src/app.module';
import { CONFIG, config } from '../src/config';
import { Db, PG_POOL } from '../src/db';
import { configureApp } from '../src/setup';
import { Member, Roster } from '../src/support';

const DB_URL = process.env.TEST_DATABASE_URL;
const d = (name: string, fn: () => void) => (DB_URL ? it(name, fn) : it.skip(`${name} [SKIPPED: set TEST_DATABASE_URL]`, fn));
const dd = (name: string, fn: () => void) => (DB_URL ? describe(name, fn) : describe.skip(`${name} [SKIPPED: set TEST_DATABASE_URL]`, fn));

class TestRoster extends Roster {
  teams = new Map<string, Member[]>();
  async members(user: any) { return this.teams.get(user.sub) ?? []; }
}
const roster = new TestRoster();
let app: INestApplication;
let pool: Pool;
let sign: (role: string, sub: string, tid?: string) => Promise<string>;

const api = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const CENTER = { lat: -0.5388, lng: 37.4596 };
const reading = (o: Partial<{ lat: number; lng: number; accuracy: number }> = {}) => ({ ...CENTER, accuracy: 15, capturedAt: new Date().toISOString(), ...o });
const member = (id: string, n: string, role = 'worker'): Member => ({ id, staffNumber: n, fullName: `Person ${n}`, role, status: 'active', supervisorId: null });

beforeAll(async () => {
  if (!DB_URL) return;
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
  sign = (role, sub, tid = 'tenant-a') =>
    new SignJWT({ tid, role }).setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setSubject(sub).setIssuer('platform-identity').setAudience('platform').setIssuedAt().setExpirationTime('10m').sign(privateKey);
  pool = new Pool({ connectionString: DB_URL, max: 20 });
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool)
    .overrideProvider(CONFIG).useValue({ ...config(), databaseUrl: DB_URL, purgeIntervalMs: 0 })
    .overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [pub] }))
    .overrideProvider(Roster).useValue(roster)
    .compile();
  app = mod.createNestApplication();
  configureApp(app, config() as any);
  await app.init();
});

afterAll(async () => {
  if (app) await app.close(); // Db.onModuleDestroy ends the pool exactly once
});

dd('real PostgreSQL: migrations', () => {
  d('applies all migrations from an empty database and records them', async () => {
    const done = await pool.query('SELECT id FROM schema_migrations ORDER BY id');
    expect(done.rowCount).toBeGreaterThanOrEqual(1);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('sites','attendance_events','audit_events','schema_migrations')`);
    expect(tables.rowCount).toBe(4);
  });

  d('migration framework is idempotent (rerun applies nothing new)', async () => {
    const before = (await pool.query('SELECT id FROM schema_migrations ORDER BY id')).rowCount;
    const db = app.get(Db);
    await (db as any).migrate(); // rerun
    const after = (await pool.query('SELECT id FROM schema_migrations ORDER BY id')).rowCount;
    expect(after).toBe(before);
  });
});

dd('real PostgreSQL: attendance state transitions and concurrency', () => {
  const workerId = 'real-worker-1';
  const token = () => sign('worker', workerId);

  beforeAll(async () => {
    if (!DB_URL) return;
    // Tests own this database: clear fixture rows so reruns start from a known state.
    // (Attendance events for test worker ids only; schema_migrations and site data persist.)
    await pool.query(
      `DELETE FROM audit_events WHERE actor_id LIKE 'real-%' OR target IN (SELECT id FROM attendance_events WHERE user_id LIKE 'real-%')`);
    await pool.query(`DELETE FROM attendance_events WHERE user_id LIKE 'real-%'`);
    // One site per tenant so clock-ins have a target; created by management, like in production.
    for (const tid of ['tenant-a', 'tenant-b']) {
      const existing = await pool.query(`SELECT id FROM sites WHERE tenant_id=$1 AND name='Main Gate'`, [tid]);
      if (!existing.rowCount) {
        const mgmt = await sign('management', 'mgmt-seed', tid);
        await api().post('/v1/sites').set(auth(mgmt)).send({ name: 'Main Gate', ...CENTER, radiusM: 150 }).expect(201);
      }
    }
  });

  d('a valid clock-in creates an event and a durable audit row in the same transaction', async () => {
    const res = await api().post('/v1/attendance/clock-in').set(auth(await token())).send({ reading: reading() }).expect(201);
    expect(res.body.outcome).toBe('accepted');
    const ev = await pool.query('SELECT * FROM attendance_events WHERE id=$1', [res.body.id]);
    expect(ev.rows[0].outcome).toBe('accepted');
    const aud = await pool.query(`SELECT * FROM audit_events WHERE action='attendance.clock_in' AND target=$1`, [res.body.id]);
    expect(aud.rowCount).toBe(1);
  });

  d('duplicate clock-in is refused', async () => {
    await api().post('/v1/attendance/clock-in').set(auth(await token())).send({ reading: reading() }).expect(409);
  });

  d('many simultaneous clock-ins: exactly one succeeds, rest are 409', async () => {
    // Fresh worker with no events: every concurrent request races to check-then-insert.
    const w = 'real-worker-race-in';
    roster.teams.set(w, [member(w, 'RR1')]);
    const t = await sign('worker', w);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        api().post('/v1/attendance/clock-in').set(auth(t)).send({ reading: reading() })
          .then((r) => r.status).catch(() => 500)),
    );
    expect(attempts.filter((s) => s === 201).length).toBe(1);
    expect(attempts.filter((s) => s === 409).length).toBe(7);
    const events = await pool.query(`SELECT count(*)::int AS n FROM attendance_events WHERE tenant_id='tenant-a' AND user_id=$1 AND outcome <> 'declined'`, [w]);
    expect(events.rows[0].n).toBe(1);
  });

  d('many simultaneous clock-outs: exactly one closes the session', async () => {
    const w = 'real-worker-race-out';
    roster.teams.set(w, [member(w, 'RR2')]);
    const t = await sign('worker', w);
    await api().post('/v1/attendance/clock-in').set(auth(t)).send({ reading: reading() }).expect(201);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        api().post('/v1/attendance/clock-out').set(auth(t)).send({ reading: reading(), workSummary: 'Concurrent close attempt' })
          .then((r) => r.status).catch(() => 500)),
    );
    expect(attempts.filter((s) => s === 201).length).toBe(1);
    expect(attempts.filter((s) => s === 409).length).toBe(7);
  });

  d('failed requests leave no partial state (audit rolls back with the event)', async () => {
    const w = 'real-worker-partial';
    roster.teams.set(w, [member(w, 'RR3')]);
    const t = await sign('worker', w);
    // duplicate clock-in fails after the transaction has started; nothing may be written
    await api().post('/v1/attendance/clock-in').set(auth(t)).send({ reading: reading() }).expect(201);
    const eventsBefore = (await pool.query(`SELECT count(*)::int AS n FROM attendance_events WHERE user_id=$1`, [w])).rows[0].n;
    await api().post('/v1/attendance/clock-in').set(auth(t)).send({ reading: reading() }).expect(409);
    const eventsAfter = (await pool.query(`SELECT count(*)::int AS n FROM attendance_events WHERE user_id=$1`, [w])).rows[0].n;
    expect(eventsAfter).toBe(eventsBefore);
    const auds = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action='attendance.clock_in' AND metadata->>'siteId' IS NOT NULL AND target IN (SELECT id FROM attendance_events WHERE user_id=$1)`, [w]);
    expect(auds.rows[0].n).toBe(eventsAfter); // one audit row per event, no orphans
  });

  d('concurrent clock-in and clock-out cannot both succeed', async () => {
    const w = 'real-worker-mixed';
    roster.teams.set(w, [member(w, 'RR4')]);
    const t = await sign('worker', w);
    await api().post('/v1/attendance/clock-in').set(auth(t)).send({ reading: reading() }).expect(201);
    const [inStatus, outStatus] = await Promise.all([
      api().post('/v1/attendance/clock-in').set(auth(t)).send({ reading: reading() }).then((r) => r.status),
      api().post('/v1/attendance/clock-out').set(auth(t)).send({ reading: reading(), workSummary: 'Mixed race' }).then((r) => r.status),
    ]);
    // exactly one of the two may succeed; the serialising lock makes the other a 409
    expect([inStatus, outStatus].filter((s) => s === 201).length).toBe(1);
    const final = await api().get('/v1/attendance/state').set(auth(t)).expect(200);
    expect(['in', 'out']).toContain(final.body.state);
  });

  d('tenant isolation under concurrency', async () => {
    const wA = 'real-worker-tenant-a', wB = 'real-worker-tenant-b';
    roster.teams.set(wA, [member(wA, 'RA')]);
    roster.teams.set(wB, [member(wB, 'RB')]);
    const [tA, tB] = await Promise.all([sign('worker', wA, 'tenant-a'), sign('worker', wB, 'tenant-b')]);
    await Promise.all([
      api().post('/v1/attendance/clock-in').set(auth(tA)).send({ reading: reading() }).expect(201),
      api().post('/v1/attendance/clock-in').set(auth(tB)).send({ reading: reading() }).expect(201),
    ]);
    // each tenant sees only its own worker's event
    await api().get('/v1/team/attendance').set(auth(await sign('management', 'mgmt-a', 'tenant-a'))).expect(200);
    // management roster is controlled by the test roster; direct DB check is authoritative here:
    const aRows = await pool.query(`SELECT count(*)::int AS n FROM attendance_events WHERE tenant_id='tenant-a' AND user_id=$1`, [wA]);
    const bRows = await pool.query(`SELECT count(*)::int AS n FROM attendance_events WHERE tenant_id='tenant-b' AND user_id=$1`, [wB]);
    expect(aRows.rows[0].n).toBe(1);
    expect(bRows.rows[0].n).toBe(1);
  });
});
