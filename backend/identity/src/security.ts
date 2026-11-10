import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { AppConfig, CONFIG } from './config';

export type Role = 'worker' | 'supervisor' | 'management' | 'admin';
export const ROLES: Role[] = ['worker', 'supervisor', 'management', 'admin'];

export const newId = () => randomUUID();
export const randomToken = () => randomBytes(32).toString('base64url');
export const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// 32 unambiguous characters (no I, O, 0, 1): 256 is divisible by 32, so no modulo bias.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function inviteCode(): string {
  const bytes = randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normaliseInvite = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '0123456789', 'qwertyuiop', 'changeme123', 'welcome123', 'administrator']);

const COMMON_PINS = new Set(['123456', '654321', '112233', '159753', '147258', '123321', '696969', '101010', '121212', '2468024', '13579']);
const isSequence = (s: string) => {
  const d = [...s].map(Number);
  const step = d[1] - d[0];
  return Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step);
};

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummy = '';
  private readonly opts = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP minimum for Argon2id

  async onModuleInit() {
    this.dummy = await hash('dummy-password-for-timing', this.opts);
  }
  hash(pw: string) {
    return hash(pw, this.opts);
  }
  async verify(stored: string, pw: string) {
    try {
      return await verify(stored, pw);
    } catch {
      return false;
    }
  }
  /** Burn comparable time when the account does not exist, so timing does not reveal it. */
  async dummyVerify(pw: string) {
    await this.verify(this.dummy, pw);
  }
  /** Returns an error message, or null when the secret is acceptable for its type and role. */
  policy(secret: string, type: 'password' | 'pin' = 'password', role?: Role): string | null {
    if (type === 'pin') {
      if (role && role !== 'worker') return 'A PIN can only be used for worker accounts. Choose a password.';
      if (!/^\d{6,8}$/.test(secret)) return 'A PIN must be 6 to 8 digits.';
      if (/^(\d{1,3})\1+$/.test(secret) || isSequence(secret) || COMMON_PINS.has(secret)) return 'Choose a less predictable PIN.';
      return null;
    }
    if (secret.length < 10) return 'Password must be at least 10 characters.';
    if (secret.length > 128) return 'Password must be at most 128 characters.';
    if (COMMON.has(secret.toLowerCase()) || /^(.)\1+$/.test(secret)) return 'Choose a less predictable password.';
    return null;
  }
}

@Injectable()
export class TokenService implements OnModuleInit {
  private readonly log = new Logger('TokenService');
  private privateKey: any;
  private publicKey: any;
  private publicJwk: any;

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  async onModuleInit() {
    if (this.cfg.signingKeyJwk) {
      const jwk = JSON.parse(this.cfg.signingKeyJwk);
      this.privateKey = await importJWK(jwk, 'EdDSA');
      const { d, ...pub } = jwk;
      this.publicJwk = pub;
    } else {
      if (this.cfg.env === 'production') throw new Error('SIGNING_KEY_JWK is required in production');
      this.log.warn('No SIGNING_KEY_JWK set: using an ephemeral key. Tokens will not survive a restart.');
      const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
      this.privateKey = pair.privateKey;
      this.publicJwk = await exportJWK(pair.publicKey);
    }
    const kid = await calculateJwkThumbprint(this.publicJwk);
    this.publicJwk = { ...this.publicJwk, kid, alg: 'EdDSA', use: 'sig' };
    this.publicKey = await importJWK(this.publicJwk, 'EdDSA');
  }

  signAccess(c: { sub: string; tid: string; role: Role }) {
    return new SignJWT({ tid: c.tid, role: c.role })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.publicJwk.kid })
      .setSubject(c.sub)
      .setIssuer(this.cfg.issuer)
      .setAudience(this.cfg.audience)
      .setIssuedAt()
      .setJti(newId())
      .setExpirationTime(`${this.cfg.accessTtl}s`)
      .sign(this.privateKey);
  }

  signClockInProof(c: { sub: string; tid: string; jti: string }) {
    return new SignJWT({ tid: c.tid, purpose: 'clock-in' })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.publicJwk.kid })
      .setSubject(c.sub)
      .setIssuer(this.cfg.issuer)
      .setAudience('platform-clock-in')
      .setIssuedAt()
      .setJti(c.jti)
      .setExpirationTime('90s')
      .sign(this.privateKey);
  }

  async verifyClockInProof(token: string) {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.cfg.issuer,
      audience: 'platform-clock-in',
      algorithms: ['EdDSA'],
    });
    return payload as { sub: string; tid: string; purpose: string; jti: string };
  }

  async verifyAccess(token: string) {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.cfg.issuer,
      audience: this.cfg.audience,
      algorithms: ['EdDSA'],
    });
    return payload as { sub: string; tid: string; role: Role };
  }

  jwks() {
    return { keys: [this.publicJwk] };
  }
}
