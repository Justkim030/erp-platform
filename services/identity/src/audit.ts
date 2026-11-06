import { Injectable, Logger } from '@nestjs/common';
import { Db, Q } from './db';
import { newId } from './security';

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
 *   (user creation, access reset, organisation creation) must use this so the audit
 *   row commits or rolls back with the business change. Never put secrets in meta.
 * - record(e): standalone best-effort write for non-critical events (logins use this
 *   deliberately: a flooded login endpoint must not be able to exhaust the DB pool).
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly db: Db) { }

  /** Transaction-bound audit write: participates in the caller's transaction. */
  async recordWithinTx(q: Q, e: AuditInput) {
    await q(INSERT, [newId(), e.tenantId ?? null, e.actorId ?? null, e.action, e.target ?? null, e.ip ?? null, e.ua?.slice(0, 300) ?? null,
    JSON.stringify({ ...(e.meta ?? {}), ...(e.correlationId ? { correlationId: e.correlationId } : {}) })]);
  }

  /** Standalone audit write (its own transaction). Best-effort: never breaks the request. */
  async record(e: AuditInput) {
    try {
      await this.db.tx(async (q) => this.recordWithinTx(q, e));
    } catch (err) {
      this.log.error(`Failed to write audit event ${e.action}: ${(err as Error).message}`);
    }
  }
}
