import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { AuditService } from './audit';
import { AppConfig, CONFIG } from './config';
import { Db } from './db';
import { AuthUser } from './guards';
import { newId, TokenService } from './security';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;

@Injectable()
export class PasskeysService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private async activeWorker(user: AuthUser) {
    if (user.role !== 'worker') throw new ForbiddenException();
    const row = (await this.db.query(
      `SELECT id,tenant_id,staff_number,full_name,status FROM users WHERE id=$1 AND tenant_id=$2`,
      [user.sub, user.tid],
    ))[0];
    if (!row || row.status !== 'active') throw new UnauthorizedException();
    return row;
  }

  private async credentials(user: AuthUser) {
    return this.db.query(
      `SELECT id,credential_id,public_key,counter,transports,name,device_type,backed_up,created_at,last_used_at
       FROM passkeys WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at`,
      [user.tid, user.sub],
    );
  }

  async list(user: AuthUser) {
    await this.activeWorker(user);
    const rows = await this.credentials(user);
    return rows.map((row) => ({
      id: row.id, name: row.name, deviceType: row.device_type, backedUp: row.backed_up,
      createdAt: row.created_at, lastUsedAt: row.last_used_at,
    }));
  }

  private async saveChallenge(user: AuthUser, purpose: 'registration' | 'clock-in', challenge: string) {
    const now = new Date();
    await this.db.query(
      `DELETE FROM webauthn_challenges WHERE expires_at < $1 OR used_at < $2`,
      [now, new Date(now.getTime() - 86_400_000)],
    );
    const id = newId();
    await this.db.query(
      `INSERT INTO webauthn_challenges (id,tenant_id,user_id,purpose,challenge,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, user.tid, user.sub, purpose, challenge, new Date(now.getTime() + CHALLENGE_TTL_MS)],
    );
    return id;
  }

  private async takeChallenge(user: AuthUser, purpose: 'registration' | 'clock-in', requestId: string) {
    const row = (await this.db.query(
      `SELECT id,challenge FROM webauthn_challenges
       WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND purpose=$4 AND used_at IS NULL AND expires_at > $5`,
      [requestId, user.tid, user.sub, purpose, new Date()],
    ))[0];
    if (!row) throw new BadRequestException('The passkey request expired. Start again.');
    const claimed = await this.db.query(
      `UPDATE webauthn_challenges SET used_at=$2 WHERE id=$1 AND used_at IS NULL AND expires_at > $2 RETURNING challenge`,
      [row.id, new Date()],
    );
    if (!claimed.length) throw new BadRequestException('The passkey request was already used. Start again.');
    return claimed[0].challenge as string;
  }

  async registrationOptions(user: AuthUser) {
    const record = await this.activeWorker(user);
    const credentials = await this.credentials(user);
    if (credentials.length >= MAX_PASSKEYS) throw new BadRequestException(`You can register up to ${MAX_PASSKEYS} passkeys.`);
    const options = await generateRegistrationOptions({
      rpName: this.cfg.webauthnRpName,
      rpID: this.cfg.webauthnRpId,
      userID: Buffer.from(user.sub, 'utf8'),
      userName: record.staff_number,
      userDisplayName: record.full_name,
      attestationType: 'none',
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: JSON.parse(credential.transports),
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: CHALLENGE_TTL_MS,
    });
    const requestId = await this.saveChallenge(user, 'registration', options.challenge);
    return { requestId, options };
  }

  async verifyRegistration(user: AuthUser, requestId: string, response: RegistrationResponseJSON, name?: string, ctx?: { ip?: string; ua?: string }) {
    await this.activeWorker(user);
    if (!response?.id) throw new BadRequestException('Invalid passkey response. Start registration again.');
    const expectedChallenge = await this.takeChallenge(user, 'registration', requestId);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.cfg.webauthnOrigins,
        expectedRPID: this.cfg.webauthnRpId,
        requireUserVerification: true,
      });
    } catch (error) {
      if (error instanceof Error) throw new BadRequestException('Passkey registration could not be verified. Start again.');
      throw error;
    }
    if (!verification.verified || !verification.registrationInfo) throw new BadRequestException('Passkey registration could not be verified. Start again.');
    const credential = verification.registrationInfo.credential;
    const id = newId();
    const deviceName = name?.trim() || 'This device';
    try {
      await this.db.query(
        `INSERT INTO passkeys (id,tenant_id,user_id,credential_id,public_key,counter,transports,name,device_type,backed_up)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id, user.tid, user.sub, credential.id, Buffer.from(credential.publicKey).toString('base64url'),
          credential.counter, JSON.stringify(credential.transports ?? response.response.transports ?? []),
          deviceName, verification.registrationInfo.credentialDeviceType, verification.registrationInfo.credentialBackedUp,
        ],
      );
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') throw new ConflictException('This passkey is already registered.');
      throw error;
    }
    await this.audit.record({
      tenantId: user.tid, actorId: user.sub, action: 'passkey.registered', target: id,
      ip: ctx?.ip, ua: ctx?.ua, meta: { name: deviceName, deviceType: verification.registrationInfo.credentialDeviceType },
    });
    return { id, name: deviceName };
  }

  async clockOptions(user: AuthUser) {
    await this.activeWorker(user);
    const credentials = await this.credentials(user);
    if (!credentials.length) return { required: false };
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.webauthnRpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: JSON.parse(credential.transports),
      })),
      userVerification: 'required',
      timeout: CHALLENGE_TTL_MS,
    });
    const requestId = await this.saveChallenge(user, 'clock-in', options.challenge);
    return { required: true, requestId, options };
  }

  async verifyClock(user: AuthUser, requestId: string, response: AuthenticationResponseJSON, ctx?: { ip?: string; ua?: string }) {
    await this.activeWorker(user);
    if (!response?.id) throw new BadRequestException('Invalid passkey response. Start again.');
    const expectedChallenge = await this.takeChallenge(user, 'clock-in', requestId);
    const credential = (await this.db.query(
      `SELECT * FROM passkeys WHERE tenant_id=$1 AND user_id=$2 AND credential_id=$3`,
      [user.tid, user.sub, response.id],
    ))[0];
    if (!credential) throw new UnauthorizedException('This passkey is not registered to your account.');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.cfg.webauthnOrigins,
        expectedRPID: this.cfg.webauthnRpId,
        credential: {
          id: credential.credential_id,
          publicKey: Buffer.from(credential.public_key, 'base64url'),
          counter: Number(credential.counter),
          transports: JSON.parse(credential.transports),
        },
        requireUserVerification: true,
      });
    } catch (error) {
      if (error instanceof Error) throw new UnauthorizedException('Passkey verification failed. Try again.');
      throw error;
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw new UnauthorizedException('Passkey verification failed. Try again.');
    }
    // Clone detection: authenticators must increment their signature counter. A
    // counter that went BACKWARDS means the credential was cloned and is being
    // used from a second device — refuse and revoke the credential.
    const newCounter = verification.authenticationInfo.newCounter;
    if (newCounter > 0 && newCounter < Number(credential.counter)) {
      await this.db.query('DELETE FROM passkeys WHERE id=$1', [credential.id]);
      await this.audit.record({
        tenantId: user.tid, actorId: user.sub, action: 'passkey.counter_regression', target: credential.id,
        ip: ctx?.ip, ua: ctx?.ua, meta: { previous: Number(credential.counter), received: newCounter },
      });
      throw new UnauthorizedException('This passkey has been disabled for your protection. Register it again.');
    }
    const jti = newId();
    const proof = await this.tokens.signClockInProof({ sub: user.sub, tid: user.tid, jti });
    await this.db.tx(async (q) => {
      const updated = await q(
        `UPDATE passkeys SET counter=$4,last_used_at=$5,device_type=$6,backed_up=$7
         WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING id`,
        [
          credential.id, user.tid, user.sub, verification.authenticationInfo.newCounter, new Date(),
          verification.authenticationInfo.credentialDeviceType, verification.authenticationInfo.credentialBackedUp,
        ],
      );
      if (!updated.length) throw new NotFoundException('Passkey not found.');
      await q(
        `INSERT INTO passkey_clock_proofs (jti,tenant_id,user_id,expires_at) VALUES ($1,$2,$3,$4)`,
        [jti, user.tid, user.sub, new Date(Date.now() + 90_000)],
      );
      await q(`DELETE FROM passkey_clock_proofs WHERE expires_at < $1 OR used_at < $2`, [new Date(), new Date(Date.now() - 86_400_000)]);
    });
    await this.audit.record({
      tenantId: user.tid, actorId: user.sub, action: 'passkey.clock_confirmed', target: credential.id,
      ip: ctx?.ip, ua: ctx?.ua, meta: { deviceType: verification.authenticationInfo.credentialDeviceType },
    });
    return { proof };
  }

  async consumeClockProof(user: AuthUser, proof?: string, ctx?: { ip?: string; ua?: string }) {
    await this.activeWorker(user);
    const credentials = await this.credentials(user);
    if (!credentials.length) {
      if (proof) throw new ForbiddenException('No passkey is registered for this account.');
      return { required: false };
    }
    if (!proof) throw new ForbiddenException('Confirm this clock-in with your registered passkey.');
    let claims;
    try {
      claims = await this.tokens.verifyClockInProof(proof);
    } catch {
      throw new ForbiddenException('Passkey confirmation is invalid or expired.');
    }
    if (claims.sub !== user.sub || claims.tid !== user.tid || claims.purpose !== 'clock-in' || !claims.jti) {
      throw new ForbiddenException('Passkey confirmation is not valid for this account.');
    }
    const consumed = await this.db.query(
      `UPDATE passkey_clock_proofs SET used_at=$4
       WHERE jti=$1 AND tenant_id=$2 AND user_id=$3 AND used_at IS NULL AND expires_at > $4 RETURNING jti`,
      [claims.jti, user.tid, user.sub, new Date()],
    );
    if (!consumed.length) throw new ForbiddenException('Passkey confirmation expired or was already used.');
    await this.audit.record({
      tenantId: user.tid, actorId: user.sub, action: 'passkey.clock_proof_consumed', target: claims.jti,
      ip: ctx?.ip, ua: ctx?.ua,
    });
    return { required: true };
  }

  async remove(user: AuthUser, id: string, ctx?: { ip?: string; ua?: string }) {
    await this.activeWorker(user);
    const removed = await this.db.query(
      `DELETE FROM passkeys WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING id,name`,
      [id, user.tid, user.sub],
    );
    if (!removed.length) throw new NotFoundException('Passkey not found.');
    await this.audit.record({
      tenantId: user.tid, actorId: user.sub, action: 'passkey.removed', target: id,
      ip: ctx?.ip, ua: ctx?.ua, meta: { name: removed[0].name },
    });
  }
}
