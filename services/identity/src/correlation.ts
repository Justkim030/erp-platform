import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

/**
 * Correlation IDs: one id per request, propagated from the caller when present
 * (x-correlation-id), otherwise minted here. Echoed back in the response header
 * and attached to the request so services and audit records can include it.
 * The Portal forwards the incoming id to services, so one user action can be
 * traced across Portal -> Identity/Attendance.
 */
export function correlationIdOf(req: Request): string {
  const incoming = req.headers['x-correlation-id'];
  return typeof incoming === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(incoming)
    ? incoming
    : randomUUID();
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const id = correlationIdOf(req);
    (req as any).correlationId = id;
    res.setHeader('x-correlation-id', id);
    next();
  }
}
