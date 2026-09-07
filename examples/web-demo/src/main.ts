import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule, webDemoConfig } from './app.module.js';

const logger = new Logger('WebDemo');

try {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  logger.log(`Open ${webDemoConfig.pageOrigins.join(' or ')}`);
  logger.log(`WebTransport ${webDemoConfig.webTransportPublicUrl}`);
} catch (error) {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
