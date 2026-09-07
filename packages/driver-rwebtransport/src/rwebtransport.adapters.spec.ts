import type {
  WebTransportBidirectionalStream as NativeBidirectionalStream,
  WebTransportDatagramDuplexStream as NativeDatagramChannel,
  WebTransportReceiveStream as NativeReceiveStream,
  WebTransportSendStream as NativeSendStream,
  WebTransportServer as NativeServer,
  WebTransportServerOptions as NativeServerOptions,
  WebTransportServerSession as NativeSession,
} from 'rwebtransport';
import { WebTransportError as NativeWebTransportError } from 'rwebtransport';
import { describe, expect, it } from 'vitest';
import {
  StreamResetError,
  WebTransportDriverError,
  WebTransportServerState,
  WebTransportSessionState,
  WebTransportStreamError,
} from 'webtransport-core';

import { RWebTransportDatagramAdapter } from './datagram.adapter.js';
import { RWebTransportDriver, type RWebTransportDriverOptions } from './driver.js';
import { mapRWebTransportError } from './error.mapper.js';
import type { RWebTransportAdapterMetrics } from './metrics.js';
import { RWebTransportServerAdapter } from './server.adapter.js';
import { RWebTransportSessionAdapter } from './session.adapter.js';
import {
  createRWebTransportStreamAbortContext,
  RWebTransportBidirectionalStreamAdapter,
} from './stream.adapter.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface TestDriverOptions extends RWebTransportDriverOptions {
  readonly serverFactory: (options: NativeServerOptions) => NativeServer;
  readonly sessionIdFactory?: () => string;
  readonly now?: () => number;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

function nativeReceiveStream(
  id: number,
  source: UnderlyingDefaultSource<Uint8Array> = {},
): NativeReceiveStream {
  const readable = new ReadableStream<Uint8Array>(source);
  Object.defineProperty(readable, 'streamId', { value: id });
  return readable as NativeReceiveStream;
}

function nativeSendStream(id: number, sink: UnderlyingSink<Uint8Array> = {}): NativeSendStream {
  const writable = new WritableStream<Uint8Array>(sink);
  Object.defineProperties(writable, {
    streamId: { value: id },
    sendGroup: { value: null, writable: true },
    sendOrder: { value: 0, writable: true },
  });
  return writable as NativeSendStream;
}

function nativeBidirectionalStream(
  id: number,
  readableSource: UnderlyingDefaultSource<Uint8Array> = {},
  writableSink: UnderlyingSink<Uint8Array> = {},
): NativeBidirectionalStream {
  return {
    readable: nativeReceiveStream(id, readableSource),
    writable: nativeSendStream(id, writableSink),
  } as NativeBidirectionalStream;
}

interface RecordedMetrics extends RWebTransportAdapterMetrics {
  opened: number;
  closed: number;
  receivedBytes: number;
  sentBytes: number;
  receivedDatagrams: number;
  sentDatagrams: number;
  droppedDatagrams: number;
}

function metricRecorder(): RecordedMetrics {
  return {
    opened: 0,
    closed: 0,
    receivedBytes: 0,
    sentBytes: 0,
    receivedDatagrams: 0,
    sentDatagrams: 0,
    droppedDatagrams: 0,
    streamOpened() {
      this.opened += 1;
    },
    streamClosed() {
      this.closed += 1;
    },
    bytesReceived(bytes) {
      this.receivedBytes += bytes;
    },
    bytesSent(bytes) {
      this.sentBytes += bytes;
    },
    datagramReceived(bytes) {
      this.receivedDatagrams += 1;
      this.receivedBytes += bytes;
    },
    datagramSent(bytes) {
      this.sentDatagrams += 1;
      this.sentBytes += bytes;
    },
    datagramDropped(count = 1) {
      this.droppedDatagrams += count;
    },
  };
}

class FakeNativeSession {
  readonly authority = 'localhost';
  readonly path = '/realtime';
  readonly origin = 'https://example.com';
  readonly headers = { authorization: 'Bearer test' };
  readonly requestedProtocols = ['chat'];
  readonly protocol = 'chat';
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 50_000;
  readonly ready = Promise.resolve();
  readonly draining = new Promise<void>(() => {});
  readonly datagrams: NativeDatagramChannel;
  readonly incomingBidirectionalStreams = new ReadableStream<NativeBidirectionalStream>();
  readonly incomingUnidirectionalStreams = new ReadableStream<NativeReceiveStream>();

  closeCalls = 0;
  drainCalls = 0;
  readonly closedDeferred = deferred<{ closeCode: number; reason: string }>();
  readonly closed = this.closedDeferred.promise;

  constructor(private readonly closeImmediately = true) {
    this.datagrams = {
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
      maxDatagramSize: 1_200,
      incomingHighWaterMark: 64,
      outgoingHighWaterMark: 64,
      incomingMaxAge: null,
      outgoingMaxAge: null,
    } as unknown as NativeDatagramChannel;
  }

  async createBidirectionalStream(): Promise<NativeBidirectionalStream> {
    return nativeBidirectionalStream(12);
  }

  async createUnidirectionalStream(): Promise<NativeSendStream> {
    return nativeSendStream(14);
  }

  close(options: { closeCode?: number; reason?: string } = {}): void {
    this.closeCalls += 1;
    if (this.closeImmediately) {
      this.closedDeferred.resolve({
        closeCode: options.closeCode ?? 0,
        reason: options.reason ?? '',
      });
    }
  }

  drain(): void {
    this.drainCalls += 1;
  }

  async getStats() {
    return {
      bytesSent: 20,
      bytesReceived: 10,
      packetsSent: 4,
      packetsReceived: 3,
      packetsLost: 1,
      smoothedRtt: 2,
      rttVariation: 0.5,
      minRtt: 1,
      datagrams: {
        expiredOutgoing: 0,
        droppedIncoming: 2,
        lostOutgoing: 1,
        expiredIncoming: 0,
      },
    };
  }

  async exportKeyingMaterial(
    _label: ArrayBufferView | ArrayBuffer,
    _context: ArrayBufferView | ArrayBuffer,
    outputLength: number,
  ): Promise<Uint8Array> {
    return new Uint8Array(outputLength).fill(7);
  }
}

class FakeNativeServer {
  readonly port = 4_433;
  readonly ready = Promise.resolve();
  readonly closedDeferred = deferred<void>();
  readonly closed = this.closedDeferred.promise;
  readonly incomingSessions: ReadableStream<NativeSession>;
  closeCalls = 0;
  private controller!: ReadableStreamDefaultController<NativeSession>;

  constructor(readonly options: NativeServerOptions) {
    this.incomingSessions = new ReadableStream<NativeSession>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  emit(session: FakeNativeSession): void {
    this.controller.enqueue(session as unknown as NativeSession);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.closeCalls === 1) {
      this.controller.close();
      this.closedDeferred.resolve();
    }
  }
}

const SERVER_OPTIONS = {
  port: 0,
  host: '127.0.0.1',
  tls: {
    certificate: { kind: 'path' as const, path: '/tmp/cert.pem' },
    privateKey: { kind: 'path' as const, path: '/tmp/key.pem' },
  },
  applicationProtocols: ['chat'],
};

describe('rwebtransport error mapping', () => {
  it('preserves stream reset scope and hides the native error type', () => {
    const native = new NativeWebTransportError('peer reset', {
      source: 'stream',
      streamErrorCode: 17,
    });

    const mapped = mapRWebTransportError(native, { target: 'stream' });

    expect(mapped).toBeInstanceOf(StreamResetError);
    expect(mapped).toBeInstanceOf(WebTransportStreamError);
    expect(mapped.scope).toBe('STREAM');
    expect(mapped.cause).toBe(native);
  });
});

describe('stream adapters', () => {
  it('converts a numeric id to bigint and attempts both reset halves', async () => {
    let cancelCalls = 0;
    let abortCalls = 0;
    const native = nativeBidirectionalStream(
      42,
      {
        cancel() {
          cancelCalls += 1;
          throw new Error('cancel failed');
        },
      },
      {
        abort() {
          abortCalls += 1;
        },
      },
    );
    const parent = new AbortController();
    const metrics = metricRecorder();
    const adapter = new RWebTransportBidirectionalStreamAdapter(
      native,
      createRWebTransportStreamAbortContext(parent.signal),
      metrics,
    );

    expect(adapter.id).toBe(42n);
    await expect(adapter.reset(17)).rejects.toBeInstanceOf(WebTransportStreamError);
    expect(cancelCalls).toBe(1);
    expect(abortCalls).toBe(1);
    expect(adapter.signal.aborted).toBe(true);
    expect(metrics.opened).toBe(1);
    expect(metrics.closed).toBe(1);
  });
});

describe('datagram adapter', () => {
  it('preserves message boundaries, backpressure, and activity metrics', async () => {
    const writes: Uint8Array[] = [];
    const native = {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(chunk);
        },
      }),
      maxDatagramSize: 1_350,
    } as NativeDatagramChannel;
    const metrics = metricRecorder();
    let received = 0;
    let sent = 0;
    const adapter = new RWebTransportDatagramAdapter(native, metrics, {
      received: () => {
        received += 1;
      },
      sent: () => {
        sent += 1;
      },
    });

    const read = await adapter.readable.getReader().read();
    const writer = adapter.writable.getWriter();
    await writer.write(new Uint8Array([4, 5]));
    await writer.close();

    expect(read.value).toEqual(new Uint8Array([1, 2, 3]));
    expect(writes).toEqual([new Uint8Array([4, 5])]);
    expect(adapter.maxDatagramSize).toBe(1_350);
    expect(received).toBe(1);
    expect(sent).toBe(1);
    expect(metrics.receivedBytes).toBe(3);
    expect(metrics.sentBytes).toBe(2);
  });
});

describe('session adapter', () => {
  it('owns identity/state/abort lifecycle and closes idempotently', async () => {
    const native = new FakeNativeSession();
    const adapter = new RWebTransportSessionAdapter(
      native as unknown as NativeSession,
      metricRecorder(),
      undefined,
      'session-1',
    );

    expect(adapter.id).toBe('session-1');
    expect(adapter.path).toBe('/realtime');
    expect(adapter.headers.get('authorization')).toBe('Bearer test');
    expect(adapter.headers.get('origin')).toBe('https://example.com');
    const callerHeaders = adapter.headers;
    callerHeaders.set('authorization', 'changed');
    expect(adapter.headers.get('authorization')).toBe('Bearer test');
    expect(adapter.state).toBe(WebTransportSessionState.CONNECTED);

    const first = adapter.close({ closeCode: 7, reason: 'done' });
    const second = adapter.close({ closeCode: 8, reason: 'ignored' });
    expect(second).toBe(first);
    await first;

    expect(native.closeCalls).toBe(1);
    expect(adapter.state).toBe(WebTransportSessionState.CLOSED);
    expect(adapter.signal.aborted).toBe(true);
  });

  it('settles one close promise when local and peer close race', async () => {
    const native = new FakeNativeSession(false);
    const adapter = new RWebTransportSessionAdapter(
      native as unknown as NativeSession,
      metricRecorder(),
      undefined,
      'session-race',
    );

    const close = adapter.close();
    native.closedDeferred.resolve({ closeCode: 0, reason: 'peer won' });
    await close;

    expect(adapter.close()).toBe(close);
    expect(native.closeCalls).toBe(1);
    expect(adapter.state).toBe(WebTransportSessionState.CLOSED);
  });

  it('adapts outbound stream ids and connection stats', async () => {
    const native = new FakeNativeSession();
    const metrics = metricRecorder();
    const adapter = new RWebTransportSessionAdapter(
      native as unknown as NativeSession,
      metrics,
      undefined,
      'session-2',
    );

    const bidi = await adapter.createBidirectionalStream();
    const uni = await adapter.createUnidirectionalStream();
    const stats = await adapter.captureConnectionStats();
    const key = await adapter.exportKeyingMaterial({ label: 'binding', length: 8 });

    expect(bidi.id).toBe(12n);
    expect(uni.id).toBe(14n);
    expect(stats).toMatchObject({
      sessionId: 'session-2',
      bytesReceived: 10,
      bytesSent: 20,
      packetsLost: 1,
      smoothedRttMs: 2,
    });
    expect(metrics.droppedDatagrams).toBe(3);
    expect(key).toEqual(new Uint8Array(8).fill(7));

    await bidi.reset();
    await uni.reset();
    await adapter.close();
  });
});

describe('server adapter', () => {
  it('maps path TLS options and keeps pumping after a session callback failure', async () => {
    let fakeServer: FakeNativeServer | undefined;
    const adapter = new RWebTransportServerAdapter(
      {
        allowedOrigins: ['https://example.com'],
        reusePort: true,
        responseHeaders: { 'x-webtransport': 'ready' },
      },
      (options) => {
        fakeServer = new FakeNativeServer(options);
        return fakeServer as unknown as NativeServer;
      },
    );
    let handled = 0;
    const errors: unknown[] = [];
    const start = adapter.start(SERVER_OPTIONS, {
      session(session) {
        handled += 1;
        if (handled === 1) {
          throw new Error('dispatch failed');
        }
        expect(session.path).toBe('/realtime');
      },
      error(error) {
        errors.push(error);
      },
    });
    expect(adapter.start(SERVER_OPTIONS, { session() {}, error() {} })).toBe(start);
    await start;

    const first = new FakeNativeSession();
    const second = new FakeNativeSession();
    fakeServer?.emit(first);
    fakeServer?.emit(second);
    await eventually(() => handled === 2);

    expect(fakeServer?.options).toMatchObject({
      cert: '/tmp/cert.pem',
      key: '/tmp/key.pem',
      supportedProtocols: ['chat'],
      allowedOrigins: ['https://example.com'],
      reusePort: true,
      responseHeaders: { 'x-webtransport': 'ready' },
    });
    expect(first.closeCalls).toBe(1);
    expect(errors).toHaveLength(1);

    const stop = adapter.stop();
    expect(adapter.stop()).toBe(stop);
    await stop;
    expect(fakeServer?.closeCalls).toBe(1);
  });

  it('rejects credential material that rwebtransport cannot consume', async () => {
    const adapter = new RWebTransportServerAdapter({}, () => {
      throw new Error('factory must not run');
    });

    await expect(
      adapter.start(
        {
          port: 4433,
          tls: {
            certificate: { kind: 'pem', value: 'certificate' },
            privateKey: { kind: 'path', path: '/tmp/key.pem' },
          },
        },
        { session() {}, error() {} },
      ),
    ).rejects.toBeInstanceOf(WebTransportDriverError);
  });
});

describe('RWebTransportDriver', () => {
  it('starts/stops idempotently and reports session lifecycle stats', async () => {
    let fakeServer: FakeNativeServer | undefined;
    const driverOptions: TestDriverOptions = {
      serverFactory(options: NativeServerOptions) {
        fakeServer = new FakeNativeServer(options);
        return fakeServer as unknown as NativeServer;
      },
      sessionIdFactory: () => 'driver-session',
      now: () => 123,
      allowedOrigins: ['https://example.com'],
    };
    const driver = new RWebTransportDriver(driverOptions);
    let accepted: RWebTransportSessionAdapter | undefined;
    driver.onSession((session) => {
      accepted = session as RWebTransportSessionAdapter;
    });

    const firstStart = driver.start(SERVER_OPTIONS);
    expect(driver.start(SERVER_OPTIONS)).toBe(firstStart);
    await firstStart;
    expect(driver.getStats()).toMatchObject({
      capturedAt: 123,
      state: WebTransportServerState.RUNNING,
      sessions: { active: 0, total: 0, rejected: 0 },
    });

    fakeServer?.emit(new FakeNativeSession());
    await eventually(() => accepted !== undefined);
    expect(driver.getStats().sessions).toEqual({ active: 1, total: 1, rejected: 0 });

    const firstStop = driver.stop({ graceful: false });
    expect(driver.stop()).toBe(firstStop);
    await firstStop;
    expect(driver.getStats()).toMatchObject({
      state: WebTransportServerState.STOPPED,
      sessions: { active: 0, total: 1, rejected: 0 },
    });
    expect(accepted?.signal.aborted).toBe(true);
  });

  it('restarts with a fresh server and removes the previous start abort listener', async () => {
    const servers: FakeNativeServer[] = [];
    const driver = new RWebTransportDriver({
      serverFactory(options: NativeServerOptions) {
        const server = new FakeNativeServer(options);
        servers.push(server);
        return server as unknown as NativeServer;
      },
    } as TestDriverOptions);
    const oldStart = new AbortController();

    await driver.start({ ...SERVER_OPTIONS, signal: oldStart.signal });
    await driver.stop({ graceful: false });
    await driver.start(SERVER_OPTIONS);

    oldStart.abort(new DOMException('obsolete start', 'AbortError'));
    await Promise.resolve();
    await Promise.resolve();

    expect(servers).toHaveLength(2);
    expect(servers[0]?.closeCalls).toBe(1);
    expect(servers[1]?.closeCalls).toBe(0);
    expect(driver.getStats().state).toBe(WebTransportServerState.RUNNING);

    await driver.stop({ graceful: false });
    expect(servers[1]?.closeCalls).toBe(1);
  });

  it('stops when the start signal is aborted', async () => {
    let fakeServer: FakeNativeServer | undefined;
    const driver = new RWebTransportDriver({
      serverFactory(options: NativeServerOptions) {
        fakeServer = new FakeNativeServer(options);
        return fakeServer as unknown as NativeServer;
      },
    } as TestDriverOptions);
    const controller = new AbortController();

    await driver.start({ ...SERVER_OPTIONS, signal: controller.signal });
    controller.abort(new DOMException('shutdown', 'AbortError'));
    await eventually(() => driver.getStats().state === WebTransportServerState.STOPPED);

    expect(fakeServer?.closeCalls).toBe(1);
  });

  it('bounds graceful shutdown when a session callback remains pending', async () => {
    let fakeServer: FakeNativeServer | undefined;
    const callbackDone = deferred<void>();
    let callbackStarted = false;
    const driver = new RWebTransportDriver({
      serverFactory(options: NativeServerOptions) {
        fakeServer = new FakeNativeServer(options);
        return fakeServer as unknown as NativeServer;
      },
    } as TestDriverOptions);
    driver.onSession(() => {
      callbackStarted = true;
      return callbackDone.promise;
    });

    await driver.start(SERVER_OPTIONS);
    const native = new FakeNativeSession();
    fakeServer?.emit(native);
    await eventually(() => callbackStarted);

    await driver.stop({ graceful: true, timeoutMs: 0 });

    expect(native.drainCalls).toBe(1);
    expect(native.closeCalls).toBe(1);
    expect(driver.getStats().state).toBe(WebTransportServerState.STOPPED);

    callbackDone.resolve();
  });
});

describe('release lifecycle and resource regressions', () => {
  it('bounds callbacks that remain pending after peer close', async () => {
    const server = new FakeNativeServer({ port: 0, cert: '', key: '' });
    const pending = deferred<void>();
    const driver = new RWebTransportDriver({
      serverFactory: () => server as unknown as NativeServer,
      maxPendingSessionCallbacks: 1,
    } as TestDriverOptions);
    let callbacks = 0;
    driver.onSession(async () => {
      callbacks++;
      await pending.promise;
    });
    await driver.start(SERVER_OPTIONS);
    const first = new FakeNativeSession();
    server.emit(first);
    await eventually(() => callbacks === 1);
    first.close();
    await eventually(() => driver.getStats().sessions.active === 0);
    const second = new FakeNativeSession();
    server.emit(second);
    await eventually(() => second.closeCalls === 1);
    expect(callbacks).toBe(1);
    expect(driver.getStats().sessions.rejected).toBe(1);
    pending.resolve();
    await driver.stop({ graceful: false });
  });

  it('does not report RUNNING after an unexpected native server close', async () => {
    const server = new FakeNativeServer({ port: 0, cert: '', key: '' });
    const driver = new RWebTransportDriver({
      serverFactory: () => server as unknown as NativeServer,
    } as TestDriverOptions);
    await driver.start(SERVER_OPTIONS);
    server.close();
    await eventually(() => driver.getStats().state === 'STOPPED');
  });

  it('bounds a hung native shutdown and allows retry after it settles', async () => {
    const server = new FakeNativeServer({ port: 0, cert: '', key: '' });
    const originalClose = server.close.bind(server);
    server.close = () => {};
    const driver = new RWebTransportDriver({
      serverFactory: () => server as unknown as NativeServer,
    } as TestDriverOptions);
    await driver.start(SERVER_OPTIONS);
    await expect(driver.stop({ graceful: false, timeoutMs: 5 })).rejects.toThrow('timed out');
    expect(driver.getStats().state).toBe('STOPPING');
    originalClose();
    await driver.stop({ graceful: false, timeoutMs: 100 });
    expect(driver.getStats().state).toBe('STOPPED');
  });
});

it('terminates datagram wrappers on idle native failure and discards buffered data on close', async () => {
  let writableController!: WritableStreamDefaultController;
  const native = {
    maxDatagramSize: 1200,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    }),
    writable: new WritableStream<Uint8Array>({
      start(controller) {
        writableController = controller;
      },
    }),
  } as unknown as NativeDatagramChannel;
  const adapter = new RWebTransportDatagramAdapter(native);
  await new Promise((resolve) => setTimeout(resolve, 0));
  writableController.error(new Error('session failed'));
  await eventually(() => !native.writable.locked);
  const writer = adapter.writable.getWriter();
  await expect(writer.closed).rejects.toThrow('session failed');
  writer.releaseLock();
  await adapter.close();
  const reader = adapter.readable.getReader();
  await expect(reader.read()).rejects.toThrow('Datagram session closed');
  reader.releaseLock();
  expect(native.readable.locked).toBe(false);
});
