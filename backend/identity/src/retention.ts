import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db } from './db';
import { AppConfig, CONFIG } from './config';

/**
 * Audit-log retention. Audit rows are personal data (ip, user agent, actor) and must
 * not be kept indefinitely: rows older than AUDIT_RETENTION_DAYS are erased on a
 * schedule. Erasure (DELETE) rather than anonymisation keeps the schema simple;
 * the retention floor (30 days) is enforced by the production config validation.
 */
@Injectable()
export class AuditRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AuditRetention');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) { }

  async purge(now = new Date()) {
    await this.db.ensureReady();
    const cutoff = new Date(now.getTime() - this.cfg.auditRetentionDays * 86_400_000);
    const erased = await this.db.query('DELETE FROM audit_events WHERE created_at < $1 RETURNING id', [cutoff]);
    if (erased.length) this.log.log(`Erased ${erased.length} audit events older than ${this.cfg.auditRetentionDays} days`);
  }

  onModuleInit() {
    if (this.cfg.auditPurgeIntervalMs > 0) {
      this.purge().catch((e) => this.log.error(`Initial audit purge failed: ${(e as Error).message}`));
      this.timer = setInterval(() => this.purge().catch((e) => this.log.error(`Audit purge failed: ${(e as Error).message}`)), this.cfg.auditPurgeIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
