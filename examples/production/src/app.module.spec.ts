import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { WebTransportHealthService } from 'nest-webtransport';
import { TestClient, VirtualWebTransportDriver } from 'nest-webtransport-testing';
import { describe, expect, it, vi } from 'vitest';

import { AppModule } from './app.module.js';
import type { ProductionConfig } from './config.js';
import { OperationsServer } from './operations-server.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RedisPresenceService } from './redis-presence.service.js';

const config: ProductionConfig = {
  webTransportHost: '127.0.0.1',
  webTransportPort: 0,
  certificatePath: '/unused',
  privateKeyPath: '/unused',
  allowedOrigins: ['https://app.example.com'],
  jwtSecret: 'a-secure-test-secret-with-32-bytes',
  jwtIssuer: 'https://auth.example.com',
  jwtAudience: 'webtransport',
  redisUrl: 'redis://127.0.0.1:6379',
  operationsHost: '127.0.0.1',
  operationsPort: 0,
};

function token(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'user-1',
      iss: config.jwtIssuer,
      aud: config.jwtAudience,
      exp: Math.floor(Date.now() / 1_000) + 60,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url')}`;
}

describe('production application bootstrap', () => {
  it('resolves real Nest providers, serves probes and metrics, and handles an authenticated session', async () => {
    const driver = new VirtualWebTransportDriver();
    const presence = {
      isReady: true,
      hasFailed: false,
      markConnected: vi.fn().mockResolvedValue(undefined),
      markDisconnected: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    const app = await Test.createTestingModule({ imports: [AppModule.register(config, driver)] })
      .overrideProvider(RedisPresenceService)
      .useValue(presence)
      .compile();
    try {
      await app.init();
      expect(app.get(RealtimeGateway)).toBeInstanceOf(RealtimeGateway);
      expect(app.get(WebTransportHealthService).getStatus().ready).toBe(true);
      const server = (app.get(OperationsServer) as unknown as { server: Server }).server;
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${url}/readyz`)).status).toBe(200);
      const session = await new TestClient(driver).connect('/realtime', {
        origin: 'https://app.example.com',
        authorization: `Bearer ${token()}`,
      });
      await vi.waitFor(() => expect(presence.markConnected).toHaveBeenCalledOnce());
      await session.sendDatagram(Uint8Array.of(1));
      await vi.waitFor(() => expect(presence.refresh).toHaveBeenCalledOnce());
      const metrics = await (await fetch(`${url}/metrics`)).text();
      expect(metrics).toContain('webtransport_runtime_sessions_accepted_total 1');
      expect(metrics).toContain('webtransport_redis_ready 1');
      presence.isReady = false;
      expect((await fetch(`${url}/readyz`)).status).toBe(503);
      expect((await fetch(`${url}/livez`)).status).toBe(200);
      presence.hasFailed = true;
      expect((await fetch(`${url}/livez`)).status).toBe(503);
      await session.close();
      await vi.waitFor(() => expect(presence.markDisconnected).toHaveBeenCalledOnce());
    } finally {
      await app.close();
    }
  });
});
