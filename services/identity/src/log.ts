import { ConsoleLogger, LogLevel } from '@nestjs/common';

/**
 * Structured JSON logger for machine consumption while staying readable locally.
 * One JSON object per line: { ts, level, ctx, msg, ...fields }.
 * Secrets and personal data must never be passed as fields.
 */
export class JsonLogger extends ConsoleLogger {
  private fmt(level: LogLevel, ctx: string, msg: unknown, stack?: string): string {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ctx,
      msg: typeof msg === 'string' ? msg : msg,
    };
    if (stack) line.stack = stack.split('\n').slice(0, 6).join(' | '); // compact server-side trace
    return JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  }
  log(msg: any, ctx?: string) { process.stdout.write(this.fmt('log', ctx ?? this.context ?? 'app', msg) + '\n'); }
  error(msg: any, stack?: string, ctx?: string) { process.stderr.write(this.fmt('error', ctx ?? this.context ?? 'app', msg, stack) + '\n'); }
  warn(msg: any, ctx?: string) { process.stdout.write(this.fmt('warn', ctx ?? this.context ?? 'app', msg) + '\n'); }
  debug(msg: any, ctx?: string) {
    if (process.env.LOG_LEVEL === 'debug') process.stdout.write(this.fmt('debug', ctx ?? this.context ?? 'app', msg) + '\n');
  }
  verbose(msg: any, ctx?: string) { process.stdout.write(this.fmt('debug', ctx ?? this.context ?? 'app', msg) + '\n'); }
}

export const logger = new JsonLogger();

/** Small context type passed alongside requests. Never put credentials or tokens in here. */
export interface LogContext {
  correlationId?: string;
  tenantId?: string;
  actorId?: string;
}
