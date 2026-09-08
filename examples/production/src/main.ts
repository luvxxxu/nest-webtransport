import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { loadProductionConfig } from './config.js';

const app = await NestFactory.createApplicationContext(AppModule.register(loadProductionConfig()), {
  logger: ['error', 'warn', 'log'],
});
app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
