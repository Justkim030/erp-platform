import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { JWKS } from '../src/auth';
import { AppModule } from '../src/app.module';
import { CONFIG, config } from '../src/config';
import { Db, PG_POOL } from '../src/db';
import { configureApp } from '../src/setup';
import { Member, RetentionService, Roster } from '../src/support';
import { haversine, isLate } from '../src/verification';

class TestRoster extends Roster {
  teams = new Map<string, Member[]>();
  async members(user: any) { return this.teams.get(user.sub) ?? []; }
}
const roster = new TestRoster();
let app: INestApplication;
let sign: (role: string, sub: string, tid?: string) => Promise<string>;

const api = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const CENTER = { lat: -0.5388, lng: 37.4596 };
const reading = (o: Partial<{ lat: number; lng: number; accuracy: number }> = {}) => ({ ...CENTER, accuracy: 15, capturedAt: new Date().toISOString(), ...o });
const jitter = (i: number) => ({ lat: CENTER.lat + i * 1e-5, lng: CENTER.lng + i * 1e-5 });
const member = (id: string, n: string, role = 'worker'): Member => ({ id, staffNumber: n, fullName: `Person ${n}`, role, status: 'active', supervisorId: null });
const siteBody = (o: object = {}) => ({ name: 'Main Gate', ...CENTER, radiusM: 150, ...o });

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
  sign = (role, sub, tid = 'tenant-a') =>
    new SignJWT({ tid, role }).setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setSubject(sub).setIssuer('platform-identity').setAudience('platform').setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const pool = new (newDb().adapters.createPg().Pool)();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool)
    .overrideProvider(CONFIG).useValue({ ...config(), purgeIntervalMs: 0 })
    .overrideProvider(JWKS).useValue(createLocalJWKSet({ keys: [pub] }))
    .overrideProvider(Roster).useValue(roster)
    .compile();
  app = mod.createNestApplication();
  configureApp(app, config() as any);
  await app.init();
});
afterAll(async () => { await app.close(); });

describe('pure rules', () => {
  it('measures distance', () => { expect(Math.round(haversine(0, 0, 1, 0) / 1000)).toBe(111); });
  it('judges lateness in the site time zone', () => {
    const site = { timezone: 'Africa/Nairobi', shift_start: '08:00', grace_minutes: 10 };
    expect(isLate(site, new Date('2026-10-16T05:05:00Z'))).toBe(false); // 08:05 in Nairobi
    expect(isLate(site, new Date('2026-10-16T05:15:00Z'))).toBe(true);  // 08:15
  });
});

describe('authentication', () => {
  it('rejects missing or foreign tokens', async () => {
    await api().get('/v1/attendance/state').expect(401);
    await api().get('/v1/attendance/state').set(auth('not-a-token')).expect(401);
  });
});

describe('sites', () => {
  it('lets management configure, and workers see names only', async () => {
    const mgr = await sign('management', 'user-manager-1'), w = await sign('worker', 'user-worker-aaa');
    await api().post('/v1/sites').set(auth(w)).send(siteBody()).expect(403);
    await api().post('/v1/sites').set(auth(mgr)).send(siteBody({ radiusM: 5 })).expect(400);
    await api().post('/v1/sites').set(auth(mgr)).send(siteBody()).expect(201);
    const forWorker = (await api().get('/v1/sites').set(auth(w)).expect(200)).body;
    expect(forWorker[0]).toEqual({ id: expect.any(String), name: 'Main Gate' });
    const forMgr = (await api().get('/v1/sites').set(auth(mgr)).expect(200)).body;
    expect(forMgr[0].radiusM).toBe(150);
  });
});

describe('clocking in and out', () => {
  let w: string;
  beforeAll(async () => { w = await sign('worker', 'user-worker-clock'); });

  it('accepts a reading inside the site and blocks a second clock-in', async () => {
    const r = await api().post('/v1/attendance/clock-in').set(auth(w)).send({ reading: reading() }).expect(201);
    expect(r.body.outcome).toBe('accepted');
    expect(r.body.message).toMatch(/^Clocked in at \d\d:\d\d\.$/);
    expect(r.body).not.toHaveProperty('reasons');
    await api().post('/v1/attendance/clock-in').set(auth(w)).send({ reading: reading(jitter(1)) }).expect(409);
    expect((await api().get('/v1/attendance/state').set(auth(w))).body.state).toBe('in');
  });
  it('requires a work report to clock out', async () => {
    await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: reading(jitter(2)) }).expect(400);
    await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: reading(jitter(2)), workSummary: 'short' }).expect(400);
    const r = await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: reading(jitter(2)), workSummary: 'Packed 40 crates and loaded the afternoon delivery.' }).expect(201);
    expect(r.body.outcome).toBe('accepted');
    expect(r.body.message).toContain('work report');
    await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: reading(jitter(3)), workSummary: 'Second report that should not be accepted.' }).expect(409);
  });
  it('pairs clock-in and clock-out in the history with the work done', async () => {
    const h = (await api().get('/v1/attendance/history').set(auth(w)).expect(200)).body;
    expect(h).toHaveLength(1);
    expect(h[0].clockOut.workSummary).toContain('Packed 40 crates');
    expect(h[0].minutes).toBeGreaterThanOrEqual(0);
    expect((await api().get('/v1/attendance/state').set(auth(w))).body.state).toBe('out');
  });
  it('declines a reading clearly outside, keeps the worker clocked out, and allows a review request', async () => {
    const w2 = await sign('worker', 'user-worker-far');
    const far = reading({ lat: CENTER.lat + 0.009 }); // about 1 km north
    const d = await api().post('/v1/attendance/clock-in').set(auth(w2)).send({ reading: far }).expect(201);
    expect(d.body.outcome).toBe('declined');
    expect(d.body.message).toMatch(/about (9|10)\d\d m|about 1\.0 km|about 1 km/);
    expect((await api().get('/v1/attendance/state').set(auth(w2))).body.state).toBe('out');
    const rr = await api().post('/v1/attendance/clock-in').set(auth(w2)).send({ reading: far, requestReview: true }).expect(201);
    expect(rr.body.outcome).toBe('review');
    expect((await api().get('/v1/attendance/state').set(auth(w2))).body.state).toBe('in');
  });
  it('sends uncertain readings to review instead of declining honest workers', async () => {
    const a = await sign('worker', 'user-worker-acc'), b = await sign('worker', 'user-worker-edge');
    expect((await api().post('/v1/attendance/clock-in').set(auth(a)).send({ reading: reading({ accuracy: 400 }) }).expect(201)).body.outcome).toBe('review');
    // about 200 m from centre with 90 m accuracy: the uncertainty circle reaches inside the 150 m boundary
    expect((await api().post('/v1/attendance/clock-in').set(auth(b)).send({ reading: reading({ lat: CENTER.lat + 0.0018, accuracy: 90 }) }).expect(201)).body.outcome).toBe('review');
  });
  it('declines when location is missing and flags stale readings', async () => {
    const a = await sign('worker', 'user-worker-noloc'), b = await sign('worker', 'user-worker-stale');
    const d = await api().post('/v1/attendance/clock-in').set(auth(a)).send({}).expect(201);
    expect(d.body.outcome).toBe('declined');
    expect(d.body.message).toMatch(/location/i);
    const stale = { ...reading(), capturedAt: new Date(Date.now() - 10 * 60_000).toISOString() };
    expect((await api().post('/v1/attendance/clock-in').set(auth(b)).send({ reading: stale }).expect(201)).body.outcome).toBe('review');
  });
  it('validates input', async () => {
    const a = await sign('worker', 'user-worker-bad');
    await api().post('/v1/attendance/clock-in').set(auth(a)).send({ reading: { lat: 999, lng: 0, accuracy: 5 } }).expect(400);
    await api().post('/v1/attendance/clock-in').set(auth(a)).send({ reading: reading(), isAdmin: true }).expect(400);
  });
});

describe('network rule', () => {
  it('requires the staff network when the site says so', async () => {
    const mgr = await sign('management', 'user-manager-t2', 'tenant-b'), w = await sign('worker', 'user-worker-t2a', 'tenant-b');
    const site = (await api().post('/v1/sites').set(auth(mgr)).send(siteBody({ name: 'Eagle Depot', allowedIps: ['10.0.0.0/8'], requireNetwork: true })).expect(201)).body;
    const d = await api().post('/v1/attendance/clock-in').set(auth(w)).send({ reading: reading() }).expect(201);
    expect(d.body.outcome).toBe('declined');
    expect(d.body.message).toContain('staff network');
    await api().put(`/v1/sites/${site.id}`).set(auth(mgr)).send(siteBody({ name: 'Eagle Depot', allowedIps: ['127.0.0.1/32'], requireNetwork: true })).expect(200);
    const ok = await api().post('/v1/attendance/clock-in').set(auth(w)).send({ reading: reading(jitter(1)) }).expect(201);
    expect(ok.body.outcome).toBe('accepted');
  });
});

describe('suspicious patterns go to a human', () => {
  it('flags impossible travel between sites', async () => {
    const mgr = await sign('management', 'user-manager-t3', 'tenant-c'), w = await sign('worker', 'user-worker-t3a', 'tenant-c'), sup = await sign('supervisor', 'user-super-t3', 'tenant-c');
    roster.teams.set('user-super-t3', [member('user-worker-t3a', '3001')]);
    const a = (await api().post('/v1/sites').set(auth(mgr)).send(siteBody({ name: 'Embu' })).expect(201)).body;
    const b = (await api().post('/v1/sites').set(auth(mgr)).send(siteBody({ name: 'Mombasa', lat: -4.0435, lng: 39.6682 })).expect(201)).body;
    await api().post('/v1/attendance/clock-in').set(auth(w)).send({ siteId: a.id, reading: reading() }).expect(201);
    await api().post('/v1/attendance/clock-out').set(auth(w)).send({ siteId: a.id, reading: reading(jitter(1)), workSummary: 'Finished the morning inventory count.' }).expect(201);
    const r = await api().post('/v1/attendance/clock-in').set(auth(w)).send({ siteId: b.id, reading: { lat: -4.0435, lng: 39.6682, accuracy: 20, capturedAt: new Date().toISOString() } }).expect(201);
    expect(r.body.outcome).toBe('review');
    const pending = (await api().get('/v1/team/reviews').set(auth(sup)).expect(200)).body;
    expect(pending[0].reasons).toContain('impossible_travel');
  });
  it('flags identical coordinates repeated across events', async () => {
    const w = await sign('worker', 'user-worker-t3b', 'tenant-c'), sup = await sign('supervisor', 'user-super-t3b', 'tenant-c');
    roster.teams.set('user-super-t3b', [member('user-worker-t3b', '3002')]);
    const same = reading(CENTER);
    for (const kind of ['in', 'out', 'in']) {
      await api().post(`/v1/attendance/clock-${kind}`).set(auth(w)).send(kind === 'in' ? { reading: same } : { reading: same, workSummary: 'Routine work, nothing unusual to report.' }).expect(201);
    }
    const r = await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: same, workSummary: 'Routine work, nothing unusual to report.' }).expect(201);
    expect(r.body.outcome).toBe('review');
    expect((await api().get('/v1/team/reviews').set(auth(sup))).body[0].reasons).toContain('identical_coordinates');
  });
});

describe('supervisor view, map and review', () => {
  const sup = 'user-super-view';
  let supTok: string, w1: string, w2: string;
  beforeAll(async () => {
    supTok = await sign('supervisor', sup, 'tenant-d');
    w1 = await sign('worker', 'user-worker-v1', 'tenant-d');
    w2 = await sign('worker', 'user-worker-v2', 'tenant-d');
    roster.teams.set(sup, [member('user-worker-v1', '4001'), member('user-worker-v2', '4002')]);
    await api().post('/v1/sites').set(auth(await sign('admin', 'user-admin-d', 'tenant-d'))).send(siteBody()).expect(201);
    await api().post('/v1/attendance/clock-in').set(auth(w1)).send({ reading: reading() }).expect(201);
    await api().post('/v1/attendance/clock-in').set(auth(w2)).send({ reading: reading({ accuracy: 500 }) }).expect(201); // goes to review
  });
  it('shows who is present, absent or needs review', async () => {
    const b = (await api().get('/v1/team/attendance').set(auth(supTok)).expect(200)).body;
    expect(b.summary).toMatchObject({ total: 2, present: 2, absent: 0, review: 1 });
    roster.teams.set(sup, [...roster.teams.get(sup)!, member('user-worker-v3', '4003')]);
    const b2 = (await api().get('/v1/team/attendance').set(auth(supTok))).body;
    expect(b2.summary).toMatchObject({ total: 3, absent: 1 });
    expect(b2.members.find((m: any) => m.staffNumber === '4003').status).toBe('absent');
    await api().get('/v1/team/attendance?date=not-a-date').set(auth(supTok)).expect(400);
  });
  it('pinpoints clock-in locations for the team only, and audits the view', async () => {
    const m = (await api().get('/v1/team/map').set(auth(supTok)).expect(200)).body;
    expect(m.points.map((p: any) => p.staffNumber).sort()).toEqual(['4001', '4002']);
    expect(m.points[0]).toMatchObject({ kind: 'in', lat: expect.any(Number), lng: expect.any(Number) });
    expect(m.sites[0].radiusM).toBe(150);
    const audit = await app.get(Db).query(`SELECT * FROM audit_events WHERE action='location.viewed' AND actor_id=$1`, [sup]);
    expect(audit.length).toBeGreaterThan(0);
    const stranger = await sign('supervisor', 'user-super-other', 'tenant-d');
    expect((await api().get('/v1/team/map').set(auth(stranger))).body.points).toHaveLength(0);
    await api().get('/v1/team/map').set(auth(w1)).expect(403);
  });
  it('lets a supervisor approve or decline entries, which changes the worker state', async () => {
    const pending = (await api().get('/v1/team/reviews').set(auth(supTok)).expect(200)).body;
    expect(pending).toHaveLength(1);
    expect(pending[0].reasons).toContain('low_accuracy');
    const stranger = await sign('supervisor', 'user-super-other', 'tenant-d');
    await api().post(`/v1/attendance/events/${pending[0].id}/review`).set(auth(stranger)).send({ decision: 'approved' }).expect(404);
    await api().post(`/v1/attendance/events/${pending[0].id}/review`).set(auth(supTok)).send({ decision: 'declined', note: 'Could not confirm.' }).expect(200);
    await api().post(`/v1/attendance/events/${pending[0].id}/review`).set(auth(supTok)).send({ decision: 'approved' }).expect(409);
    expect((await api().get('/v1/attendance/state').set(auth(w2))).body.state).toBe('out'); // declined on review
    expect((await api().get('/v1/team/reviews').set(auth(supTok))).body).toHaveLength(0);
  });
  it('keeps tenants apart', async () => {
    const other = await sign('worker', 'user-worker-v1', 'tenant-z');
    expect((await api().get('/v1/attendance/history').set(auth(other))).body).toHaveLength(0);
  });
});

describe('privacy retention', () => {
  it('erases exact coordinates after the retention period but keeps the record', async () => {
    const db = app.get(Db), sup = await sign('supervisor', 'user-super-view', 'tenant-d');
    await db.query(`UPDATE attendance_events SET occurred_at = $1 WHERE tenant_id='tenant-d' AND user_id='user-worker-v1'`, [new Date(Date.now() - 100 * 86_400_000)]);
    await app.get(RetentionService).purge();
    const row = (await db.query(`SELECT lat, lng, outcome FROM attendance_events WHERE user_id='user-worker-v1'`))[0];
    expect(row.lat).toBeNull();
    expect(row.outcome).toBe('accepted');
    const day = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    expect((await api().get(`/v1/team/map?date=${day}`).set(auth(sup))).body.points).toHaveLength(0);
  });
  it('reports health', async () => { await api().get('/health').expect(200); });
});
