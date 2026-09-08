import type { Attributes, Meter, ObservableResult } from '@opentelemetry/api';
import type { WebTransportRuntimeStats } from 'nest-webtransport';
import { describe, expect, it } from 'vitest';
import type { WebTransportDriver } from 'webtransport-core';
import { WebTransportMetrics } from './metrics.js';

describe('runtime telemetry', () => {
  it('exports bounded rejection reasons separately from transport counters and unregisters callbacks', () => {
    const callbacks = new Map<string, (result: ObservableResult<Attributes>) => void>();
    const observed: { name: string; value: number; attributes: Attributes | undefined }[] = [];
    const observable = (name: string) => ({
      addCallback: (callback: (result: ObservableResult<Attributes>) => void) =>
        callbacks.set(name, callback),
      removeCallback: () => callbacks.delete(name),
    });
    const meter = {
      createObservableGauge: observable,
      createObservableCounter: observable,
    } as unknown as Meter;
    const runtime: WebTransportRuntimeStats = {
      sessions: { accepted: 2, rejected: 3, rejections: { 'admission-failed': 3 } },
      datagrams: { dropped: 4, drops: { 'rate-limit': 4 }, queuedBytes: 64 },
      handlers: { active: 1, outstanding: 2, rejected: 1 },
      logs: { suppressed: 10 },
    };
    const driver = {
      getStats: () => ({
        sessions: { active: 1, total: 5, rejected: 0 },
        streams: { active: 0, total: 0 },
        datagrams: { received: 8, sent: 2, dropped: 0 },
        bytes: { received: 8, sent: 2 },
      }),
    } as unknown as WebTransportDriver;
    const collector = new WebTransportMetrics(driver, { meter, runtimeStats: () => runtime });
    collector.enable();
    collector.enable();
    expect(callbacks.size).toBe(20);
    for (const [name, callback] of callbacks)
      callback({ observe: (value, attributes) => observed.push({ name, value, attributes }) });
    expect(observed).toContainEqual({
      name: 'webtransport.runtime.sessions.rejections',
      value: 3,
      attributes: { reason: 'admission-failed' },
    });
    expect(observed).toContainEqual({
      name: 'webtransport.sessions.rejected',
      value: 0,
      attributes: {},
    });
    expect(observed).toContainEqual({
      name: 'webtransport.runtime.datagrams.drops',
      value: 4,
      attributes: { reason: 'rate-limit' },
    });
    collector.disable();
    expect(callbacks.size).toBe(0);
  });
});
