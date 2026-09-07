import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { type WebTransportBidirectionalStream, WebTransportError } from 'webtransport-core';
import { TestClient, VirtualWebTransportDriver } from '../../testing/src/index.js';
import { WebTransportGateway } from './decorators/gateway.decorator.js';
import { OnBidirectionalStream, OnDatagram, OnSession } from './decorators/handler.decorator.js';
import { Payload, Stream } from './decorators/parameter.decorator.js';
import type { WebTransportModuleOptions } from './interfaces/module-options.interface.js';
import { WebTransportHealthService } from './server/webtransport-health.service.js';
import { WebTransportModule } from './webtransport.module.js';

@WebTransportGateway('/limits')
class LimitedGateway {
  packets: number[] = [];
  hold: Promise<void> = Promise.resolve();
  scope: 'HANDLER' | 'STREAM' | 'SESSION' | 'SERVER' | undefined;
  @OnSession() connect() {}
  @OnDatagram() async packet(@Payload() payload: Uint8Array) {
    this.packets.push(payload[0] ?? 0);
    await this.hold;
  }
  @OnBidirectionalStream() async stream(@Stream() stream: WebTransportBidirectionalStream) {
    if (this.scope) throw new WebTransportError('fixture', { code: 'TEST', scope: this.scope });
    await stream.readable.pipeTo(stream.writable);
  }
}

async function fixture(options: Partial<WebTransportModuleOptions> = {}) {
  const driver = new VirtualWebTransportDriver();
  const module = await Test.createTestingModule({
    imports: [
      WebTransportModule.forRoot({
        driver,
        server: { port: 0 },
        security: { requireOrigin: false },
        shutdown: { drainTimeoutMs: 20, forceCloseTimeoutMs: 100 },
        ...options,
      }),
    ],
    providers: [LimitedGateway],
  }).compile();
  await module.init();
  return {
    module,
    client: new TestClient(driver),
    gateway: module.get(LimitedGateway),
    health: module.get(WebTransportHealthService),
  };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('runtime admission policy', () => {
  it.each([
    { security: { requireOrigin: true, allowedOrigins: ['https://allowed.invalid'] } },
    { security: { requireOrigin: false, maxHeaderSize: 8 } },
    { security: { requireOrigin: false, authenticate: () => false } },
  ])('rejects invalid admission without invoking the gateway %#', async (options) => {
    const f = await fixture(options);
    try {
      const client = await f.client.connect('/limits', { authorization: 'Bearer oversized' });
      expect(client.signal.aborted).toBe(true);
      expect(f.health.getStatus().activeSessions).toBe(0);
    } finally {
      await f.module.close();
    }
  });
  it.each([{ limits: { server: { maxSessions: 1 } } }, { limits: { ip: { maxSessions: 1 } } }])(
    'enforces connection capacity and returns it on close %#',
    async (options) => {
      const f = await fixture(options);
      try {
        const first = await f.client.connect('/limits');
        const second = await f.client.connect('/limits');
        expect(second.signal.aborted).toBe(true);
        await first.close();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const third = await f.client.connect('/limits');
        expect(third.signal.aborted).toBe(false);
      } finally {
        await f.module.close();
      }
    },
  );
});

describe('datagram pressure', () => {
  it('drops oversized/rate-limited packets before dispatch', async () => {
    const f = await fixture({
      security: { requireOrigin: false, maxDatagramSize: 2 },
      limits: { session: { maxDatagramsPerSecond: 1 } },
    });
    try {
      const client = await f.client.connect('/limits');
      await client.sendDatagram(new Uint8Array([9, 9, 9]));
      await client.sendDatagram(new Uint8Array([1]));
      await client.sendDatagram(new Uint8Array([2]));
      await until(() => f.gateway.packets.length === 1);
      expect(f.gateway.packets).toEqual([1]);
    } finally {
      await f.module.close();
    }
  });
  it.each(['drop-oldest', 'drop-newest', 'reject', 'close-session'] as const)(
    'bounds datagrams with %s policy',
    async (overflow) => {
      let release!: () => void;
      const f = await fixture({
        execution: { maxConcurrentHandlers: 1, maxPendingHandlers: 0 },
        datagrams: { queue: { size: 1, overflow } },
      });
      f.gateway.hold = new Promise((resolve) => {
        release = resolve;
      });
      try {
        const client = await f.client.connect('/limits');
        await client.sendDatagram(new Uint8Array([1]));
        await until(() => f.gateway.packets.length === 1);
        await client.sendDatagram(new Uint8Array([2]));
        await client.sendDatagram(new Uint8Array([3]));
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(f.gateway.packets).toEqual([1]);
        release();
        if (overflow === 'close-session') {
          await until(() => client.signal.aborted);
        } else {
          await until(() => f.gateway.packets.length === 2);
          expect(f.gateway.packets).toEqual([1, overflow === 'drop-oldest' ? 3 : 2]);
        }
      } finally {
        release();
        await f.module.close();
      }
    },
  );
});

describe('stream limits and error isolation', () => {
  it('rejects excess streams and resets stalled streams by lifetime', async () => {
    const f = await fixture({
      limits: { session: { maxBidirectionalStreams: 1 }, stream: { maxLifetimeMs: 25 } },
    });
    try {
      const client = await f.client.connect('/limits');
      const first = await client.createBidirectionalStream();
      const second = await client.createBidirectionalStream();
      await until(() => second.signal.aborted);
      await until(() => first.signal.aborted);
      expect(client.signal.aborted).toBe(false);
    } finally {
      await f.module.close();
    }
  });
  it.each(['HANDLER', 'STREAM', 'SESSION', 'SERVER'] as const)(
    'honors %s error scope',
    async (scope) => {
      const f = await fixture();
      f.gateway.scope = scope;
      try {
        const client = await f.client.connect('/limits');
        const stream = await client.createBidirectionalStream();
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (scope === 'HANDLER') expect(client.signal.aborted).toBe(false);
        if (scope === 'STREAM') {
          expect(stream.signal.aborted).toBe(true);
          expect(client.signal.aborted).toBe(false);
        }
        if (scope === 'SESSION' || scope === 'SERVER') await until(() => client.signal.aborted);
        if (scope === 'SERVER') await until(() => !f.health.getStatus().ready);
      } finally {
        await f.module.close();
      }
    },
  );
});
