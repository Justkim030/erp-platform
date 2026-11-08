import 'reflect-metadata';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { JWKS } from '../src/auth';
import { AppModule } from '../src/app.module';
import { CONFIG, config } from '../src/config';
import { Db, PG_POOL } from '../src/db';
import { configureApp } from '../src/setup';
import { ClockPasskeyVerifier } from '../src/passkeys';
import { Member, RetentionService, Roster } from '../src/support';
import { haversine, isLate } from '../src/verification';

class TestRoster extends Roster {
  teams = new Map<string, Member[]>();
  async members(user: any) { return this.teams.get(user.sub) ?? []; }
}
class TestClockPasskeyVerifier extends ClockPasskeyVerifier {
  protectedUsers = new Set<string>();
  async consume(user: any, proof?: string) {
    if (this.protectedUsers.has(user.sub) && proof !== 'verified-test-passkey-proof-123') {
      throw new ForbiddenException('Confirm this clock-in with your registered passkey.');
    }
  }
}
const roster = new TestRoster();
const passkeyVerifier = new TestClockPasskeyVerifier();
let app: INestApplication;
let sign: (role: string, sub: string, tid?: string) => Promise<string>;

const api = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const CENTER = { lat: -0.5388, lng: 37.4596 };
const reading = (o: Partial<{ lat: number; lng: number; accuracy: number }> = {}) => ({ ...CENTER, accuracy: 15, capturedAt: new Date().toISOString(), ...o });
const jitter = (i: number) => ({ lat: CENTER.lat + i * 1e-5, lng: CENTER.lng + i * 1e-5 });
const member = (id: string, n: string, role = 'worker'): Member => ({ id, staffNumber: n, fullName: `Person ${n}`, role, status: 'active', supervisorId: null });
const siteBody = (o: object = {}) => ({ name: 'Main Gate', ...CENTER, radiusM: 150, ...o });
async function submitSimpleReport(token: string, description: string, sessionId?: string) {
  const activeSessionId = sessionId ?? (await api().get('/v1/attendance/state').set(auth(token)).expect(200)).body.sessionId;
  const report = await api().post('/v1/work-reports').set(auth(token)).send({
    sessionId: activeSessionId, activities: [{ description, status: 'completed' }],
  }).expect(201);
  await api().post(`/v1/work-reports/${report.body.id}/submit`).set(auth(token)).send({}).expect(200);
}

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
    .overrideProvider(ClockPasskeyVerifier).useValue(passkeyVerifier)
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
    expect(forMgr[0]).toMatchObject({ radiusM: 150, allowedIps: [], requireNetwork: false });
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
  it('requires a one-use passkey proof for enrolled workers before recording clock-in', async () => {
    const workerId = 'user-worker-passkey-required';
    const token = await sign('worker', workerId);
    passkeyVerifier.protectedUsers.add(workerId);
    await api().post('/v1/attendance/clock-in').set(auth(token)).send({ reading: reading() }).expect(403);
    expect((await api().get('/v1/attendance/state').set(auth(token))).body.state).toBe('out');
    await api().post('/v1/attendance/clock-in').set(auth(token))
      .send({ reading: reading(), passkeyProof: 'verified-test-passkey-proof-123' }).expect(201);
    passkeyVerifier.protectedUsers.delete(workerId);
  });
  it('keeps an open session clocked in even when a later event says out', async () => {
    const tenant = 'tenant-open-session-state', workerId = 'user-worker-open-session-state';
    const token = await sign('worker', workerId, tenant);
    const site = (await api().post('/v1/sites').set(auth(await sign('management', 'user-manager-open-session-state', tenant))).send(siteBody()).expect(201)).body;
    const clockIn = await api().post('/v1/attendance/clock-in').set(auth(token)).send({ siteId: site.id, reading: reading() }).expect(201);
    await app.get(Db).query(
      `INSERT INTO attendance_events (id,tenant_id,user_id,site_id,kind,occurred_at,outcome,reasons,session_id)
       VALUES ($1,$2,$3,$4,'out',$5,'accepted','[]',NULL)`,
      ['stale-out-open-session', tenant, workerId, site.id, new Date(Date.now() + 1000)]);
    const state = (await api().get('/v1/attendance/state').set(auth(token)).expect(200)).body;
    expect(state).toMatchObject({ state: 'in', sessionId: clockIn.body.sessionId, siteId: site.id });
    await api().post('/v1/attendance/clock-in').set(auth(token)).send({ siteId: site.id, reading: reading(jitter(1)) }).expect(409);
  });
  it('allows clock-out without a task or report, then accepts the end-of-shift report', async () => {
    const sessionId = (await api().get('/v1/attendance/state').set(auth(w)).expect(200)).body.sessionId;
    const r = await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: reading(jitter(2)) }).expect(201);
    expect(r.body.outcome).toBe('accepted');
    expect(r.body.message).toContain('attendance has been recorded');
    await submitSimpleReport(w, 'Packed 40 crates and loaded the afternoon delivery.', sessionId);
    await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: reading(jitter(3)), workSummary: 'Second report that should not be accepted.' }).expect(409);
  });
  it('pairs clock-in and clock-out in the history with the work done', async () => {
    const h = (await api().get('/v1/attendance/history').set(auth(w)).expect(200)).body;
    expect(h).toHaveLength(1);
    expect(h[0].clockOut.workSummary).toBe('');
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
    await api().post('/v1/attendance/clock-out').set(auth(w)).send({ siteId: a.id, reading: reading(jitter(1)) }).expect(201);
    const r = await api().post('/v1/attendance/clock-in').set(auth(w)).send({ siteId: b.id, reading: { lat: -4.0435, lng: 39.6682, accuracy: 20, capturedAt: new Date().toISOString() } }).expect(201);
    expect(r.body.outcome).toBe('review');
    const pending = (await api().get('/v1/team/reviews').set(auth(sup)).expect(200)).body;
    expect(pending[0].reasons).toContain('impossible_travel');
  });
  it('flags identical coordinates repeated across events', async () => {
    const w = await sign('worker', 'user-worker-t3b', 'tenant-c'), sup = await sign('supervisor', 'user-super-t3b', 'tenant-c');
    roster.teams.set('user-super-t3b', [member('user-worker-t3b', '3002')]);
    const same = reading(CENTER);
    await api().post('/v1/attendance/clock-in').set(auth(w)).send({ reading: same }).expect(201);
    await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: same }).expect(201);
    await api().post('/v1/attendance/clock-in').set(auth(w)).send({ reading: same }).expect(201);
    const r = await api().post('/v1/attendance/clock-out').set(auth(w)).send({ reading: same }).expect(201);
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
  it('limits supervisor reviews to assigned workers while management can review organisation-wide', async () => {
    const workerId = 'user-worker-unassigned-review';
    const unassignedWorker = await sign('worker', workerId, 'tenant-d');
    const managerId = 'user-manager-review-view';
    const manager = await sign('management', managerId, 'tenant-d');
    roster.teams.set(managerId, [
      member(sup, '4000', 'supervisor'),
      member('user-worker-v1', '4001'),
      member('user-worker-v2', '4002'),
      member(workerId, '4004'),
    ]);
    await api().post('/v1/attendance/clock-in').set(auth(unassignedWorker)).send({ reading: reading({ accuracy: 500 }) }).expect(201);

    const supervisorQueue = (await api().get('/v1/team/reviews').set(auth(supTok)).expect(200)).body;
    expect(supervisorQueue.map((item: any) => item.userId)).toEqual(['user-worker-v2']);
    const managementQueue = (await api().get('/v1/team/reviews').set(auth(manager)).expect(200)).body;
    expect(managementQueue.map((item: any) => item.userId).sort()).toEqual(['user-worker-unassigned-review', 'user-worker-v2']);
    const unassignedReview = managementQueue.find((item: any) => item.userId === workerId);
    await api().post(`/v1/attendance/events/${unassignedReview.id}/review`).set(auth(supTok)).send({ decision: 'approved' }).expect(404);
    await api().post(`/v1/attendance/events/${unassignedReview.id}/review`).set(auth(manager)).send({ decision: 'approved' }).expect(200);
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

describe('attendance exceptions and physical verification', () => {
  it('lets a worker request and receive an audited missed-clock-out correction', async () => {
    const tenant = 'tenant-exception', workerId = 'user-worker-exception', supervisorId = 'user-super-exception';
    const manager = await sign('management', 'user-manager-exception', tenant);
    const worker = await sign('worker', workerId, tenant);
    const supervisor = await sign('supervisor', supervisorId, tenant);
    roster.teams.set(supervisorId, [member(workerId, 'EX-1')]);
    await api().post('/v1/sites').set(auth(manager)).send(siteBody()).expect(201);
    const clockIn = await api().post('/v1/attendance/clock-in').set(auth(worker)).send({ reading: reading() }).expect(201);
    const requestBody = {
      type: 'missed_clock_out',
      occurredAt: new Date().toISOString(),
      reason: 'The phone battery died before I could clock out.',
      workSummary: 'Completed the scheduled stock count and secured the storeroom.',
    };
    const created = await api().post('/v1/attendance/exceptions').set(auth(worker)).send(requestBody).expect(201);
    expect(created.body).toMatchObject({ status: 'pending', sessionId: clockIn.body.sessionId });
    expect((await api().get('/v1/attendance/exceptions?status=pending').set(auth(worker)).expect(200)).body).toHaveLength(1);
    expect((await api().get('/v1/team/attendance/exceptions?status=pending').set(auth(supervisor)).expect(200)).body[0].worker_id).toBe(workerId);

    await api().post(`/v1/team/attendance/exceptions/${created.body.id}/review`).set(auth(supervisor))
      .send({ decision: 'approved', note: 'Confirmed with the site lead.' }).expect(200);
    expect((await api().get('/v1/attendance/state').set(auth(worker)).expect(200)).body.state).toBe('out');
    const history = (await api().get('/v1/attendance/history').set(auth(worker)).expect(200)).body;
    expect(history[0].clockOut.workSummary).toContain('Completed the scheduled stock count');
    const audit = await app.get(Db).query(
      `SELECT * FROM audit_events WHERE action='attendance.exception_reviewed' AND target=$1`, [created.body.id]);
    expect(audit).toHaveLength(1);
  });

  it('records issue-triggered physical checks per session and prevents self-verification', async () => {
    const tenant = 'tenant-physical', workerId = 'user-worker-physical', supervisorId = 'user-super-physical';
    const manager = await sign('management', 'user-manager-physical', tenant);
    const worker = await sign('worker', workerId, tenant);
    const supervisor = await sign('supervisor', supervisorId, tenant);
    roster.teams.set(supervisorId, [member(workerId, 'PV-1')]);
    const site = (await api().post('/v1/sites').set(auth(manager)).send(siteBody()).expect(201)).body;
    const clockIn = await api().post('/v1/attendance/clock-in').set(auth(worker))
      .send({ reading: reading({ accuracy: 500 }) }).expect(201);
    expect(clockIn.body.outcome).toBe('review');
    await api().post(`/v1/attendance/sessions/${clockIn.body.sessionId}/verifications`).set(auth(worker))
      .send({ eventId: clockIn.body.id, outcome: 'confirmed' }).expect(403);
    const saved = await api().post(`/v1/attendance/sessions/${clockIn.body.sessionId}/verifications`).set(auth(supervisor))
      .send({ eventId: clockIn.body.id, outcome: 'confirmed', note: 'Observed at the loading bay.' }).expect(201);
    expect(saved.body).toMatchObject({ workerId, outcome: 'confirmed' });
    const records = (await api().get(`/v1/attendance/sessions/${clockIn.body.sessionId}/verifications`).set(auth(worker)).expect(200)).body;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ supervisorId, outcome: 'confirmed', method: 'in_person' });
    await api().post(`/v1/attendance/sessions/${clockIn.body.sessionId}/verifications`).set(auth(supervisor))
      .send({ eventId: clockIn.body.id, outcome: 'not_found' }).expect(201);
    expect((await api().get(`/v1/attendance/sessions/${clockIn.body.sessionId}/verifications`).set(auth(worker))).body).toHaveLength(2);
    expect((await api().get('/v1/sites').set(auth(manager))).body[0].id).toBe(site.id);
  });

  it('can verify a declined issue without inventing a session and flags not-found for management', async () => {
    const tenant = 'tenant-issue-verification', workerId = 'user-worker-issue-verification';
    const manager = await sign('management', 'user-manager-issue-verification', tenant);
    const worker = await sign('worker', workerId, tenant);
    const supervisorId = 'user-super-issue-verification';
    const supervisor = await sign('supervisor', supervisorId, tenant);
    roster.teams.set(supervisorId, [member(workerId, 'PV-2')]);
    await api().post('/v1/sites').set(auth(manager)).send(siteBody()).expect(201);
    const declined = await api().post('/v1/attendance/clock-in').set(auth(worker))
      .send({ reading: reading({ lat: CENTER.lat + 0.009 }) }).expect(201);
    expect(declined.body.outcome).toBe('declined');
    expect((await api().get('/v1/attendance/state').set(auth(worker))).body.state).toBe('out');
    const issue = (await api().get('/v1/attendance/issues').set(auth(worker)).expect(200)).body[0];
    const exception = await api().post('/v1/attendance/exceptions').set(auth(worker)).send({
      type: 'location_issue', eventId: issue.id, occurredAt: issue.at,
      reason: 'My device location was inaccurate at the site gate.',
    }).expect(201);
    await api().post(`/v1/attendance/exceptions/${exception.body.id}/verifications`).set(auth(supervisor))
      .send({ outcome: 'not_found', note: 'Worker was not at the reported site.' }).expect(201);
    expect((await api().get('/v1/attendance/state').set(auth(worker))).body.state).toBe('out');
    const checks = (await api().get(`/v1/attendance/exceptions/${exception.body.id}/verifications`).set(auth(worker)).expect(200)).body;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ sessionId: null, outcome: 'not_found' });
    const flagged = (await api().get('/v1/team/attendance/physical-verification-issues').set(auth(manager)).expect(200)).body;
    expect(flagged[0]).toMatchObject({ workerId, exceptionType: 'location_issue' });
    await api().get('/v1/team/attendance/physical-verification-issues').set(auth(supervisor)).expect(403);
  });
});

describe('daily work reports and management insights', () => {
  it('saves revisions, routes clarification, and limits insights and exports to management', async () => {
    const tenant = 'tenant-reports', workerId = 'user-worker-reports', supervisorId = 'user-super-reports';
    const managerId = 'user-manager-reports';
    const manager = await sign('management', managerId, tenant);
    const worker = await sign('worker', workerId, tenant);
    const supervisor = await sign('supervisor', supervisorId, tenant);
    roster.teams.set(supervisorId, [member(workerId, 'WR-1')]);
    roster.teams.set(managerId, [member(workerId, 'WR-1')]);
    await api().post('/v1/sites').set(auth(manager)).send(siteBody()).expect(201);
    const clockIn = await api().post('/v1/attendance/clock-in').set(auth(worker)).send({ reading: reading() }).expect(201);
    const reportBody = {
      sessionId: clockIn.body.sessionId,
      activities: [{ description: 'Packed 24 produce boxes', status: 'completed', quantity: 24, unit: 'boxes' }],
    };
    await api().post('/v1/work-reports').set(auth(worker)).send(reportBody).expect(409);
    await api().post('/v1/attendance/clock-out').set(auth(worker)).send({ reading: reading() }).expect(201);
    const report = await api().post('/v1/work-reports').set(auth(worker)).send(reportBody).expect(201);
    expect(report.body).toMatchObject({ status: 'draft', workerId });
    expect(report.body.activities).toHaveLength(1);
    expect(report.body.revisions).toHaveLength(1);
    await api().post(`/v1/work-reports/${report.body.id}/submit`).set(auth(worker)).send({}).expect(200);
    await api().post(`/v1/work-reports/${report.body.id}/review`).set(auth(supervisor))
      .send({ decision: 'clarification', note: 'Please include the delivery destination.' }).expect(200);
    const revised = await api().put(`/v1/work-reports/${report.body.id}`).set(auth(worker)).send({
      ...reportBody,
      activities: [{ ...reportBody.activities[0], notes: '=SUM(1,1)' }],
    }).expect(200);
    expect(revised.body.status).toBe('draft');
    expect(revised.body.revisions).toHaveLength(2);
    await api().post(`/v1/work-reports/${report.body.id}/submit`).set(auth(worker)).send({}).expect(200);
    await api().post(`/v1/work-reports/${report.body.id}/review`).set(auth(supervisor))
      .send({ decision: 'acknowledged', note: 'Reviewed.' }).expect(200);
    expect((await api().get('/v1/work-reports?status=acknowledged').set(auth(supervisor)).expect(200)).body).toHaveLength(1);
    await api().get('/v1/management/insights').set(auth(supervisor)).expect(403);
    const insights = await api().get('/v1/management/insights').set(auth(manager)).expect(200);
    expect(insights.body.reports.total).toBe(1);
    expect(insights.body.activities[0]).toMatchObject({ status: 'completed', unit: 'boxes', count: 1 });
    const exported = await api().get('/v1/management/reports/export.csv').set(auth(manager)).expect(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toContain('attachment;');
    expect(exported.text).toContain('Packed 24 produce boxes');
    expect(exported.text).toContain('boxes');
    expect(exported.text).toContain("'=SUM(1,1)");
    await api().get(`/v1/work-reports/${report.body.id}`).set(auth(await sign('worker', 'user-worker-stranger-reports', tenant))).expect(404);
  });
});

describe('assigned tasks and progress', () => {
  it('scopes tasks, records status history, and links report activities', async () => {
    const tenant = 'tenant-tasks', workerId = 'user-worker-tasks', managerId = 'user-manager-tasks', supervisorId = 'user-super-tasks';
    const manager = await sign('management', managerId, tenant);
    const worker = await sign('worker', workerId, tenant);
    const supervisor = await sign('supervisor', supervisorId, tenant);
    const workerMember = member(workerId, 'TK-1');
    roster.teams.set(managerId, [workerMember]);
    roster.teams.set(supervisorId, [workerMember]);
    await api().post('/v1/sites').set(auth(manager)).send(siteBody()).expect(201);
    const task = await api().post('/v1/tasks').set(auth(manager)).send({
      title: 'Count returned inventory', description: 'Record quantities and report damaged stock.',
      priority: 'high', assignedTo: workerId,
    }).expect(201);
    expect(task.body).toMatchObject({ title: 'Count returned inventory', assigned_to: workerId, status: 'assigned' });
    await api().post('/v1/tasks').set(auth(manager)).send({
      title: 'Bad date task', assignedTo: workerId, dueDate: '2025-02-31',
    }).expect(400);
    expect((await api().get('/v1/tasks').set(auth(worker)).expect(200)).body).toHaveLength(1);
    await api().post(`/v1/tasks/${task.body.id}/progress`).set(auth(worker)).send({ status: 'in_progress', note: 'Started at the returns bay.' }).expect(200);
    await api().post(`/v1/tasks/${task.body.id}/progress`).set(auth(worker)).send({ status: 'completed', note: 'Count completed.' }).expect(200);
    await api().post(`/v1/tasks/${task.body.id}/progress`).set(auth(worker)).send({ status: 'in_progress' }).expect(409);
    await api().get(`/v1/tasks/${task.body.id}`).set(auth(await sign('supervisor', 'user-super-outsider-tasks', tenant))).expect(404);
    const detail = await api().get(`/v1/tasks/${task.body.id}`).set(auth(manager)).expect(200);
    expect(detail.body.progress.map((entry: any) => entry.status)).toEqual(['assigned', 'in_progress', 'completed']);

    const clockIn = await api().post('/v1/attendance/clock-in').set(auth(worker)).send({ reading: reading() }).expect(201);
    await api().post('/v1/attendance/clock-out').set(auth(worker)).send({ reading: reading() }).expect(201);
    const report = await api().post('/v1/work-reports').set(auth(worker)).send({
      sessionId: clockIn.body.sessionId,
      activities: [{ description: 'Counted 12 returned cartons', status: 'completed', taskId: task.body.id }],
    }).expect(201);
    expect(report.body.activities[0]).toMatchObject({ taskId: task.body.id, taskTitle: 'Count returned inventory' });
    await api().get('/v1/management/insights').set(auth(supervisor)).expect(403);
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
  it('reports liveness and returns correlated API errors', async () => {
    await api().get('/healthz').expect(200, { status: 'ok' });
    const response = await api().get('/v1/attendance/state').set('x-correlation-id', 'attendance-test-123').expect(401);
    expect(response.headers['x-correlation-id']).toBe('attendance-test-123');
    expect(response.body.correlationId).toBe('attendance-test-123');
  });
  it('reports ready only when the database and identity JWKS are available', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    try { await api().get('/readyz').expect(200, { status: 'ready' }); }
    finally { fetch.mockRestore(); }
  });
});
