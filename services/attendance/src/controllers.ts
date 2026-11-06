import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AttendanceService } from './attendance.service';
import { AuthUser, JwtGuard, Roles, RolesGuard } from './auth';
import { Db } from './db';
import { ClockInDto, ClockOutDto, ReviewDto, SiteDto } from './dto';

const LIMIT = Number(process.env.CLOCK_RATE_LIMIT ?? 20);
const clockLimit = Throttle({ default: { limit: LIMIT, ttl: 60_000 } });
const ctxOf = (req: Request) => ({ ip: req.ip, ua: req.headers['user-agent'] as string | undefined, correlationId: (req as any).correlationId as string | undefined });
const userOf = (req: Request) => (req as any).user as AuthUser;

@Controller('v1')
@UseGuards(JwtGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly svc: AttendanceService) {}

  // worker
  @Get('attendance/state') state(@Req() req: Request) { return this.svc.state(userOf(req)); }
  @clockLimit @Post('attendance/clock-in') @HttpCode(201)
  clockIn(@Body() dto: ClockInDto, @Req() req: Request) { return this.svc.clock('in', userOf(req), dto, ctxOf(req)); }
  @clockLimit @Post('attendance/clock-out') @HttpCode(201)
  clockOut(@Body() dto: ClockOutDto, @Req() req: Request) { return this.svc.clock('out', userOf(req), dto, ctxOf(req)); }
  @Get('attendance/history')
  history(@Req() req: Request, @Query('days') days?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const p = page === undefined ? undefined : Math.max(Number(page) || 1, 1);
    const size = pageSize === undefined ? 50 : Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    return this.svc.history(userOf(req), Math.min(Math.max(Number(days) || 31, 1), 92), p, size);
  }

  // sites: everyone can list (workers get names only); management configures
  @Get('sites') sites(@Req() req: Request) { return this.svc.listSites(userOf(req)); }
  @Roles('management', 'admin') @Post('sites') @HttpCode(201)
  createSite(@Body() dto: SiteDto, @Req() req: Request) { return this.svc.saveSite(userOf(req), dto, undefined, req.ip); }
  @Roles('management', 'admin') @Put('sites/:id')
  updateSite(@Param('id') id: string, @Body() dto: SiteDto, @Req() req: Request) { return this.svc.saveSite(userOf(req), dto, id, req.ip); }

  // supervisor and management
  @Roles('supervisor', 'management', 'admin') @Get('team/attendance')
  board(@Req() req: Request, @Query('date') date?: string) { return this.svc.board(userOf(req), date); }
  @Roles('supervisor', 'management', 'admin') @Get('team/map')
  map(@Req() req: Request, @Query('date') date?: string) { return this.svc.map(userOf(req), req.ip, date); }
  @Roles('supervisor', 'management', 'admin') @Get('team/reviews')
  reviews(@Req() req: Request, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const p = page === undefined ? undefined : Math.max(Number(page) || 1, 1);
    const size = pageSize === undefined ? 50 : Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    return this.svc.reviews(userOf(req), p, size);
  }
  @Roles('supervisor', 'management', 'admin') @Post('attendance/events/:id/review') @HttpCode(200)
  review(@Param('id') id: string, @Body() dto: ReviewDto, @Req() req: Request) { return this.svc.review(userOf(req), id, dto, req.ip, (req as any).correlationId); }
}

@Controller()
export class SystemController {
  constructor(private readonly db: Db) {}
  @Get('health') async health() { await this.db.query('SELECT 1'); return { status: 'ok' }; }
}
