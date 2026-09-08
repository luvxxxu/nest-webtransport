import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type {
  DriverStopOptions,
  Unsubscribe,
  WebTransportDriver,
  WebTransportDriverCapabilities,
  WebTransportDriverStats,
  WebTransportServerOptions,
  WebTransportSessionCallback,
} from 'webtransport-core';

import { WebTransportModule } from '../webtransport.module.js';
import { WebTransportHealthService } from './webtransport-health.service.js';
import { WebTransportRuntime } from './webtransport-runtime.js';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const CAPABILITIES: WebTransportDriverCapabilities = {
  datagrams: true,
  bidirectionalStreams: true,
  unidirectionalStreams: true,
  gracefulShutdown: true,
  connectionStats: false,
  keyingMaterialExport: false,
};

class DeferredStartDriver implements WebTransportDriver {
  readonly capabilities = CAPABILITIES;
  readonly starts: Deferred[] = [];
  stopCalls = 0;
  stopFailures = 0;
  state: WebTransportDriverStats['state'] = 'STOPPED';

  start(_options: WebTransportServerOptions): Promise<void> {
    const start = deferred();
    this.starts.push(start);
    this.state = 'STARTING';
    return start.promise.then(() => {
      this.state = 'RUNNING';
    });
  }

  async stop(_options?: DriverStopOptions): Promise<void> {
    this.stopCalls += 1;
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      throw new Error('driver stop failed');
    }
    this.state = 'STOPPED';
  }

  onSession(_callback: WebTransportSessionCallback): Unsubscribe {
    return () => undefined;
  }

  getStats(): WebTransportDriverStats {
    return {
      capturedAt: Date.now(),
      state: this.state,
      sessions: { active: 0, total: 0, rejected: 0 },
      streams: { active: 0, total: 0 },
      datagrams: { received: 0, sent: 0, dropped: 0 },
      bytes: { received: 0, sent: 0 },
    };
  }
}

describe('WebTransportRuntime lifecycle races', () => {
  it('shares one startup operation across concurrent bootstrap hooks', async () => {
    const driver = new DeferredStartDriver();
    const moduleRef = await createRuntimeModule(driver);
    const runtime = moduleRef.get(WebTransportRuntime);

    const first = runtime.onApplicationBootstrap();
    const second = runtime.onApplicationBootstrap();

    expect(second).toBe(first);
    expect(driver.starts).toHaveLength(1);

    driver.starts[0]?.resolve();
    await Promise.all([first, second]);
    expect(runtime.snapshot.state).toBe('RUNNING');

    await moduleRef.close();
  });

  it('keeps STOPPING ownership when shutdown begins during driver startup', async () => {
    const driver = new DeferredStartDriver();
    const moduleRef = await createRuntimeModule(driver);

    const runtime = moduleRef.get(WebTransportRuntime);
    const initialization = moduleRef.init();
    await waitFor(() => driver.starts.length === 1);
    const stopping = runtime.stop();
    driver.starts[0]?.resolve();

    await Promise.all([initialization, stopping]);
    expect(runtime.snapshot.state).toBe('STOPPED');
    expect(driver.state).toBe('STOPPED');
    expect(driver.stopCalls).toBe(1);

    await moduleRef.close();
  });

  it('does not report STOPPED when the driver fails to stop and permits a retry', async () => {
    const driver = new DeferredStartDriver();
    driver.stopFailures = 1;
    const moduleRef = await createRuntimeModule(driver);
    const runtime = moduleRef.get(WebTransportRuntime);

    const started = runtime.onApplicationBootstrap();
    driver.starts[0]?.resolve();
    await started;

    await expect(runtime.stop()).rejects.toThrow('driver stop failed');
    expect(runtime.snapshot.state).toBe('STOPPING');
    expect(driver.stopCalls).toBe(1);

    await runtime.stop();
    expect(runtime.snapshot.state).toBe('STOPPED');
    expect(driver.stopCalls).toBe(2);

    await moduleRef.close();
  });
});

async function createRuntimeModule(driver: WebTransportDriver) {
  return Test.createTestingModule({
    imports: [
      WebTransportModule.forRoot({
        driver,
        server: { port: 0 },
        security: { requireOrigin: false },
        shutdown: { forceCloseTimeoutMs: 100 },
      }),
    ],
  }).compile();
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for runtime lifecycle state.');
    }
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

it.each(['STARTING', 'DRAINING', 'STOPPING', 'STOPPED'] as const)(
  'reports failed liveness when a running runtime has a %s driver',
  async (state) => {
    const driver = new DeferredStartDriver();
    const module = await createRuntimeModule(driver);
    const runtime = module.get(WebTransportRuntime);
    const starting = runtime.onApplicationBootstrap();
    driver.starts[0]?.resolve();
    await starting;
    driver.state = state;
    expect(module.get(WebTransportHealthService).getStatus()).toMatchObject({
      alive: false,
      ready: false,
    });
    await module.close();
  },
);
