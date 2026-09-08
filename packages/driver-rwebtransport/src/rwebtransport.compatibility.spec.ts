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

it.each([false, true])(
  'cancels native queued/new streams without terminating delivered streams (bidi=%s)',
  async (bidi) => {
    const { WebTransportServerSession } = await import('../vendor/rwebtransport.mjs');
    let incoming!: { onBidi(id: number): void; onUni(id: number): void };
    const receives = new Map<number, unknown>();
    const sends = new Map<number, unknown>();
    const stopped: number[] = [];
    const reset: number[] = [];
    const close: unknown[][] = [];
    const core = {
      closed: { promise: new Promise(() => {}) },
      setDatagramSink() {},
      setIncomingHandler(handler: typeof incoming) {
        incoming = handler;
      },
      registerReceive(id: number, sink: unknown) {
        receives.set(id, sink);
      },
      unregisterReceive(id: number) {
        receives.delete(id);
      },
      registerSend(id: number, sink: unknown) {
        sends.set(id, sink);
      },
      unregisterSend(id: number) {
        sends.delete(id);
      },
      setPaused() {},
      stopSending(id: number) {
        stopped.push(id);
      },
      resetStream(id: number) {
        reset.push(id);
      },
      close(...args: unknown[]) {
        close.push(args);
      },
    };
    const session = Reflect.construct(WebTransportServerSession, [core, {}]) as InstanceType<
      typeof WebTransportServerSession
    >;
    const collection = bidi
      ? session.incomingBidirectionalStreams
      : session.incomingUnidirectionalStreams;
    const deliver = (id: number) => (bidi ? incoming.onBidi(id) : incoming.onUni(id));
    deliver(4);
    deliver(8);
    const reader = collection.getReader();
    await reader.read();
    await reader.cancel();
    deliver(12);
    expect(stopped).toEqual([8, 12]);
    expect(reset).toEqual(bidi ? [8, 12] : []);
    expect([...receives.keys()]).toEqual([4]);
    expect([...sends.keys()]).toEqual(bidi ? [4] : []);
    expect(close).toEqual([]);
    reader.releaseLock();
  },
);
