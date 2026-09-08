import { once } from 'node:events';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';

import type { WebDemoConfig } from './config.js';
import { SessionTicketStore } from './session-ticket.store.js';
import { StaticServer } from './static-server.service.js';

const config: WebDemoConfig = {
  httpHost: '127.0.0.1',
  httpPort: 0,
  pageOrigins: ['http://localhost:3000'],
  webTransportHost: '127.0.0.1',
  webTransportPort: 4433,
  webTransportPublicUrl: 'https://127.0.0.1:4433/demo',
  certificatePath: 'unused',
  privateKeyPath: 'unused',
  certificateSha256: undefined,
  authToken: 'test-token-for-http-session-tickets',
};

function port(service: StaticServer): number {
  const address = (Reflect.get(service, 'server') as Server).address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  return address.port;
}

describe('demo HTTP server', () => {
  it('returns retryable service unavailable when ticket capacity is exhausted', async () => {
    const service = new StaticServer(config, new SessionTicketStore(10_000, 0));
    await service.onApplicationBootstrap();
    try {
      const response = await fetch(`http://127.0.0.1:${port(service)}/session-ticket`, {
        method: 'POST',
        headers: {
          origin: config.pageOrigins[0] ?? '',
          authorization: `Bearer ${config.authToken}`,
        },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      await response.text();
    } finally {
      await service.onApplicationShutdown();
    }
  });

  it('closes incomplete HTTP connections within the shutdown deadline', async () => {
    const service = new StaticServer(config, new SessionTicketStore());
    await service.onApplicationBootstrap();
    const socket = createConnection({ host: '127.0.0.1', port: port(service) });
    socket.on('error', () => {});
    await once(socket, 'connect');
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write('POST /config.json HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx');
    await once(socket, 'data');
    const started = Date.now();
    try {
      await service.onApplicationShutdown();
      await closed;
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      socket.destroy();
      await service.onApplicationShutdown();
    }
  });
});
