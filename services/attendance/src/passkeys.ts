import { ForbiddenException, HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AuthUser } from './auth';
import { AppConfig, CONFIG } from './config';

export abstract class ClockPasskeyVerifier {
  abstract consume(user: AuthUser, proof?: string, ctx?: { ip?: string; ua?: string }): Promise<void>;
}

@Injectable()
export class IdentityClockPasskeyVerifier extends ClockPasskeyVerifier {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) { super(); }

  async consume(user: AuthUser, proof?: string, ctx?: { ip?: string; ua?: string }) {
    let response: Response;
    try {
      response = await fetch(`${this.cfg.identityUrl}/v1/auth/passkeys/clock/consume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json', ...(ctx?.ua ? { 'user-agent': ctx.ua } : {}) },
        body: JSON.stringify({ proof }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new ServiceUnavailableException('Passkey verification is unavailable. Try again shortly.');
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return;
    const message = typeof data.message === 'string' ? data.message : '';
    if (response.status === 401 || response.status === 403) {
      throw new ForbiddenException(message || 'Confirm this clock-in with your registered passkey.');
    }
    if (response.status === 429) throw new HttpException('Too many passkey attempts. Wait a minute and try again.', 429);
    throw new ServiceUnavailableException('Passkey verification is unavailable. Try again shortly.');
  }
}
