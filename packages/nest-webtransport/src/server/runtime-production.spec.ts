import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type {
  SessionContext,
  WebTransportBidirectionalStream,
  WebTransportSession,
} from 'webtransport-core';
import { TestClient, VirtualWebTransportDriver } from '../../../testing/src/index.js';
import { WebTransportGateway } from '../decorators/gateway.decorator.js';
import { OnBidirectionalStream, OnDatagram, OnSession } from '../decorators/handler.decorator.js';
import {
  Payload,
  Session,
  Stream,
  WebTransportContext,
} from '../decorators/parameter.decorator.js';
import type { WebTransportModuleOptions } from '../interfaces/module-options.interface.js';
import { WebTransportModule } from '../webtransport.module.js';
import { WebTransportHealthService } from './webtransport-health.service.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await tick();
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
@WebTransportGateway('/budget')
class BudgetGateway {
  readonly values: number[] = [];
  hold = Promise.resolve();
  @OnBidirectionalStream() stream(@Stream() stream: WebTransportBidirectionalStream) {
    return stream.readable.pipeTo(stream.writable);
  }
  @OnSession() connected() {}
  @OnDatagram() async packet(@Payload() value: Uint8Array) {
    this.values.push(value[0] ?? 0);
    await this.hold;
  }
}
async function fixture(overrides: Partial<WebTransportModuleOptions> = {}) {
  const driver = new VirtualWebTransportDriver();
  const module = await Test.createTestingModule({
    imports: [
      WebTransportModule.forRoot({
        driver,
        server: { port: 0 },
        security: { requireOrigin: false },
        shutdown: { drainTimeoutMs: 20, forceCloseTimeoutMs: 100 },
        ...overrides,
      }),
    ],
    providers: [BudgetGateway],
  }).compile();
  await module.init();
  return {
    module,
    driver,
    client: new TestClient(driver),
    gateway: module.get(BudgetGateway),
    health: module.get(WebTransportHealthService),
  };
}

describe('aggregate production limits', () => {
  it('bounds work across sessions and retains capacity for disconnected running work', async () => {
    const f = await fixture({
      limits: { server: { maxConcurrentHandlers: 1, maxPendingHandlers: 1 } },
    });
    const hold = deferred();
    try {
      const first = await f.client.connect('/budget');
      const second = await f.client.connect('/budget');
      const third = await f.client.connect('/budget');
      f.gateway.hold = hold.promise;
      await first.sendDatagram(new Uint8Array([1]));
      await until(() => f.gateway.values.length === 1);
      await second.sendDatagram(new Uint8Array([2]));
      await until(() => f.health.getRuntimeStats().handlers.outstanding === 2);
      await third.sendDatagram(new Uint8Array([3]));
      await until(() => f.health.getRuntimeStats().handlers.rejected === 1);
      expect(f.gateway.values).toEqual([1]);
      expect(f.health.getRuntimeStats().handlers.active).toBe(1);
      await first.close();
      expect(f.health.getRuntimeStats().handlers.outstanding).toBe(2);
      hold.resolve();
      await until(() => f.health.getRuntimeStats().handlers.outstanding === 0);
      expect(f.gateway.values).toEqual([1, 2]);
      expect(f.health.getRuntimeStats().datagrams.queuedBytes).toBe(0);
    } finally {
      hold.resolve();
      await f.module.close();
    }
  });

  it('charges scheduler-pending bytes and releases discarded reservations on disconnect', async () => {
    const f = await fixture({
      execution: { maxConcurrentHandlers: 1, maxPendingHandlers: 1 },
      limits: { server: { maxQueuedDatagramBytes: 2 } },
    });
    const hold = deferred();
    f.gateway.hold = hold.promise;
    try {
      const client = await f.client.connect('/budget');
      await client.sendDatagram(new Uint8Array([1]));
      await until(() => f.gateway.values.length === 1);
      await client.sendDatagram(new Uint8Array([2]));
      await until(() => f.health.getRuntimeStats().handlers.outstanding === 2);
      await client.sendDatagram(new Uint8Array([3]));
      await until(() => f.health.getRuntimeStats().datagrams.dropped === 1);
      expect(f.health.getRuntimeStats().datagrams).toMatchObject({
        queuedBytes: 2,
        drops: { 'server-byte-limit': 1 },
      });
      await client.close();
      expect(f.health.getRuntimeStats().handlers.outstanding).toBe(1);
      expect(f.health.getRuntimeStats().datagrams.queuedBytes).toBe(1);
      hold.resolve();
      await until(() => f.health.getRuntimeStats().handlers.outstanding === 0);
      expect(f.health.getRuntimeStats().datagrams.queuedBytes).toBe(0);
    } finally {
      hold.resolve();
      await f.module.close();
    }
  });

  it('shares the budget with authentication and cancels queued admission on disconnect', async () => {
    const hold = deferred();
    let calls = 0;
    const f = await fixture({
      limits: { server: { maxConcurrentHandlers: 1, maxPendingHandlers: 1 } },
      security: {
        requireOrigin: false,
        handshakeTimeoutMs: 20,
        authenticate: async () => {
          calls++;
          await hold.promise;
          return true;
        },
      },
    });
    try {
      const one = f.client.connect('/budget');
      await until(() => calls === 1);
      const two = f.client.connect('/budget');
      await until(() => f.health.getRuntimeStats().handlers.outstanding === 2);
      const three = await f.client.connect('/budget');
      expect(three.signal.aborted).toBe(true);
      expect((await one).signal.aborted).toBe(true);
      expect((await two).signal.aborted).toBe(true);
      expect(calls).toBe(1);
      expect(f.health.getRuntimeStats().handlers.outstanding).toBe(1);
      hold.resolve();
      await until(() => f.health.getRuntimeStats().handlers.outstanding === 0);
      expect(f.health.getRuntimeStats().sessions.rejected).toBe(3);
    } finally {
      hold.resolve();
      await f.module.close();
    }
  });

  it('counts all drops while bounding log callbacks under overload', async () => {
    let logs = 0;
    const f = await fixture({
      observability: { maxLogsPerSecond: 4 },
      logger: () => {
        logs++;
      },
      limits: { session: { maxDatagramsPerSecond: 1 } },
    });
    try {
      const client = await f.client.connect('/budget');
      for (let i = 0; i < 50; i++) await client.sendDatagram(new Uint8Array([i]));
      await until(() => f.health.getRuntimeStats().datagrams.dropped === 49);
      expect(logs).toBeLessThanOrEqual(4);
      expect(f.health.getRuntimeStats().logs.suppressed).toBeGreaterThan(40);
      expect(f.health.getRuntimeStats().datagrams.drops['rate-limit']).toBe(49);
    } finally {
      await f.module.close();
    }
  });
});

@WebTransportGateway('/manual')
class ManualGateway {
  values = 0;
  @OnSession() connected(
    @Session() session: WebTransportSession,
    @WebTransportContext() context: SessionContext,
  ) {
    const reader = session.datagrams.readable.getReader();
    void (async () => {
      try {
        while (!session.signal.aborted) {
          const { done } = await reader.read();
          if (done) break;
          this.values++;
          context.touch?.();
        }
      } finally {
        reader.releaseLock();
      }
    })().catch(() => {});
  }
}
it('keeps application-owned I/O alive with context.touch, then expires idle sessions', async () => {
  const driver = new VirtualWebTransportDriver();
  const module = await Test.createTestingModule({
    imports: [
      WebTransportModule.forRoot({
        driver,
        server: { port: 0 },
        security: { requireOrigin: false, idleTimeoutMs: 60 },
      }),
    ],
    providers: [ManualGateway],
  }).compile();
  await module.init();
  try {
    const client = await new TestClient(driver).connect('/manual');
    for (let i = 0; i < 10; i++) {
      await client.sendDatagram(new Uint8Array([i]));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(client.signal.aborted).toBe(false);
    }
    expect(module.get(ManualGateway).values).toBe(10);
    await until(() => client.signal.aborted);
    expect(client.closeInfo?.reason).toBe('Session idle timeout');
  } finally {
    await module.close();
  }
});

it('enforces active stream capacity across sessions and returns it on closure', async () => {
  const f = await fixture({ limits: { server: { maxStreams: 1 } } });
  try {
    const first = await f.client.connect('/budget');
    const second = await f.client.connect('/budget');
    const stream = await first.createBidirectionalStream();
    await tick();
    const excess = await second.createBidirectionalStream();
    await until(() => excess.signal.aborted);
    expect(stream.signal.aborted).toBe(false);
    await first.close();
    const replacement = await second.createBidirectionalStream();
    await tick();
    expect(replacement.signal.aborted).toBe(false);
    await replacement.reset();
  } finally {
    await f.module.close();
  }
});

it('applies drop-oldest at the aggregate byte ceiling using net replacement size', async () => {
  const f = await fixture({
    execution: { maxConcurrentHandlers: 1, maxPendingHandlers: 0 },
    datagrams: { queue: { size: 1, overflow: 'drop-oldest' } },
    limits: { server: { maxQueuedDatagramBytes: 2 } },
  });
  const hold = deferred();
  f.gateway.hold = hold.promise;
  try {
    const client = await f.client.connect('/budget');
    await client.sendDatagram(new Uint8Array([1]));
    await until(() => f.gateway.values.length === 1);
    await client.sendDatagram(new Uint8Array([2]));
    await client.sendDatagram(new Uint8Array([3]));
    await until(() => f.health.getRuntimeStats().datagrams.dropped === 1);
    expect(f.health.getRuntimeStats().datagrams.drops['dropped-oldest']).toBe(1);
    expect(f.health.getRuntimeStats().datagrams.queuedBytes).toBe(2);
    hold.resolve();
    await until(() => f.gateway.values.length === 2);
    expect(f.gateway.values).toEqual([1, 3]);
  } finally {
    hold.resolve();
    await f.module.close();
  }
});

it('does not invoke a gateway after an asynchronous route resolver outlives its session', async () => {
  const hold = deferred();
  let resolving = false;
  const f = await fixture({
    routing: {
      datagram: async (value) => {
        resolving = true;
        await hold.promise;
        return { value };
      },
    },
  });
  try {
    const client = await f.client.connect('/budget');
    await client.sendDatagram(new Uint8Array([1]));
    await until(() => resolving);
    await client.close();
    hold.resolve();
    await until(() => f.health.getRuntimeStats().handlers.outstanding === 0);
    expect(f.gateway.values).toEqual([]);
    expect(f.health.getRuntimeStats().datagrams.queuedBytes).toBe(0);
  } finally {
    hold.resolve();
    await f.module.close();
  }
});

it('contains asynchronous logger and private diagnostic failures', async () => {
  let diagnostics = 0;
  const f = await fixture({
    logger: async () => {
      throw new Error('logger failed');
    },
    observability: {
      onError: async () => {
        diagnostics++;
        throw new Error('diagnostic failed');
      },
    },
    routing: {
      datagram: () => {
        throw new Error('application secret');
      },
    },
  });
  try {
    const client = await f.client.connect('/budget');
    await client.sendDatagram(new Uint8Array([1]));
    await until(() => diagnostics === 1);
    await tick();
    expect(client.signal.aborted).toBe(false);
    expect(f.health.getStatus().ready).toBe(true);
  } finally {
    await f.module.close();
  }
});
