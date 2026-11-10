import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditService } from './audit';
import { AppConfig, CONFIG } from './config';
import { Db } from './db';
import { ActivateDto, ForgotDto, LoginDto, ResetDto } from './dto';
import { Notifier } from './notifier';
import { PasswordService, TokenService, newId, normaliseInvite, randomToken, same, sha256 } from './security';

export type Ctx = { ip?: string; ua?: string; correlationId?: string };
const GENERIC = 'Invalid credentials';
const MAX_CODE_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly pw: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private async tenantBySlug(slug: string) {
    return (await this.db.query('SELECT * FROM tenants WHERE slug=$1 AND status=$2', [slug, 'active']))[0];
  }
  private async tenantById(id: string) {
    return (await this.db.query('SELECT * FROM tenants WHERE id=$1 AND status=$2', [id, 'active']))[0];
  }

  publicUser(u: any, t: any) {
    return {
      id: u.id, staffNumber: u.staff_number, fullName: u.full_name, role: u.role, status: u.status,
      email: u.email ?? null, phone: u.phone ?? null, supervisorId: u.supervisor_id ?? null, credentialType: u.credential_type ?? null,
      tenant: { id: t.id, slug: t.slug, name: t.name },
    };
  }

  private async issueSession(u: any, t: any, ctx: Ctx, familyId = newId()) {
    const refreshToken = randomToken();
    const expires = new Date(Date.now() + this.cfg.refreshTtlDays * 86_400_000);
    await this.db.query(
      `INSERT INTO refresh_tokens (id,user_id,tenant_id,family_id,token_hash,expires_at,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), u.id, t.id, familyId, sha256(refreshToken), expires, ctx.ip ?? null, ctx.ua?.slice(0, 300) ?? null],
    );
    const accessToken = await this.tokens.signAccess({ sub: u.id, tid: t.id, role: u.role });
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtl, user: this.publicUser(u, t) };
  }

  async login(dto: LoginDto, ctx: Ctx) {
    const t = await this.tenantBySlug(dto.organisation);
    const u = t ? (await this.db.query('SELECT * FROM users WHERE tenant_id=$1 AND staff_number=$2', [t.id, dto.staffNumber]))[0] : undefined;
    const base = { tenantId: t?.id, target: dto.staffNumber, ip: ctx.ip, ua: ctx.ua, correlationId: ctx.correlationId };

    if (!t || !u || u.status !== 'active' || !u.password_hash) {
      await this.pw.dummyVerify(dto.password);
      await this.audit.record({ ...base, actorId: u?.id, action: 'login.failed', meta: { reason: 'unknown_or_inactive' } });
      throw new UnauthorizedException(GENERIC);
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await this.audit.record({ ...base, actorId: u.id, action: 'login.blocked', meta: { reason: 'locked' } });
      throw new UnauthorizedException(GENERIC);
    }
    if (!(await this.pw.verify(u.password_hash, dto.password))) {
      const attempts = u.failed_attempts + 1;
      const lock = attempts >= this.cfg.lockoutThreshold;
      await this.db.query('UPDATE users SET failed_attempts=$2, locked_until=$3 WHERE id=$1', [
        u.id, lock ? 0 : attempts, lock ? new Date(Date.now() + this.cfg.lockoutMinutes * 60_000) : null,
      ]);
      await this.audit.record({ ...base, actorId: u.id, action: lock ? 'login.locked' : 'login.failed', meta: { attempts } });
      throw new UnauthorizedException(GENERIC);
    }
    await this.db.query('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1', [u.id]);
    await this.audit.record({ ...base, actorId: u.id, action: 'login.success' });
    return this.issueSession(u, t, ctx);
  }

  /** First sign-in: the employee proves possession of the activation code and chooses a password or PIN (stored hashed). */
  async activate(dto: ActivateDto, ctx: Ctx) {
    const generic = new BadRequestException('These activation details are not valid or have expired. Ask your supervisor for a new code.');
    const t = await this.tenantBySlug(dto.organisation);
    const u = t ? (await this.db.query('SELECT * FROM users WHERE tenant_id=$1 AND staff_number=$2', [t.id, dto.staffNumber]))[0] : undefined;
    if (!t || !u || u.status !== 'invited') { await this.pw.dummyVerify(dto.secret); throw generic; }
    const invite = (await this.db.query('SELECT * FROM invites WHERE user_id=$1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', [u.id]))[0];
    if (!invite || new Date(invite.expires_at) < new Date() || invite.failed_attempts >= MAX_CODE_ATTEMPTS) { await this.pw.dummyVerify(dto.secret); throw generic; }
    if (!same(sha256(normaliseInvite(dto.activationCode)), invite.code_hash)) {
      await this.db.query('UPDATE invites SET failed_attempts = failed_attempts + 1 WHERE id=$1', [invite.id]);
      await this.audit.record({ tenantId: t.id, actorId: u.id, action: 'activation.failed', target: u.staff_number, ip: ctx.ip, ua: ctx.ua });
      throw generic;
    }
    const policy = this.pw.policy(dto.secret, dto.credentialType, u.role);
    if (policy) throw new BadRequestException(policy);
    const hashed = await this.pw.hash(dto.secret);
    await this.db.tx(async (q) => {
      const claimed = await q('UPDATE invites SET used_at=$2 WHERE id=$1 AND used_at IS NULL RETURNING id', [invite.id, new Date()]);
      if (!claimed.length) throw generic;
      await q(`UPDATE users SET password_hash=$2, credential_type=$3, phone=COALESCE($4, phone), status='active', activated_at=$5, failed_attempts=0, locked_until=NULL WHERE id=$1 AND status='invited'`,
        [u.id, hashed, dto.credentialType, dto.phone ?? null, new Date()]);
    });
    const fresh = (await this.db.query('SELECT * FROM users WHERE id=$1', [u.id]))[0];
    await this.audit.record({ tenantId: t.id, actorId: u.id, action: 'user.activated', target: u.staff_number, ip: ctx.ip, ua: ctx.ua, meta: { credentialType: dto.credentialType } });
    return this.issueSession(fresh, t, ctx);
  }

  private async revokeFamily(familyId: string) {
    await this.db.query('UPDATE refresh_tokens SET revoked_at=$2 WHERE family_id=$1 AND revoked_at IS NULL', [familyId, new Date()]);
  }

  async refresh(token: string, ctx: Ctx) {
    const row = (await this.db.query('SELECT * FROM refresh_tokens WHERE token_hash=$1', [sha256(token)]))[0];
    if (!row) {
      // Equalise timing between "unknown token" and "known but invalid" paths so a
      // prober cannot distinguish them by response latency.
      await this.pw.dummyVerify(token);
      throw new UnauthorizedException();
    }
    if (row.used_at || row.revoked_at) {
      // A rotated token was presented again: assume theft and end the whole session family.
      await this.revokeFamily(row.family_id);
      await this.audit.record({ tenantId: row.tenant_id, actorId: row.user_id, action: 'token.reuse_detected', ip: ctx.ip, ua: ctx.ua });
      throw new UnauthorizedException();
    }
    if (new Date(row.expires_at) < new Date()) throw new UnauthorizedException();
    const claimed = await this.db.query('UPDATE refresh_tokens SET used_at=$2 WHERE id=$1 AND used_at IS NULL RETURNING id', [row.id, new Date()]);
    if (!claimed.length) {
      await this.revokeFamily(row.family_id);
      throw new UnauthorizedException();
    }
    const u = (await this.db.query('SELECT * FROM users WHERE id=$1', [row.user_id]))[0];
    const t = await this.tenantById(row.tenant_id);
    if (!u || u.status !== 'active' || !t) throw new UnauthorizedException();
    return this.issueSession(u, t, ctx, row.family_id);
  }

  async logout(token: string, ctx: Ctx) {
    const row = (await this.db.query('SELECT * FROM refresh_tokens WHERE token_hash=$1', [sha256(token)]))[0];
    if (!row) return;
    await this.revokeFamily(row.family_id);
    await this.audit.record({ tenantId: row.tenant_id, actorId: row.user_id, action: 'logout', ip: ctx.ip, ua: ctx.ua });
  }

  /** Always succeeds from the caller's point of view, so it cannot be used to discover accounts. */
  async forgot(dto: ForgotDto, ctx: Ctx) {
    const t = await this.tenantBySlug(dto.organisation);
    const u = t ? (await this.db.query('SELECT * FROM users WHERE tenant_id=$1 AND staff_number=$2', [t.id, dto.staffNumber]))[0] : undefined;
    if (!t || !u || u.status !== 'active') return;
    const token = randomToken();
    await this.db.query('INSERT INTO password_resets (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)', [
      newId(), u.id, sha256(token), new Date(Date.now() + 30 * 60_000),
    ]);
    await this.audit.record({ tenantId: t.id, actorId: u.id, action: 'password.reset_requested', ip: ctx.ip, ua: ctx.ua });
    await this.notifier.send({ email: u.email, phone: u.phone }, 'password-reset', { token, organisation: t.slug });
  }

  async reset(dto: ResetDto, ctx: Ctx) {
    const policy = this.pw.policy(dto.newPassword);
    if (policy) throw new BadRequestException(policy);
    const bad = new BadRequestException('Invalid or expired reset token.');
    const hashed = await this.pw.hash(dto.newPassword);
    const userId = await this.db.tx(async (q) => {
      const claimed = await q('UPDATE password_resets SET used_at=$2 WHERE token_hash=$1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id', [sha256(dto.token), new Date()]);
      if (!claimed.length) throw bad;
      await q('UPDATE users SET password_hash=$2, failed_attempts=0, locked_until=NULL WHERE id=$1', [claimed[0].user_id, hashed]);
      await q('UPDATE refresh_tokens SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [claimed[0].user_id, new Date()]);
      return claimed[0].user_id as string;
    });
    const u = (await this.db.query('SELECT tenant_id FROM users WHERE id=$1', [userId]))[0];
    await this.audit.record({ tenantId: u?.tenant_id, actorId: userId, action: 'password.reset_completed', ip: ctx.ip, ua: ctx.ua });
  }

  async me(userId: string) {
    const u = (await this.db.query('SELECT * FROM users WHERE id=$1', [userId]))[0];
    const t = u ? await this.tenantById(u.tenant_id) : undefined;
    if (!u || !t || u.status !== 'active') throw new UnauthorizedException();
    return this.publicUser(u, t);
  }
}
