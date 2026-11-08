import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { AuthUser } from './auth';
import { AppConfig, CONFIG } from './config';
import { Db, Q } from './db';

export function newId() { return require('crypto').randomUUID() as string; }

export interface AuditInput {
  tenantId?: string | null;
  actorId?: string | null;
  action: string;
  target?: string | null;
  ip?: string;
  ua?: string;
  correlationId?: string;
  meta?: Record<string, unknown>;
}

const INSERT = `INSERT INTO audit_events (id, tenant_id, actor_id, action, target, ip, user_agent, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

/**
 * Audit recording has two modes:
 * - recordWithinTx(q, e): runs INSIDE the caller's transaction. Critical actions
 *   (clock in/out, reviews) must use this so the audit row is committed or rolled
 *   back with the business change. Never put secrets in meta.
 * - record(e): standalone best-effort write for non-critical events.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly db: Db) {}

  /** Transaction-bound audit write: participates in the caller's transaction. */
  async recordWithinTx(q: Q, e: AuditInput) {
    await q(INSERT, [newId(), e.tenantId ?? null, e.actorId ?? null, e.action, e.target ?? null, e.ip ?? null, e.ua?.slice(0, 300) ?? null,
      JSON.stringify({ ...(e.meta ?? {}), ...(e.correlationId ? { correlationId: e.correlationId } : {}) })]);
  }

  /** Standalone audit write (its own transaction). Best-effort: never breaks the request. */
  async record(e: AuditInput) {
    try {
      await this.db.tx(async (q) => this.recordWithinTx(q, e));
    } catch (err) { this.log.error(`Audit write failed for ${e.action}: ${(err as Error).message}`); }
  }
}

export interface Member {
  id: string;
  staffNumber: string;
  fullName: string;
  role: string;
  status: string;
  supervisorId: string | null;
  departmentId?: string | null;
  jobTitle?: string | null;
}

/** Who is in the caller's team? Identity owns that data; we ask it using the caller's own token, so scope is enforced there. */
export abstract class Roster { abstract members(user: AuthUser): Promise<Member[]> }

@Injectable()
export class IdentityRoster extends Roster {
  private readonly cache = new Map<string, { at: number; data: Member[] }>();
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) { super(); }
  async members(user: AuthUser) {
    const key = `${user.tid}:${user.role}:${user.role === 'supervisor' ? user.sub : '*'}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cfg.rosterTtlMs) return hit.data;
    let res: Response;
    try { res = await fetch(`${this.cfg.identityUrl}/v1/users`, { headers: { authorization: `Bearer ${user.token}` } }); }
    catch { throw new ServiceUnavailableException('The team directory is unavailable. Try again shortly.'); }
    if (!res.ok) throw new ServiceUnavailableException('The team directory is unavailable. Try again shortly.');
    const data = ((await res.json()) as Member[]).filter((m) => (m.role === 'worker' || m.role === 'supervisor') && m.id !== user.sub);
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }
}

/** Privacy: exact coordinates are kept only for a limited time. Distance and outcome stay for the record. */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}
  async purge(now = new Date()) {
    const cutoff = new Date(now.getTime() - this.cfg.retentionDays * 86_400_000);
    await this.db.query('UPDATE attendance_events SET lat=NULL, lng=NULL, accuracy_m=NULL WHERE occurred_at < $1 AND lat IS NOT NULL', [cutoff]);
  }
  onModuleInit() {
    if (this.cfg.purgeIntervalMs > 0) {
      this.purge().catch(() => undefined);
      this.timer = setInterval(() => this.purge().catch(() => undefined), this.cfg.purgeIntervalMs);
      this.timer.unref();
    }
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
