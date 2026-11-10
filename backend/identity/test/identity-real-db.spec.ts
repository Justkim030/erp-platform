/**
 * Real-PostgreSQL integration tests for Identity.
 * Complements (does not replace) the fast pg-mem unit suite.
 *
 *   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-db-init.ps1
 *   set TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/identity_test
 *   npm run test:pg -w @platform/identity
 *
 * Skipped (clearly reported) when TEST_DATABASE_URL is unset.
 */
process.env.AUTH_RATE_LIMIT = '1000';
process.env.GLOBAL_RATE_LIMIT = '10000';

import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CONFIG, config } from '../src/config';
import { PG_POOL } from '../src/db';
import { Notifier } from '../src/notifier';
import { configureApp } from '../src/setup';

const DB_URL = process.env.TEST_DATABASE_URL;
const d = (name: string, fn: () => void) => (DB_URL ? it(name, fn) : it.skip(`${name} [SKIPPED: set TEST_DATABASE_URL]`, fn));
const dd = (name: string, fn: () => void) => (DB_URL ? describe(name, fn) : describe.skip(`${name} [SKIPPED: set TEST_DATABASE_URL]`, fn));

class RecordingNotifier extends Notifier {
  sent: { template: string; data: Record<string, string> }[] = [];
  async send(_to: any, template: any, data: Record<string, string>) { this.sent.push({ template, data }); }
}

const BOOT = 'test-bootstrap-token';
const PASS = 'Correct-Horse-2026';
let app: INestApplication;
let pool: Pool;
const notifier = new RecordingNotifier();
const api = () => request(app.getHttpServer());
const platform = (path: string, body: object, token = BOOT) => api().post(`/v1/platform${path}`).set('x-bootstrap-token', token).send(body);
const login = (org: string, staff: string, password: string) => api().post('/v1/auth/login').send({ organisation: org, staffNumber: staff, password });
const activate = (org: string, staffNumber: string, activationCode: string, credentialType: 'password' | 'pin', secret: string) =>
  api().post('/v1/auth/activate').send({ organisation: org, staffNumber, activationCode, credentialType, secret });
const addUser = (token: string, body: object) => api().post('/v1/users').set('Authorization', `Bearer ${token}`).send(body);

const unique = Math.random().toString(36).slice(2, 8); // per-run suffix so reruns never collide

async function makeOrg(slug: string) {
  const org = await platform('/organisations', { name: `Org ${slug}`, slug, adminStaffNumber: '0001', adminName: 'Admin One' }).expect(201);
  const act = await activate(slug, '0001', org.body.activationCode, 'password', PASS).expect(201);
  return act.body.accessToken as string;
}

beforeAll(async () => {
  if (!DB_URL) return;
  pool = new Pool({ connectionString: DB_URL, max: 10 });
  const cfg = { ...config(), databaseUrl: DB_URL, bootstrapToken: BOOT, signingKeyJwk: undefined, lockoutThreshold: 3, env: 'test' };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool).overrideProvider(CONFIG).useValue(cfg).overrideProvider(Notifier).useValue(notifier).compile();
  app = mod.createNestApplication();
  configureApp(app, cfg);
  await app.init();
});

afterAll(async () => { if (app) await app.close(); });

dd('real PostgreSQL: identity', () => {
  d('migrations create the expected schema and are idempotent on rerun', async () => {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tenants','users','invites','refresh_tokens','password_resets','audit_events','schema_migrations')`);
    expect(tables.rowCount).toBe(7);
    const before = (await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
    await app.get(require('../src/db').Db).migrate();
    const after = (await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
    expect(after).toBe(before);
  });

  d('user creation writes user + invite + audit atomically', async () => {
    const slug = `audit-org-${unique}`;
    const adminToken = await makeOrg(slug);
    const tidRow = await pool.query('SELECT id FROM tenants WHERE slug=$1', [slug]);
    const tid = tidRow.rows[0].id;
    const created = await addUser(adminToken, { staffNumber: '0500', fullName: 'Audit Target', role: 'worker' }).expect(201);
    // the audit row for this creation must exist, in the same tenant
    const aud = await pool.query(`SELECT * FROM audit_events WHERE action='user.created' AND target='0500' AND tenant_id=$1`, [tid]);
    expect(aud.rowCount).toBe(1);
    expect(aud.rows[0].metadata.role).toBe('worker');
    expect(created.body.activationCode).toBeDefined();
  });

  d('access reset revokes sessions and writes its audit row transactionally', async () => {
    const slug = `reset-org-${unique}`;
    const adminToken = await makeOrg(slug);
    const tid = (await pool.query('SELECT id FROM tenants WHERE slug=$1', [slug])).rows[0].id;
    const created = await addUser(adminToken, { staffNumber: '0501', fullName: 'Reset Target', role: 'worker' }).expect(201);
    const act = await activate(slug, '0501', created.body.activationCode, 'password', 'Another-Long-2026').expect(201);
    // active session exists
    const sess = await pool.query(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL`, [created.body.user.id]);
    expect(sess.rows[0].n).toBeGreaterThan(0);
    await api().post(`/v1/users/${created.body.user.id}/reset-access`).set('Authorization', `Bearer ${adminToken}`).expect(201);
    const revoked = await pool.query(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NOT NULL`, [created.body.user.id]);
    expect(revoked.rows[0].n).toBe(sess.rows[0].n);
    const aud = await pool.query(`SELECT * FROM audit_events WHERE action='user.access_reset' AND tenant_id=$1`, [tid]);
    expect(aud.rowCount).toBe(1);
    // old session no longer refreshes
    await api().post('/v1/auth/refresh').send({ refreshToken: act.body.refreshToken }).expect(401);
  });

  d('correlation id propagates: echoed in response header and stored in audit metadata', async () => {
    const slug = `corr-org-${unique}`;
    const adminToken = await makeOrg(slug);
    const res = await api().post('/v1/users').set('Authorization', `Bearer ${adminToken}`).set('x-correlation-id', 'test-corr-12345678').send({ staffNumber: '0502', fullName: 'Corr Target', role: 'worker' }).expect(201);
    expect(res.headers['x-correlation-id']).toBe('test-corr-12345678');
    const tid = (await pool.query('SELECT id FROM tenants WHERE slug=$1', [slug])).rows[0].id;
    const aud = await pool.query(`SELECT metadata->>'correlationId' AS cid FROM audit_events WHERE action='user.created' AND target='0502' AND tenant_id=$1`, [tid]);
    expect(aud.rows[0].cid).toBe('test-corr-12345678');
  });

  d('stage 2: departments, reassignment history, status history (real constraints)', async () => {
    const slug = `s2-org-${unique}`;
    const adminToken = await makeOrg(slug);
    const tid = (await pool.query('SELECT id FROM tenants WHERE slug=$1', [slug])).rows[0].id;
    // department
    const dep = await api().post('/v1/departments').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Production', code: 'PROD' }).expect(201);
    expect(dep.body.active).toBe(true);
    await api().post('/v1/departments').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Other', code: 'PROD' }).expect(409); // unique code
    await api().post('/v1/departments').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Production' }).expect(409);      // unique name
    // worker in department with supervisor
    const sup = await addUser(adminToken, { staffNumber: '0700', fullName: 'Sup S2', role: 'supervisor' }).expect(201);
    await activate(slug, '0700', sup.body.activationCode, 'password', 'Supervisor-2026').expect(201);
    const w = await addUser(adminToken, { staffNumber: '0701', fullName: 'Worker S2', role: 'worker', supervisorId: sup.body.user.id, departmentId: dep.body.id }).expect(201);
    expect(w.body.user.departmentId).toBe(dep.body.id);
    // reassignment closes old assignment, opens new
    const sup2 = await addUser(adminToken, { staffNumber: '0702', fullName: 'Sup S2B', role: 'supervisor' }).expect(201);
    await activate(slug, '0702', sup2.body.activationCode, 'password', 'Supervisor-2026B').expect(201);
    const re = await api().post(`/v1/workers/${w.body.user.id}/supervisor`).set('Authorization', `Bearer ${adminToken}`).send({ supervisorId: sup2.body.user.id, reason: 'restructure' }).expect(200);
    expect(re.body.changed).toBe(true);
    const hist = await api().get(`/v1/workers/${w.body.user.id}/assignments`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(hist.body.length).toBe(2);
    expect(hist.body.filter((r: any) => r.endedAt !== null).length).toBe(1);
    expect(hist.body.filter((r: any) => r.endedAt === null).length).toBe(1);
    // status change + history
    await api().post(`/v1/users/${w.body.user.id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'deactivated', reason: 'left' }).expect(200);
    const sh = await api().get(`/v1/users/${w.body.user.id}/status-history`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(sh.body.length).toBe(1);
    expect(sh.body[0].previousStatus).toBe('invited'); // truth: worker was created but never activated
    expect(sh.body[0].status).toBe('deactivated');
    // soft deactivation: gone from active list, present with active=false in full list
    const d2 = await api().post('/v1/departments').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Temp Dept' }).expect(201);
    await api().post(`/v1/departments/${d2.body.id}/deactivate`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    const active = await api().get('/v1/departments').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(active.body.find((x: any) => x.id === d2.body.id)).toBeUndefined();
    const all = await api().get('/v1/departments?includeInactive=true').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(all.body.find((x: any) => x.id === d2.body.id).active).toBe(false);
    // audit rows for all three critical actions
    const audits = await pool.query(`SELECT action, count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND action IN ('department.created','worker.reassigned','user.status_changed') GROUP BY action`, [tid]);
    const byAction = Object.fromEntries(audits.rows.map((r) => [r.action, r.n]));
    expect(byAction['department.created']).toBe(2); // Production + Temp Dept
    expect(byAction['worker.reassigned']).toBe(1);
    expect(byAction['user.status_changed']).toBe(1);
  });

  d('login audit still recorded (best-effort path, non-critical)', async () => {
    const slug = `login-org-${unique}`;
    await makeOrg(slug);
    await login(slug, '0001', PASS).expect(200);
    await login(slug, '0001', 'wrong-password').expect(401);
    const auds = await pool.query(`SELECT action, count(*)::int AS n FROM audit_events WHERE tenant_id=(SELECT id FROM tenants WHERE slug=$1) AND action LIKE 'login.%' GROUP BY action`, [slug]);
    const byAction = Object.fromEntries(auds.rows.map((r) => [r.action, r.n]));
    expect(byAction['login.success']).toBeGreaterThanOrEqual(1);
    expect(byAction['login.failed']).toBeGreaterThanOrEqual(1);
  });

  d('pagination: default bounded array, page param returns envelope', async () => {
    const slug = `page-org-${unique}`;
    const adminToken = await makeOrg(slug);
    for (let i = 0; i < 7; i++) await addUser(adminToken, { staffNumber: `07${i}0`, fullName: `P ${i}`, role: 'worker' }).expect(201);
    // legacy shape: plain array (bounded)
    const legacy = await api().get('/v1/users').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(Array.isArray(legacy.body)).toBe(true);
    expect(legacy.body.length).toBeGreaterThanOrEqual(7);
    // envelope shape
    const env = await api().get('/v1/users?page=1&pageSize=3').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(env.body.items.length).toBe(3);
    expect(env.body.page).toBe(1);
    expect(env.body.pageSize).toBe(3);
    expect(env.body.total).toBe(8); // 7 workers + the org admin
    const env2 = await api().get('/v1/users?page=3&pageSize=3').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(env2.body.items.length).toBe(2);
    // stable ordering: no overlap between pages
    const ids1 = env.body.items.map((u: any) => u.id), ids2 = env2.body.items.map((u: any) => u.id);
    expect(ids1.filter((x: string) => ids2.includes(x)).length).toBe(0);
  });

  d('supervisor scoping still enforced with pagination', async () => {
    const slug = `scope-org-${unique}`;
    const adminToken = await makeOrg(slug);
    const sup = await addUser(adminToken, { staffNumber: '0600', fullName: 'Sup One', role: 'supervisor' }).expect(201);
    const supToken = (await activate(slug, '0600', sup.body.activationCode, 'password', 'Supervisor-2026').expect(201)).body.accessToken;
    const otherSup = await addUser(adminToken, { staffNumber: '0603', fullName: 'Sup Two', role: 'supervisor' }).expect(201);
    await activate(slug, '0603', otherSup.body.activationCode, 'password', 'Supervisor-2026B').expect(201);
    // UI-created users link supervisors by id, not staff number
    await addUser(adminToken, { staffNumber: '0601', fullName: 'Their Worker', role: 'worker', supervisorId: sup.body.user.id }).expect(201);
    await addUser(adminToken, { staffNumber: '0602', fullName: 'Other Worker', role: 'worker', supervisorId: otherSup.body.user.id }).expect(201);
    const mine = await api().get('/v1/users').set('Authorization', `Bearer ${supToken}`).expect(200);
    expect(mine.body.length).toBe(1);
    expect(mine.body[0].fullName).toBe('Their Worker');
  });
});
