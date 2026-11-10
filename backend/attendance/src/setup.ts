import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppConfig } from './config';
import { CorrelationIdMiddleware } from './correlation';
import { ApiExceptionFilter } from './http-exception.filter';

export function configureApp(app: INestApplication, cfg: AppConfig) {
  app.use(helmet());
  app.use(new CorrelationIdMiddleware().use as any);
  app.useGlobalFilters(new ApiExceptionFilter());
  if (cfg.trustProxy) {
    // Needed so req.ip is the real client address behind a proxy. Set only to the number of proxies you control.
    (app.getHttpAdapter().getInstance() as any).set('trust proxy', /^\d+$/.test(cfg.trustProxy) ? Number(cfg.trustProxy) : cfg.trustProxy);
  }
  app.enableCors({ origin: cfg.corsOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  return app;
}
