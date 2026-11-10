import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CONFIG, config, validateProductionConfig } from '../src/config';
import { Db, PG_POOL } from '../src/db';
import { ipInCidr } from '../src/net';
import { Notifier } from '../src/notifier';
import { newId, TokenService } from '../src/security';
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

  describe('system readiness and errors', () => {
    it('exposes liveness/readiness and includes a correlation id on API errors', async () => {
      await api().get('/healthz').expect(200, { status: 'ok' });
      await api().get('/readyz').expect(200, { status: 'ready' });
      const response = await api().post('/v1/auth/login').set('x-correlation-id', 'trace-test-123').send({}).expect(400);
      expect(response.headers['x-correlation-id']).toBe('trace-test-123');
      expect(response.body.correlationId).toBe('trace-test-123');
    });

    it('requires a strong production bootstrap token', () => {
      const oldDatabaseUrl = process.env.DATABASE_URL;
      const oldRpId = process.env.WEBAUTHN_RP_ID;
      const oldOrigins = process.env.WEBAUTHN_ORIGINS;
      process.env.DATABASE_URL = 'postgres://platform:secret@localhost/identity';
      process.env.WEBAUTHN_RP_ID = 'example.com';
      process.env.WEBAUTHN_ORIGINS = 'https://portal.example.com';
      try {
        const base = { ...config(), env: 'production', signingKeyJwk: '{"kty":"OKP"}' };
        expect(validateProductionConfig({ ...base, bootstrapToken: undefined })).toContain('PLATFORM_BOOTSTRAP_TOKEN is required in production.');
        expect(validateProductionConfig({ ...base, bootstrapToken: 'short' })).toContain('PLATFORM_BOOTSTRAP_TOKEN must contain at least 32 bytes in production.');
        expect(validateProductionConfig({ ...base, bootstrapToken: 'a'.repeat(32) })).toEqual([]);
      } finally {
        if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = oldDatabaseUrl;
        if (oldRpId === undefined) delete process.env.WEBAUTHN_RP_ID;
        else process.env.WEBAUTHN_RP_ID = oldRpId;
        if (oldOrigins === undefined) delete process.env.WEBAUTHN_ORIGINS;
        else process.env.WEBAUTHN_ORIGINS = oldOrigins;
      }
    });
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
  it('exposes passkey management options only to an active worker and keeps passkey clock checks optional until enrollment', async () => {
    const worker = (await login('alpha', '0457', '482915').expect(200)).body.accessToken;
    await api().get('/v1/auth/passkeys').set('Authorization', `Bearer ${worker}`).expect(200, []);
    const registration = await api().post('/v1/auth/passkeys/registration/options').set('Authorization', `Bearer ${worker}`).send({}).expect(200);
    expect(registration.body).toMatchObject({
      requestId: expect.any(String),
      options: { challenge: expect.any(String), rp: { id: 'localhost', name: 'ERP Platform' }, authenticatorSelection: { userVerification: 'required' } },
    });
    await api().post('/v1/auth/passkeys/clock/options').set('Authorization', `Bearer ${worker}`).send({}).expect(200, { required: false });
    const management = (await login('alpha', '0001', PASS).expect(200)).body.accessToken;
    await api().get('/v1/auth/passkeys').set('Authorization', `Bearer ${management}`).expect(403);
  });
  it('requires an enrolled worker to consume a signed, one-use passkey proof for clock-in', async () => {
    const worker = (await login('alpha', '0457', '482915').expect(200)).body.accessToken;
    const user = (await app.get(Db).query('SELECT * FROM users WHERE staff_number=$1', ['0457']))[0];
    const credentialId = `credential-${newId()}`;
    await app.get(Db).query(
      `INSERT INTO passkeys (id,tenant_id,user_id,credential_id,public_key,counter,transports,name,device_type,backed_up)
       VALUES ($1,$2,$3,$4,$5,0,'[]','Test device','singleDevice',false)`,
      [newId(), user.tenant_id, user.id, credentialId, Buffer.from('public-key').toString('base64url')]);
    const clockOptions = await api().post('/v1/auth/passkeys/clock/options').set('Authorization', `Bearer ${worker}`).send({}).expect(200);
    expect(clockOptions.body.required).toBe(true);
    expect(clockOptions.body.options.allowCredentials[0].id).toBe(credentialId);
    await api().post('/v1/auth/passkeys/clock/consume').set('Authorization', `Bearer ${worker}`).send({}).expect(403);

    const jti = newId();
    const proof = await app.get(TokenService).signClockInProof({ sub: user.id, tid: user.tenant_id, jti });
    await app.get(Db).query(
      `INSERT INTO passkey_clock_proofs (jti,tenant_id,user_id,expires_at) VALUES ($1,$2,$3,$4)`,
      [jti, user.tenant_id, user.id, new Date(Date.now() + 90_000)]);
    await api().post('/v1/auth/passkeys/clock/consume').set('Authorization', `Bearer ${worker}`).send({ proof }).expect(200, { required: true });
    await api().post('/v1/auth/passkeys/clock/consume').set('Authorization', `Bearer ${worker}`).send({ proof }).expect(403);
  });
  it('requires management to assign workers when active supervisors exist', async () => {
    await addUser(admin, { staffNumber: '0460', fullName: 'Unassigned Worker', role: 'worker' }).expect(400);
    const created = await addUser(admin, { staffNumber: '0461', fullName: 'Assigned Worker', role: 'worker', supervisorId: sup.id }).expect(201);
    expect(created.body.user.supervisorId).toBe(sup.id);
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
    expect(mine.map((u: any) => u.staffNumber).sort()).toEqual(['0457', '0458', '0459', '0461']);
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

describe('security hardening regressions', () => {
  it('audit retention purge erases rows older than the retention window', async () => {
    const db = app.get(Db);
    const old = new Date(Date.now() - 400 * 86_400_000);
    await db.query(`INSERT INTO audit_events (id, action, created_at) VALUES ($1, 'test.old', $2)`, [newId(), old]);
    const fresh = await db.query(`INSERT INTO audit_events (id, action, created_at) VALUES ($1, 'test.fresh', now()) RETURNING id`, [newId()]);
    const { AuditRetentionService } = await import('../src/retention');
    const svc = app.get(AuditRetentionService);
    await svc.purge();
    const gone = await db.query('SELECT id FROM audit_events WHERE action=$1', ['test.old']);
    const kept = await db.query('SELECT id FROM audit_events WHERE id=$1', [fresh[0].id]);
    expect(gone).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });
});
