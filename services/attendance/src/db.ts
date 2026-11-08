import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { MIGRATIONS } from './migrations';

export const PG_POOL = 'PG_POOL';
export type Q = <T = any>(text: string, params?: any[]) => Promise<T[]>;

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Db');
  private initPromise?: Promise<void>;
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    await this.ensureReady();
  }
  async ensureReady() {
    if (!this.initPromise) this.initPromise = this.migrate();
    await this.initPromise;
  }
  async onModuleDestroy() {
    await this.pool.end();
  }

  query: Q = async (text, params = []) => (await this.pool.query(text, params)).rows;

  async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const q: Q = async (text, params = []) => (await client.query(text, params)).rows;
    try {
      await client.query('BEGIN');
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async migrate() {
    await this.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await this.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await this.tx(async (q) => {
        for (const s of m.statements) await q(s);
        await q('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      });
      this.log.log(`Applied migration ${m.id}`);
    }
  }
}
