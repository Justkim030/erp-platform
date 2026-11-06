import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, NotFoundException, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig, CONFIG } from './config';
import { ipInCidr } from './net';
import { Role, TokenService, same } from './security';

export interface AuthUser { sub: string; tid: string; role: Role }
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const p = await this.tokens.verifyAccess(header.slice(7));
      req.user = { sub: p.sub, tid: p.tid, role: p.role } as AuthUser;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Role[]>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}

/** Guards the platform-owner endpoints. Answers 404 on any failure so the routes stay hidden. */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const token = req.headers['x-bootstrap-token'];
    const tokenOk = !!this.cfg.bootstrapToken && typeof token === 'string' && same(token, this.cfg.bootstrapToken);
    const ipOk = !this.cfg.platformAllowedIps.length || this.cfg.platformAllowedIps.some((c) => ipInCidr(req.ip, c));
    if (!tokenOk || !ipOk) throw new NotFoundException();
    return true;
  }
}
