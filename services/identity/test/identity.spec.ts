import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CONFIG, config } from '../src/config';
import { PG_POOL } from '../src/db';
import { ipInCidr } from '../src/net';
import { Notifier } from '../src/notifier';
import { configureApp } from '../src/setup';

class RecordingNotifier extends Notifier {
  sent: { template: string; data: Record<string, string> }[] = [];
  async send(_to: any, template: any, data: Record<string, string>) { this.sent.push({ template, data }); }
}

const BOOT = 'test-bootstrap-token';
const PASS = 'Correct-Horse-2026';
let app: INestApplication;
const notifier = new RecordingNotifier();
const api = () => request(app.getHttpServer());
const platform = (path: string, body: object, token = BOOT) => api().post(`/v1/platform${path}`).set('x-bootstrap-token', token).send(body);
const login = (org: string, staff: string, password: string) => api().post('/v1/auth/login').send({ organisation: org, staffNumber: staff, password });
const activate = (org: string, staffNumber: string, activationCode: string, credentialType: 'password' | 'pin', secret: string) =>
  api().post('/v1/auth/activate').send({ organisation: org, staffNumber, activationCode, credentialType, secret });
const addUser = (token: string, body: object) => api().post('/v1/users').set('Authorization', `Bearer ${token}`).send(body);

/** Creates an organisation and returns the administrator's access token after first sign-in. */
async function makeOrg(slug: string) {
  const org = await platform('/organisations', { name: `Org ${slug}`, slug, adminStaffNumber: '0001', adminName: 'Admin One' }).expect(201);
  const act = await activate(slug, '0001', org.body.activationCode, 'password', PASS).expect(201);
  return act.body.accessToken as string;
}
/** Creates and activates a user through the API; returns their access token. */
async function onboard(adminToken: string, org: string, body: any, type: 'password' | 'pin', secret: string) {
  const created = await addUser(adminToken, body).expect(201);
  const act = await activate(org, body.staffNumber, created.body.activationCode, type, secret).expect(201);
  return { token: act.body.accessToken as string, id: created.body.user.id as string };
}

beforeAll(async () => {
  const pool = new (newDb().adapters.createPg().Pool)();
  const cfg = { ...config(), bootstrapToken: BOOT, signingKeyJwk: undefined, lockoutThreshold: 3, env: 'test' };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool).overrideProvider(CONFIG).useValue(cfg).overrideProvider(Notifier).useValue(notifier).compile();
  app = mod.createNestApplication();
  configureApp(app, cfg);
  await app.init();
});
afterAll(async () => { await app.close(); });

describe('hidden platform endpoints', () => {
  it('answer 404 without the right token', async () => {
    await api().post('/v1/platform/organisations').send({ name: 'X Org', slug: 'xorg', adminStaffNumber: '1', adminName: 'Ad Min' }).expect(404);
    await platform('/organisations', { name: 'X Org', slug: 'xorg', adminStaffNumber: '1', adminName: 'Ad Min' }, 'wrong').expect(404);
  });
  it('create an organisation whose administrator sets their own password', async () => {
    const adminToken = await makeOrg('alpha');
    const me = await api().get('/v1/me').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(me.body.role).toBe('admin');
    expect(me.body.credentialType).toBe('password');
    await platform('/organisations', { name: 'Alpha again', slug: 'alpha', adminStaffNumber: '9', adminName: 'Other Admin' }).expect(409);
  });
  it('add real users to an organisation', async () => {
    const r = await platform('/organisations/alpha/users', { staffNumber: '0500', fullName: 'Achieng Odhiambo', role: 'management' }).expect(201);
    expect(r.body.activationCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    await platform('/organisations/nope/users', { staffNumber: '1', fullName: 'No One', role: 'worker' }).expect(404);
  });
  it('matches IP allowlists', () => {
    expect(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('192.168.1.5', '192.168.1.0/24')).toBe(true);
    expect(ipInCidr('192.168.2.5', '192.168.1.0/24')).toBe(false);
    expect(ipInCidr('41.90.1.1', '41.90.1.1')).toBe(true);
  });
});

describe('login basics', () => {
  it('gives the same error for a wrong secret and an unknown user', async () => {
    const a = await login('alpha', '0001', 'wrong-password-1').expect(401);
    const b = await login('alpha', 'nobody', 'wrong-password-1').expect(401);
    expect(a.body.message).toBe(b.body.message);
  });
  it('rejects unknown fields', async () => {
    await login('alpha', '0001', PASS).send({ organisation: 'alpha', staffNumber: '0001', password: PASS, extra: 1 }).expect(400);
  });
});

describe('supervisors add employees; first sign-in sets a hashed PIN or password', () => {
  let admin: string, sup: { token: string; id: string }, sup2: { token: string; id: string };
  beforeAll(async () => {
    admin = (await login('alpha', '0001', PASS)).body.accessToken;
    sup = await onboard(admin, 'alpha', { staffNumber: '0200', fullName: 'Otieno Kamau', role: 'supervisor' }, 'password', PASS);
    sup2 = await onboard(admin, 'alpha', { staffNumber: '0201', fullName: 'Grace Wanjiru', role: 'supervisor' }, 'password', PASS);
  });

  it('lets a supervisor add a worker, who then activates with a PIN once', async () => {
    const created = await addUser(sup.token, { staffNumber: '0457', fullName: 'Wanjiku Mwangi', role: 'worker', phone: '0712 345 678' }).expect(201);
    expect(created.body.user.supervisorId).toBe(sup.id);
    const code = created.body.activationCode;
    await login('alpha', '0457', '482915').expect(401); // cannot log in before activating
    const act = await activate('alpha', '0457', code.toLowerCase(), 'pin', '482915').expect(201);
    expect(act.body.user.credentialType).toBe('pin');
    await activate('alpha', '0457', code, 'pin', '715204').expect(400); // code is single use
    await login('alpha', '0457', '482915').expect(200); // afterwards it is just login
    await login('alpha', '0457', '000000').expect(401);
  });
  it('enforces PIN rules and keeps PINs to workers', async () => {
    const w = await addUser(sup.token, { staffNumber: '0458', fullName: 'Peter Njeru', role: 'worker' }).expect(201);
    for (const weak of ['123456', '111111', '121212', '12345', 'abcdef', '654321']) {
      await activate('alpha', '0458', w.body.activationCode, 'pin', weak).expect(400);
    }
    const s = await addUser(admin, { staffNumber: '0300', fullName: 'New Supervisor', role: 'supervisor' }).expect(201);
    await activate('alpha', '0300', s.body.activationCode, 'pin', '482915').expect(400);
    await activate('alpha', '0458', w.body.activationCode, 'pin', '837261').expect(201); // code survived the failed policy checks
  });
  it('blocks a code after five wrong guesses', async () => {
    const w = await addUser(sup.token, { staffNumber: '0459', fullName: 'Mary Wairimu', role: 'worker' }).expect(201);
    for (let i = 0; i < 5; i++) await activate('alpha', '0459', 'AAAAA-BBBBB', 'pin', '837261').expect(400);
    await activate('alpha', '0459', w.body.activationCode, 'pin', '837261').expect(400);
  });
  it('limits what a supervisor can do', async () => {
    await addUser(sup.token, { staffNumber: '0301', fullName: 'Sneaky Supervisor', role: 'supervisor' }).expect(403);
    await addUser(sup.token, { staffNumber: '0302', fullName: 'Sneaky Admin', role: 'admin' }).expect(403);
    await addUser(sup.token, { staffNumber: '0457', fullName: 'Duplicate', role: 'worker' }).expect(409);
    const mine = (await api().get('/v1/users').set('Authorization', `Bearer ${sup.token}`).expect(200)).body;
    expect(mine.map((u: any) => u.staffNumber).sort()).toEqual(['0457', '0458', '0459']);
    const theirs = (await api().get('/v1/users').set('Authorization', `Bearer ${sup2.token}`).expect(200)).body;
    expect(theirs).toHaveLength(0);
  });
  it('keeps workers out of user management', async () => {
    const w = (await login('alpha', '0457', '482915')).body.accessToken;
    await api().get('/v1/users').set('Authorization', `Bearer ${w}`).expect(403);
    await addUser(w, { staffNumber: '0999', fullName: 'Nope Nope', role: 'worker' }).expect(403);
  });
  it('resets access for a forgotten PIN, only for your own team', async () => {
    const list = (await api().get('/v1/users').set('Authorization', `Bearer ${sup.token}`)).body;
    const wanjiku = list.find((u: any) => u.staffNumber === '0457');
    const first = (await login('alpha', '0457', '482915')).body;
    await api().post(`/v1/users/${wanjiku.id}/reset-access`).set('Authorization', `Bearer ${sup2.token}`).expect(403);
    const reset = await api().post(`/v1/users/${wanjiku.id}/reset-access`).set('Authorization', `Bearer ${sup.token}`).expect(201);
    await login('alpha', '0457', '482915').expect(401);
    await api().post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await activate('alpha', '0457', reset.body.activationCode, 'pin', '906137').expect(201);
    await login('alpha', '0457', '906137').expect(200);
  });
});

describe('tokens', () => {
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const first = (await login('alpha', '0001', PASS)).body;
    const second = (await api().post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await api().post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await api().post('/v1/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
  });
  it('ends the session on logout', async () => {
    const s = (await login('alpha', '0001', PASS)).body;
    await api().post('/v1/auth/logout').send({ refreshToken: s.refreshToken }).expect(204);
    await api().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
  });
  it('publishes a key that verifies access tokens', async () => {
    const s = (await login('alpha', '0001', PASS)).body;
    const jwks = (await api().get('/.well-known/jwks.json').expect(200)).body;
    const { payload } = await jwtVerify(s.accessToken, createLocalJWKSet(jwks), { issuer: 'platform-identity', audience: 'platform' });
    expect(payload.role).toBe('admin');
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });
});

describe('lockout and password reset', () => {
  it('locks an account after repeated failures, even for the right secret', async () => {
    for (let i = 0; i < 3; i++) await login('alpha', '0200', 'wrong-password-1').expect(401);
    await login('alpha', '0200', PASS).expect(401);
  });
  it('resets a password with a single-use token and revokes old sessions', async () => {
    const before = (await login('alpha', '0001', PASS)).body;
    await api().post('/v1/auth/password/forgot').send({ organisation: 'alpha', staffNumber: '0001' }).expect(202);
    await api().post('/v1/auth/password/forgot').send({ organisation: 'alpha', staffNumber: 'ghost' }).expect(202);
    const token = notifier.sent.filter((n) => n.template === 'password-reset').pop()!.data.token;
    await api().post('/v1/auth/password/reset').send({ token, newPassword: 'Brand-New-Pass-77' }).expect(204);
    await api().post('/v1/auth/password/reset').send({ token, newPassword: 'Another-Pass-88' }).expect(400);
    await api().post('/v1/auth/refresh').send({ refreshToken: before.refreshToken }).expect(401);
    await login('alpha', '0001', PASS).expect(401);
    await login('alpha', '0001', 'Brand-New-Pass-77').expect(200);
  });
});

describe('tenant isolation', () => {
  it('keeps organisations separate', async () => {
    const b = await makeOrg('beta');
    const a = (await login('alpha', '0001', 'Brand-New-Pass-77')).body.accessToken;
    const lb = (await api().get('/v1/users').set('Authorization', `Bearer ${b}`)).body;
    const la = (await api().get('/v1/users').set('Authorization', `Bearer ${a}`)).body;
    expect(lb).toHaveLength(1);
    expect(la.length).toBeGreaterThan(3);
    await login('beta', '0457', '906137').expect(401);
    const alphaWorker = la.find((u: any) => u.staffNumber === '0457');
    await api().post(`/v1/users/${alphaWorker.id}/reset-access`).set('Authorization', `Bearer ${b}`).expect(404);
  });
  it('reports health', async () => { await api().get('/health').expect(200); });
});
