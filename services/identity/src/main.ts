import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG, AppConfig, validateProductionConfig } from './config';
import { configureApp } from './setup';
import { logger } from './log';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger });
  const cfg = app.get<AppConfig>(CONFIG);

  // Production must not start with missing or unsafe configuration.
  const problems = validateProductionConfig(cfg);
  if (problems.length) {
    for (const p of problems) logger.error(`STARTUP BLOCKED: ${p}`);
    process.exit(1);
  }

  logger.log(`env=${cfg.env} database=${describeDb(cfg.databaseUrl)} port=${cfg.port}`);
  configureApp(app, cfg);
  app.enableShutdownHooks();
  await app.listen(cfg.port);
}

/** Human-readable database description for the startup banner. Never logs credentials. */
function describeDb(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.slice(1)}`;
  } catch {
    return 'unknown';
  }
}
bootstrap();
