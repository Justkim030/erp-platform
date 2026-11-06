import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Pool } from 'pg';
import { AdminService } from './admin.service';
import { AuditService } from './audit';
import { AuthService } from './auth.service';
import { CONFIG, config } from './config';
import { AuthController, PlatformController, SystemController, UsersController } from './controllers';
import { Db, PG_POOL } from './db';
import { JwtGuard, PlatformGuard, RolesGuard } from './guards';
import { ConsoleNotifier, Notifier } from './notifier';
import { PasswordService, TokenService } from './security';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.GLOBAL_RATE_LIMIT ?? 120) }])],
  controllers: [AuthController, UsersController, PlatformController, SystemController],
  providers: [
    { provide: CONFIG, useFactory: config },
    { provide: PG_POOL, inject: [CONFIG], useFactory: (c: ReturnType<typeof config>) => new Pool({ connectionString: c.databaseUrl }) },
    { provide: Notifier, useClass: ConsoleNotifier },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    Db, PasswordService, TokenService, AuditService, AuthService, AdminService, JwtGuard, RolesGuard, PlatformGuard,
  ],
})
export class AppModule {}
