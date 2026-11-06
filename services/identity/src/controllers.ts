import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AdminService } from './admin.service';
import { AuthService } from './auth.service';
import { Db } from './db';
import { ActivateDto, CreateUserDto, DepartmentDto, ForgotDto, LoginDto, PlatformOrgDto, PlatformUserDto, ReassignDto, RefreshDto, ResetDto, StatusChangeDto } from './dto';
import { AuthUser, JwtGuard, PlatformGuard, Roles, RolesGuard } from './guards';
import { TokenService } from './security';

const AUTH_LIMIT = Number(process.env.AUTH_RATE_LIMIT ?? 10);
const strict = Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } });
const ctxOf = (req: Request) => ({ ip: req.ip, ua: req.headers['user-agent'] as string | undefined, correlationId: (req as any).correlationId as string | undefined });
const userOf = (req: Request) => (req as any).user as AuthUser;

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @strict @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) { return this.auth.login(dto, ctxOf(req)); }

  @strict @Post('activate') @HttpCode(201)
  activate(@Body() dto: ActivateDto, @Req() req: Request) { return this.auth.activate(dto, ctxOf(req)); }

  @strict @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) { return this.auth.refresh(dto.refreshToken, ctxOf(req)); }

  @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto, @Req() req: Request) { await this.auth.logout(dto.refreshToken, ctxOf(req)); }

  @strict @Post('password/forgot') @HttpCode(202)
  async forgot(@Body() dto: ForgotDto, @Req() req: Request) { await this.auth.forgot(dto, ctxOf(req)); return { status: 'accepted' }; }

  @strict @Post('password/reset') @HttpCode(204)
  async reset(@Body() dto: ResetDto, @Req() req: Request) { await this.auth.reset(dto, ctxOf(req)); }
}

@Controller('v1')
export class UsersController {
  constructor(private readonly auth: AuthService, private readonly admin: AdminService) {}

  @UseGuards(JwtGuard) @Get('me')
  me(@Req() req: Request) { return this.auth.me(userOf(req).sub); }

  @UseGuards(JwtGuard, RolesGuard) @Roles('supervisor', 'management', 'admin') @Get('users')
  users(@Req() req: Request, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const p = page === undefined ? undefined : Math.max(Number(page) || 1, 1);
    const size = pageSize === undefined ? 50 : Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    return this.admin.listUsers(userOf(req), p, size);
  }

  @UseGuards(JwtGuard, RolesGuard) @Roles('supervisor', 'management', 'admin') @Post('users') @HttpCode(201)
  create(@Body() dto: CreateUserDto, @Req() req: Request) { return this.admin.createUser(userOf(req), dto, req.ip, (req as any).correlationId); }

  @UseGuards(JwtGuard, RolesGuard) @Roles('supervisor', 'management', 'admin') @Post('users/:id/reset-access') @HttpCode(201)
  reset(@Param('id') id: string, @Req() req: Request) { return this.admin.resetAccess(userOf(req), id, req.ip); }

  // ---- Stage 2: organisation structure (departments, reassignment, status)
  @UseGuards(JwtGuard, RolesGuard) @Roles('management', 'admin') @Get('departments')
  departments(@Req() req: Request, @Query('includeInactive') includeInactive?: string) {
    return this.admin.listDepartments(userOf(req), includeInactive === 'true');
  }
  @UseGuards(JwtGuard, RolesGuard) @Roles('management', 'admin') @Post('departments') @HttpCode(201)
  createDepartment(@Body() dto: DepartmentDto, @Req() req: Request) { return this.admin.saveDepartment(userOf(req), dto, undefined, req.ip, (req as any).correlationId); }
  @UseGuards(JwtGuard, RolesGuard) @Roles('management', 'admin') @Put('departments/:id')
  updateDepartment(@Param('id') id: string, @Body() dto: DepartmentDto, @Req() req: Request) { return this.admin.saveDepartment(userOf(req), dto, id, req.ip, (req as any).correlationId); }
  @UseGuards(JwtGuard, RolesGuard) @Roles('management', 'admin') @Post('departments/:id/deactivate') @HttpCode(200)
  deactivateDepartment(@Param('id') id: string, @Req() req: Request) { return this.admin.deactivateDepartment(userOf(req), id, req.ip); }

  @UseGuards(JwtGuard, RolesGuard) @Roles('management', 'admin') @Post('workers/:id/supervisor') @HttpCode(200)
  reassign(@Param('id') id: string, @Body() dto: ReassignDto, @Req() req: Request) { return this.admin.reassignWorker(userOf(req), id, dto, req.ip, (req as any).correlationId); }
  @UseGuards(JwtGuard, RolesGuard) @Roles('supervisor', 'management', 'admin') @Get('workers/:id/assignments')
  assignments(@Param('id') id: string, @Req() req: Request) { return this.admin.assignmentHistory(userOf(req), id); }

  @UseGuards(JwtGuard, RolesGuard) @Roles('management', 'admin') @Post('users/:id/status') @HttpCode(200)
  changeStatus(@Param('id') id: string, @Body() dto: StatusChangeDto, @Req() req: Request) { return this.admin.changeStatus(userOf(req), id, dto, req.ip, (req as any).correlationId); }
  @UseGuards(JwtGuard, RolesGuard) @Roles('supervisor', 'management', 'admin') @Get('users/:id/status-history')
  statusHistory(@Param('id') id: string, @Req() req: Request) { return this.admin.statusHistory(userOf(req), id); }
}

/** Platform-owner endpoints: not used by the UI, not documented publicly, answer 404 unless the bootstrap token (and optional IP allowlist) match. */
@Controller('v1/platform')
@UseGuards(PlatformGuard)
export class PlatformController {
  constructor(private readonly admin: AdminService) {}

  @strict @Post('organisations') @HttpCode(201)
  createOrg(@Body() dto: PlatformOrgDto, @Req() req: Request) { return this.admin.createOrganisation(dto, req.ip); }

  @strict @Post('organisations/:slug/users') @HttpCode(201)
  addUser(@Param('slug') slug: string, @Body() dto: PlatformUserDto, @Req() req: Request) { return this.admin.addPlatformUser(slug, dto, req.ip); }
}

@Controller()
export class SystemController {
  constructor(private readonly db: Db, private readonly tokens: TokenService) {}

  @Get('health')
  async health() { await this.db.query('SELECT 1'); return { status: 'ok' }; }

  /** Other services verify access tokens with this public key; they never call Identity per request. */
  @Get('.well-known/jwks.json')
  jwks() { return this.tokens.jwks(); }
}
