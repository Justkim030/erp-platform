import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { AppConfig, CONFIG } from './config';

export type Role = 'worker' | 'supervisor' | 'management' | 'admin';
export interface AuthUser { sub: string; tid: string; role: Role; token: string }
export const JWKS = 'JWKS';
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

/** Verifies Identity's access tokens locally with its public key. No call to Identity per request. */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(@Inject(JWKS) private readonly jwks: any, @Inject(CONFIG) private readonly cfg: AppConfig) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const { payload } = await jwtVerify(h.slice(7), this.jwks, { issuer: this.cfg.issuer, audience: this.cfg.audience, algorithms: ['EdDSA'] });
      req.user = { sub: payload.sub, tid: (payload as any).tid, role: (payload as any).role, token: h.slice(7) } as AuthUser;
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
