import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { correlationId?: string }>();
    const res = ctx.getResponse<Response>();
    const correlationId = req.correlationId ?? 'unknown';
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const detail = exception instanceof HttpException ? exception.getResponse() : { message: 'Internal server error' };
    const body = typeof detail === 'string' ? { statusCode: status, message: detail } : detail;

    if (status >= 500) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`Request failed (${correlationId}): ${error.message}`, error.stack);
    }

    res.status(status).json({
      ...(typeof body === 'object' && body !== null ? body : { message: 'Internal server error' }),
      correlationId,
    });
  }
}
