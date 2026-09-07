import { describe, expect, it } from 'vitest';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
const hasUpstreamRuntimeSupport = nodeMajor === 24 || nodeMajor === 26;

describe.runIf(hasUpstreamRuntimeSupport)('rwebtransport runtime compatibility', () => {
  it('loads the native server export', async () => {
    const upstream = await import('rwebtransport');

    expect(upstream.WebTransportServer).toBeTypeOf('function');
  });
});

it('rejects native session queue overflow before allocating session objects', async () => {
  const { WebTransportServer } = await import('../vendor/rwebtransport.mjs');
  const closed: unknown[][] = [];
  const server = Object.create(WebTransportServer.prototype) as {
    incomingController: { desiredSize: number };
    native: { serverCloseSession: (...args: unknown[]) => void };
    handle: number;
    onEvent(event: object): void;
  };
  server.incomingController = { desiredSize: 0 };
  server.native = {
    serverCloseSession: (...args) => {
      closed.push(args);
    },
  };
  server.handle = 1;
  server.onEvent({ type: 'serverReady', session: 7 });
  expect(closed).toHaveLength(1);
  expect(closed[0]?.slice(0, 3)).toEqual([1, 7, 257]);
});
