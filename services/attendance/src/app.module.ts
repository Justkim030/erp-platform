import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { createRemoteJWKSet } from 'jose';
import { Pool } from 'pg';
import { AttendanceService } from './attendance.service';
import { JWKS, JwtGuard, RolesGuard } from './auth';
import { CONFIG, config } from './config';
import { AttendanceController, SystemController } from './controllers';
import { Db, PG_POOL } from './db';
import { AuditService, IdentityRoster, RetentionService, Roster } from './support';
import { WorkReportsService } from './work-reports.service';
import { TasksService } from './tasks.service';
import { ClockPasskeyVerifier, IdentityClockPasskeyVerifier } from './passkeys';

type Cfg = ReturnType<typeof config>;

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.GLOBAL_RATE_LIMIT ?? 240) }])],
  controllers: [AttendanceController, SystemController],
  providers: [
    { provide: CONFIG, useFactory: config },
    { provide: PG_POOL, inject: [CONFIG], useFactory: (c: Cfg) => new Pool({ connectionString: c.databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10) }) },
    { provide: JWKS, inject: [CONFIG], useFactory: (c: Cfg) => createRemoteJWKSet(new URL(c.jwksUrl), { cooldownDuration: 30_000 }) },
    { provide: Roster, useClass: IdentityRoster },
    { provide: ClockPasskeyVerifier, useClass: IdentityClockPasskeyVerifier },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    Db, AuditService, RetentionService, AttendanceService, WorkReportsService, TasksService, JwtGuard, RolesGuard,
  ],
})
export class AppModule {}
