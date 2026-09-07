import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { WebTransportHealthService } from 'nest-webtransport';

import type { ProductionConfig } from './config.js';
import type { RedisPresenceService } from './redis-presence.service.js';
import { PRODUCTION_CONFIG } from './tokens.js';

@Injectable()
export class OperationsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: Server | undefined;

  constructor(
    @Inject(PRODUCTION_CONFIG) private readonly config: ProductionConfig,
    private readonly health: WebTransportHealthService,
    private readonly presence: RedisPresenceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = createServer((request, response) => {
      switch (request.url) {
        case '/livez':
          this.json(response, this.health.getStatus().alive ? 200 : 503, {
            alive: this.health.getStatus().alive,
          });
          break;
        case '/readyz': {
          const transport = this.health.getStatus();
          const ready = transport.ready && this.presence.isReady;
          this.json(response, ready ? 200 : 503, {
            ready,
            transport,
            redis: this.presence.isReady,
          });
          break;
        }
        case '/metrics':
          this.metrics(response);
          break;
        default:
          this.json(response, 404, { error: 'not_found' });
      }
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.operationsPort, this.config.operationsHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(value));
  }

  private metrics(response: ServerResponse): void {
    const stats = this.health.getDriverStats();
    const values = [
      ['webtransport_sessions_active', 'gauge', stats.sessions.active],
      ['webtransport_sessions_total', 'counter', stats.sessions.total],
      ['webtransport_sessions_rejected', 'counter', stats.sessions.rejected],
      ['webtransport_streams_active', 'gauge', stats.streams.active],
      ['webtransport_streams_total', 'counter', stats.streams.total],
      ['webtransport_datagrams_received', 'counter', stats.datagrams.received],
      ['webtransport_datagrams_sent', 'counter', stats.datagrams.sent],
      ['webtransport_datagrams_dropped', 'counter', stats.datagrams.dropped],
      ['webtransport_bytes_received', 'counter', stats.bytes.received],
      ['webtransport_bytes_sent', 'counter', stats.bytes.sent],
    ] as const;
    const body = `${values
      .map(([name, type, value]) => `# TYPE ${name} ${type}\n${name} ${value}`)
      .join('\n')}\n`;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    response.end(body);
  }
}
