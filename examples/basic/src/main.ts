import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { basicExampleConfig } from './config.js';

const bootstrapLogger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });
  application.enableShutdownHooks(['SIGINT', 'SIGTERM']);

  bootstrapLogger.log(
    `WebTransport listening on https://${basicExampleConfig.host}:${basicExampleConfig.port}/basic`,
  );
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  bootstrapLogger.error(message);
  (globalThis as typeof globalThis & { process: { exitCode: number } }).process.exitCode = 1;
});
