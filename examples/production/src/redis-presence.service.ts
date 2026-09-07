import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

import type { ProductionConfig } from './config.js';
import { PRODUCTION_CONFIG } from './tokens.js';

const PRESENCE_TTL_SECONDS = 120;

@Injectable()
export class RedisPresenceService implements OnModuleInit, OnApplicationShutdown {
  private readonly client: RedisClientType;
  private ready = false;

  constructor(@Inject(PRODUCTION_CONFIG) config: ProductionConfig) {
    this.client = createClient({ url: config.redisUrl });
    this.client.on('ready', () => {
      this.ready = true;
    });
    this.client.on('end', () => {
      this.ready = false;
    });
    this.client.on('error', () => {
      this.ready = false;
    });
  }

  get isReady(): boolean {
    return this.ready && this.client.isReady;
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  async markConnected(sessionId: string, userId: string): Promise<void> {
    await this.client.set(this.key(sessionId), userId, { EX: PRESENCE_TTL_SECONDS });
  }

  async refresh(sessionId: string): Promise<void> {
    await this.client.expire(this.key(sessionId), PRESENCE_TTL_SECONDS);
  }

  async markDisconnected(sessionId: string): Promise<void> {
    await this.client.del(this.key(sessionId));
  }

  private key(sessionId: string): string {
    return `webtransport:presence:${sessionId}`;
  }
}
