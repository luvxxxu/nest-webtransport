import { describe, expect, it } from 'vitest';
import type { WebTransportDriver } from 'webtransport-core';

import { normalizeWebTransportModuleOptions } from './options.js';

const driver = {
  capabilities: {
    datagrams: true,
    bidirectionalStreams: true,
    unidirectionalStreams: true,
    gracefulShutdown: true,
    connectionStats: false,
    keyingMaterialExport: false,
  },
  start: async () => undefined,
  stop: async () => undefined,
  onSession: () => () => undefined,
  getStats: () => ({
    capturedAt: 0,
    state: 'STOPPED' as const,
    sessions: { active: 0, total: 0, rejected: 0 },
    streams: { active: 0, total: 0 },
    datagrams: { received: 0, sent: 0, dropped: 0 },
    bytes: { received: 0, sent: 0 },
  }),
} satisfies WebTransportDriver;

describe('normalizeWebTransportModuleOptions', () => {
  it('fails closed when Origin is required without an allowlist', () => {
    expect(() => normalizeWebTransportModuleOptions({ driver, server: { port: 4433 } })).toThrow(
      /allowedOrigins/,
    );
  });

  it('allows an explicit originless-client policy', () => {
    const options = normalizeWebTransportModuleOptions({
      driver,
      server: { port: 0 },
      security: { requireOrigin: false },
    });

    expect(options.security.requireOrigin).toBe(false);
    expect(options.security.allowedOrigins.size).toBe(0);
  });

  it('normalizes serialized origins and rejects values with URL data', () => {
    const options = normalizeWebTransportModuleOptions({
      driver,
      server: { port: 4433 },
      security: { allowedOrigins: ['https://EXAMPLE.com:443/'] },
    });

    expect([...options.security.allowedOrigins]).toEqual(['https://example.com']);
    expect(() =>
      normalizeWebTransportModuleOptions({
        driver,
        server: { port: 4433 },
        security: { allowedOrigins: ['https://example.com/private'] },
      }),
    ).toThrow(/allowedOrigins\[0\]/);
  });

  it.each([
    ['execution.overflow', { execution: { overflow: 'buffer-forever' } }],
    ['datagrams.queue.overflow', { datagrams: { queue: { overflow: 'buffer-forever' } } }],
  ])('rejects an unsupported %s policy', (expected, overrides) => {
    expect(() =>
      normalizeWebTransportModuleOptions({
        driver,
        server: { port: 4433 },
        security: { requireOrigin: false },
        ...(overrides as object),
      }),
    ).toThrow(expected);
  });

  it.each([
    [{ security: { requireOrigin: false, handshakeTimeoutMs: 0 } }, 'handshakeTimeoutMs'],
    [{ security: { requireOrigin: false, maxHeaderSize: -1 } }, 'maxHeaderSize'],
    [
      { shutdown: { forceCloseTimeoutMs: 0 }, security: { requireOrigin: false } },
      'forceCloseTimeoutMs',
    ],
    [{ server: { port: 65_536 }, security: { requireOrigin: false } }, 'server.port'],
  ] as const)('rejects invalid numeric configuration %#', (overrides, expected) => {
    const server = 'server' in overrides ? overrides.server : { port: 4433 };
    expect(() =>
      normalizeWebTransportModuleOptions({
        driver,
        server,
        ...overrides,
      }),
    ).toThrow(expected);
  });
});

it.each([
  { security: { requireOrigin: false, idleTimeoutMs: 2_147_483_648 } },
  { security: { requireOrigin: false, handshakeTimeoutMs: 2_147_483_648 } },
  { security: { requireOrigin: false }, limits: { stream: { maxLifetimeMs: 2_147_483_648 } } },
  { security: { requireOrigin: false }, shutdown: { drainTimeoutMs: 2_147_483_648 } },
  { security: { requireOrigin: false }, shutdown: { forceCloseTimeoutMs: 2_147_483_648 } },
  { security: { requireOrigin: false }, datagrams: { queue: { size: 4_294_967_296 } } },
])('rejects timer/queue overflow at bootstrap %#', (options) => {
  expect(() =>
    normalizeWebTransportModuleOptions({ driver, server: { port: 0 }, ...options }),
  ).toThrow(RangeError);
});
