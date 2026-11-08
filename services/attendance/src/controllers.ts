import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AttendanceService } from './attendance.service';
import { AuthUser, JwtGuard, Roles, RolesGuard } from './auth';
import { Db } from './db';
import { ClockInDto, ClockOutDto, CreateExceptionDto, CreateTaskDto, OverrideExceptionDto, PhysicalVerificationDto, ReviewDto, ReviewExceptionDto, SiteDto, TaskProgressDto, UpdateTaskDto, WorkReportDto, WorkReportReviewDto } from './dto';
import { TasksService } from './tasks.service';
import { WorkReportsService } from './work-reports.service';
import { AppConfig, CONFIG } from './config';

const LIMIT = Number(process.env.CLOCK_RATE_LIMIT ?? 20);
const clockLimit = Throttle({ default: { limit: LIMIT, ttl: 60_000 } });
const ctxOf = (req: Request) => ({ ip: req.ip, ua: req.headers['user-agent'] as string | undefined, correlationId: (req as any).correlationId as string | undefined });
const userOf = (req: Request) => (req as any).user as AuthUser;

@Controller('v1')
@UseGuards(JwtGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly svc: AttendanceService, private readonly reports: WorkReportsService, private readonly tasks: TasksService) {}

  // worker
  @Get('attendance/state') state(@Req() req: Request) { return this.svc.state(userOf(req)); }
  @Roles('worker') @Get('attendance/issues')
  workerIssues(@Req() req: Request) { return this.svc.workerIssues(userOf(req)); }
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
  @Roles('worker') @Post('attendance/exceptions') @HttpCode(201)
  createException(@Body() dto: CreateExceptionDto, @Req() req: Request) {
    return this.svc.createException(userOf(req), dto, req.ip, (req as any).correlationId);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Get('attendance/exceptions')
  ownExceptions(@Req() req: Request, @Query('status') status?: string) {
    return this.svc.listExceptions(userOf(req), status);
  }
  @Roles('supervisor', 'management', 'admin') @Get('team/attendance/exceptions')
  teamExceptions(@Req() req: Request, @Query('status') status?: string) {
    return this.svc.listExceptions(userOf(req), status);
  }
  @Roles('supervisor', 'management', 'admin') @Post('team/attendance/exceptions/:id/review') @HttpCode(200)
  reviewException(@Param('id') id: string, @Body() dto: ReviewExceptionDto, @Req() req: Request) {
    return this.svc.reviewException(userOf(req), id, dto, req.ip, (req as any).correlationId);
  }
  @Roles('management', 'admin') @Post('team/attendance/exceptions/:id/override') @HttpCode(200)
  overrideException(@Param('id') id: string, @Body() dto: OverrideExceptionDto, @Req() req: Request) {
    return this.svc.overrideException(userOf(req), id, dto, req.ip, (req as any).correlationId);
  }
  @Roles('supervisor', 'management', 'admin') @Post('attendance/sessions/:sessionId/verifications') @HttpCode(201)
  createPhysicalVerification(@Param('sessionId') sessionId: string, @Body() dto: PhysicalVerificationDto, @Req() req: Request) {
    return this.svc.createPhysicalVerification(userOf(req), sessionId, dto, req.ip, (req as any).correlationId);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Get('attendance/sessions/:sessionId/verifications')
  physicalVerifications(@Param('sessionId') sessionId: string, @Req() req: Request) {
    return this.svc.physicalVerifications(userOf(req), sessionId);
  }
  @Roles('supervisor', 'management', 'admin') @Post('attendance/exceptions/:id/verifications') @HttpCode(201)
  createExceptionVerification(@Param('id') id: string, @Body() dto: PhysicalVerificationDto, @Req() req: Request) {
    return this.svc.createExceptionPhysicalVerification(userOf(req), id, dto, req.ip, (req as any).correlationId);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Get('attendance/exceptions/:id/verifications')
  exceptionVerifications(@Param('id') id: string, @Req() req: Request) {
    return this.svc.exceptionVerifications(userOf(req), id);
  }
  @Roles('management', 'admin') @Get('team/attendance/physical-verification-issues')
  physicalVerificationIssues(@Req() req: Request) {
    return this.svc.physicalVerificationIssues(userOf(req));
  }
  @Roles('worker') @Post('work-reports') @HttpCode(201)
  createWorkReport(@Body() dto: WorkReportDto, @Req() req: Request) {
    return this.reports.saveDraft(userOf(req), dto, undefined, req.ip, (req as any).correlationId);
  }
  @Roles('worker') @Put('work-reports/:id')
  updateWorkReport(@Param('id') id: string, @Body() dto: WorkReportDto, @Req() req: Request) {
    return this.reports.saveDraft(userOf(req), dto, id, req.ip, (req as any).correlationId);
  }
  @Roles('worker') @Post('work-reports/:id/submit') @HttpCode(200)
  submitWorkReport(@Param('id') id: string, @Req() req: Request) {
    return this.reports.submit(userOf(req), id, req.ip, (req as any).correlationId);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Get('work-reports')
  workReports(@Req() req: Request, @Query('date') date?: string, @Query('status') status?: string) {
    return this.reports.listReports(userOf(req), date, status);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Get('work-reports/:id')
  workReport(@Param('id') id: string, @Req() req: Request) {
    return this.reports.getReport(userOf(req), id);
  }
  @Roles('supervisor', 'management', 'admin') @Post('work-reports/:id/review') @HttpCode(200)
  reviewWorkReport(@Param('id') id: string, @Body() dto: WorkReportReviewDto, @Req() req: Request) {
    return this.reports.review(userOf(req), id, dto, req.ip, (req as any).correlationId);
  }
  @Roles('management', 'admin') @Get('management/insights')
  managementInsights(@Req() req: Request, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.insights(userOf(req), from, to);
  }
  @Roles('management', 'admin') @Get('management/reports/export.csv')
  async exportReports(@Req() req: Request, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const result = await this.reports.exportCsv(userOf(req), from, to);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="daily-work-reports-${result.from}-to-${result.to}.csv"`);
    res.send(result.csv);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Get('tasks')
  tasksList(@Req() req: Request, @Query('status') status?: string) { return this.tasks.list(userOf(req), status); }
  @Roles('supervisor', 'management', 'admin') @Post('tasks') @HttpCode(201)
  createTask(@Body() dto: CreateTaskDto, @Req() req: Request) {
    return this.tasks.create(userOf(req), dto, req.ip, (req as any).correlationId);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Get('tasks/:id')
  task(@Param('id') id: string, @Req() req: Request) { return this.tasks.get(userOf(req), id); }
  @Roles('supervisor', 'management', 'admin') @Put('tasks/:id')
  updateTask(@Param('id') id: string, @Body() dto: UpdateTaskDto, @Req() req: Request) {
    return this.tasks.update(userOf(req), id, dto, req.ip, (req as any).correlationId);
  }
  @Roles('worker', 'supervisor', 'management', 'admin') @Post('tasks/:id/progress') @HttpCode(200)
  updateTaskProgress(@Param('id') id: string, @Body() dto: TaskProgressDto, @Req() req: Request) {
    return this.tasks.updateProgress(userOf(req), id, dto, req.ip, (req as any).correlationId);
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
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Get('health') async health() { await this.db.query('SELECT 1'); return { status: 'ok' }; }
  @Get('healthz') healthz() { return { status: 'ok' }; }
  @Get('readyz')
  async readyz() {
    try {
      await this.db.query('SELECT 1');
      const response = await fetch(this.cfg.jwksUrl, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Identity JWKS returned ${response.status}`);
      const body = await response.json() as { keys?: Array<{ kty?: string; crv?: string }> };
      if (!body.keys?.some((key) => key.kty === 'OKP' && key.crv === 'Ed25519')) throw new Error('Identity JWKS has no Ed25519 key');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Attendance service is not ready.');
    }
  }
}
