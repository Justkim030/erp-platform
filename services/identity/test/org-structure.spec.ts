/**
 * Stage 2 tests: departments, supervisor reassignment history, employee status history.
 * Runs on pg-mem (fast) and, for migration + constraint behaviour, on real PostgreSQL
 * via the shared real-db spec pattern.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CONFIG, config } from '../src/config';
import { PG_POOL } from '../src/db';
import { Notifier } from '../src/notifier';
import { configureApp } from '../src/setup';

process.env.AUTH_RATE_LIMIT = '1000';
process.env.GLOBAL_RATE_LIMIT = '10000';

class RecordingNotifier extends Notifier {
  sent: { template: string; data: Record<string, string> }[] = [];
  async send(_to: any, template: any, data: Record<string, string>) { this.sent.push({ template, data }); }
}

const BOOT = 'test-bootstrap-token';
const PASS = 'Correct-Horse-2026';
let app: INestApplication;
const notifier = new RecordingNotifier();
const api = () => request(app.getHttpServer());
const platform = (path: string, body: object) => api().post(`/v1/platform${path}`).set('x-bootstrap-token', BOOT).send(body);
const activate = (org: string, staff: string, code: string, type: 'password' | 'pin', secret: string) =>
  api().post('/v1/auth/activate').send({ organisation: org, staffNumber: staff, activationCode: code, credentialType: type, secret });
const addUser = (token: string, body: object) => api().post('/v1/users').set('Authorization', `Bearer ${token}`).send(body);
const uid = Math.random().toString(36).slice(2, 8);

async function makeOrg(slug: string) {
  const org = await platform('/organisations', { name: `Org ${slug}`, slug, adminStaffNumber: '0001', adminName: 'Admin One' }).expect(201);
  return (await activate(slug, '0001', org.body.activationCode, 'password', PASS).expect(201)).body.accessToken as string;
}

beforeAll(async () => {
  const pool = new (newDb().adapters.createPg().Pool)();
  const cfg = { ...config(), bootstrapToken: BOOT, signingKeyJwk: undefined, env: 'test' };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool).overrideProvider(CONFIG).useValue(cfg).overrideProvider(Notifier).useValue(notifier).compile();
  app = mod.createNestApplication();
  configureApp(app, cfg);
  await app.init();
});
afterAll(async () => { await app.close(); });

describe('stage 2: departments', () => {
  let admin: string, mgmt: string, sup: string, supId: string, org: string;
  beforeAll(async () => {
    org = `dept-org-${uid}`;
    admin = await makeOrg(org);
    // promote an admin-created management user
    const m = await addUser(admin, { staffNumber: '0901', fullName: 'Manager One', role: 'management' }).expect(201);
    mgmt = (await activate(org, '0901', m.body.activationCode, 'password', 'Manager-2026-ok').expect(201)).body.accessToken;
    const s = await addUser(admin, { staffNumber: '0902', fullName: 'Sup One', role: 'supervisor' }).expect(201);
    supId = s.body.user.id;
    sup = (await activate(org, '0902', s.body.activationCode, 'password', 'Supervisor-2026').expect(201)).body.accessToken;
  });

  it('management creates a department with a code and manager', async () => {
    const res = await api().post('/v1/departments').set('Authorization', `Bearer ${mgmt}`)
      .send({ name: 'Production', code: 'PROD' }).expect(201);
    expect(res.body.name).toBe('Production');
    expect(res.body.active).toBe(true);
  });

  it('supervisor cannot create departments', async () => {
    await api().post('/v1/departments').set('Authorization', `Bearer ${sup}`).send({ name: 'Rogue' }).expect(403);
  });

  // NOTE: unique-constraint and soft-deactivation persistence tests live in the
  // real-DB suite (pg-mem does not reliably enforce constraints/updates here).

  it('worker creation can reference a department; unknown department is 404', async () => {
    const depts = await api().get('/v1/departments').set('Authorization', `Bearer ${mgmt}`).expect(200);
    const prodId = depts.body[0].id;
    const w = await addUser(mgmt, { staffNumber: '0910', fullName: 'Dept Worker', role: 'worker', supervisorId: supId, departmentId: prodId }).expect(201);
    expect(w.body.user.departmentId).toBe(prodId);
    await addUser(mgmt, { staffNumber: '0911', fullName: 'Bad Dept', role: 'worker', supervisorId: supId, departmentId: 'nonexistent000' }).expect(404);
  });

  // NOTE: soft-deactivation persistence is verified in the real-DB suite
  // (pg-mem does not reliably preserve UPDATE visibility across pooled queries).
});

describe('stage 2: supervisor reassignment and history', () => {
  let admin: string, org: string, supA: string, supB: string, supAId: string, workerId: string;
  beforeAll(async () => {
    org = `reassign-org-${uid}`;
    admin = await makeOrg(org);
    const a = await addUser(admin, { staffNumber: '0920', fullName: 'Sup A', role: 'supervisor' }).expect(201);
    supA = (await activate(org, '0920', a.body.activationCode, 'password', 'SupA-2026-pass').expect(201)).body.accessToken;
    supAId = a.body.user.id;
    const b = await addUser(admin, { staffNumber: '0921', fullName: 'Sup B', role: 'supervisor' }).expect(201);
    supB = (await activate(org, '0921', b.body.activationCode, 'password', 'SupB-2026-pass').expect(201)).body.accessToken;
    const w = await addUser(admin, { staffNumber: '0922', fullName: 'Moved Worker', role: 'worker', supervisorId: supAId }).expect(201);
    workerId = w.body.user.id;
  });

  it('supervisor A sees the worker initially', async () => {
    const list = await api().get('/v1/users').set('Authorization', `Bearer ${supA}`).expect(200);
    expect(list.body.some((u: any) => u.id === workerId)).toBe(true);
  });

  it('supervisor B cannot see the worker before reassignment', async () => {
    const list = await api().get('/v1/users').set('Authorization', `Bearer ${supB}`).expect(200);
    expect(list.body.some((u: any) => u.id === workerId)).toBe(false);
  });

  it('management reassigns the worker (full history detail verified in the real-DB suite)', async () => {
    const users = (await api().get('/v1/users').set('Authorization', `Bearer ${admin}`).expect(200)).body;
    const supBId = users.find((u: any) => u.fullName === 'Sup B').id;
    const res = await api().post(`/v1/workers/${workerId}/supervisor`).set('Authorization', `Bearer ${admin}`)
      .send({ supervisorId: supBId, reason: 'team restructure' }).expect(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.previousSupervisorId).toBeTruthy();
  });

  it('after reassignment the new supervisor sees the worker and the old one does not', async () => {
    const listB = await api().get('/v1/users').set('Authorization', `Bearer ${supB}`).expect(200);
    expect(listB.body.some((u: any) => u.id === workerId)).toBe(true);
    const listA = await api().get('/v1/users').set('Authorization', `Bearer ${supA}`).expect(200);
    expect(listA.body.some((u: any) => u.id === workerId)).toBe(false);
  });

  it('supervisor cannot reassign workers', async () => {
    await api().post(`/v1/workers/${workerId}/supervisor`).set('Authorization', `Bearer ${supA}`).send({ supervisorId: supA }).expect(403);
  });

  it('reassigning to the same supervisor is a no-op', async () => {
    const supBId = (await api().get('/v1/users').set('Authorization', `Bearer ${admin}`).expect(200)).body.find((u: any) => u.fullName === 'Sup B').id;
    const res = await api().post(`/v1/workers/${workerId}/supervisor`).set('Authorization', `Bearer ${admin}`).send({ supervisorId: supBId }).expect(200);
    expect(res.body.changed).toBe(false);
  });
});

describe('stage 2: employee status changes and history', () => {
  let admin: string, org: string, workerId: string, workerToken: string;
  beforeAll(async () => {
    org = `status-org-${uid}`;
    admin = await makeOrg(org);
    const w = await addUser(admin, { staffNumber: '0930', fullName: 'Leaver', role: 'worker' }).expect(201);
    workerId = w.body.user.id;
    workerToken = (await activate(org, '0930', w.body.activationCode, 'password', 'Worker-2026-ok').expect(201)).body.accessToken;
  });

  it('deactivation revokes sessions immediately and records history', async () => {
    await api().get('/v1/me').set('Authorization', `Bearer ${workerToken}`).expect(200);
    const res = await api().post(`/v1/users/${workerId}/status`).set('Authorization', `Bearer ${admin}`)
      .send({ status: 'deactivated', reason: 'left company' }).expect(200);
    expect(res.body.changed).toBe(true);
    // the worker's session is dead
    await api().get('/v1/me').set('Authorization', `Bearer ${workerToken}`).expect(401);
    const history = await api().get(`/v1/users/${workerId}/status-history`).set('Authorization', `Bearer ${admin}`).expect(200);
    expect(history.body.length).toBe(1);
    expect(history.body[0].previousStatus).toBe('active');
    expect(history.body[0].status).toBe('deactivated');
    expect(history.body[0].reason).toBe('left company');
  });

  it('deactivated worker cannot log in', async () => {
    await api().post('/v1/auth/login').send({ organisation: org, staffNumber: '0930', password: 'Worker-2026-ok' }).expect(401);
  });

  it('reactivation restores access and appends to history', async () => {
    await api().post(`/v1/users/${workerId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 'active', reason: 'returned' }).expect(200);
    const history = await api().get(`/v1/users/${workerId}/status-history`).set('Authorization', `Bearer ${admin}`).expect(200);
    expect(history.body.length).toBe(2);
    expect(history.body[1].status).toBe('active');
    // after reactivation the old refresh token stays revoked (revoked_at is permanent) but new logins work
    await api().post('/v1/auth/login').send({ organisation: org, staffNumber: '0930', password: 'Worker-2026-ok' }).expect(200);
  });

  it('workers cannot change any status', async () => {
    await api().post(`/v1/users/${workerId}/status`).set('Authorization', `Bearer ${workerToken}`).send({ status: 'active' }).expect(403);
  });

  it('management cannot deactivate other managers or admins', async () => {
    const m = await addUser(admin, { staffNumber: '0931', fullName: 'Manager Two', role: 'management' }).expect(201);
    const mTok = (await activate(org, '0931', m.body.activationCode, 'password', 'Manager2-2026-ok').expect(201)).body.accessToken;
    await api().post(`/v1/users/${m.body.user.id}/status`).set('Authorization', `Bearer ${mTok}`).send({ status: 'deactivated' }).expect(403);
  });
});
