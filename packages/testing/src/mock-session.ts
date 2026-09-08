import {
  SessionClosedError,
  type SessionCloseOptions,
  type WebTransportBidirectionalStream,
  type WebTransportReceiveStream,
  WebTransportResourceLimitError,
  type WebTransportSendStream,
  type WebTransportSession,
  WebTransportSessionState,
  type WebTransportSessionState as WebTransportSessionStateValue,
} from 'webtransport-core';

import { BoundedValueQueue } from './internal/bounded-stream.js';
import {
  createMockDatagramChannelPair,
  type MockDatagramChannelPair,
  type MockWebTransportDatagramChannel,
  type QueueOverflowPolicy,
} from './mock-datagram.js';
import {
  createMockBidirectionalStreamPair,
  createMockUnidirectionalStreamPair,
  type MockBidirectionalStreamPair,
  type MockUnidirectionalStreamPair,
  type MockWebTransportBidirectionalStream,
  type MockWebTransportSendStream,
} from './mock-stream.js';

const DEFAULT_INCOMING_STREAM_QUEUE_SIZE = 16;
let nextStandaloneSessionId = 1;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

export interface MockSessionCloseInfo {
  readonly closeCode: number;
  readonly reason: string;
  readonly aborted: boolean;
  readonly error?: unknown;
}

/** Session counters use the server endpoint's perspective. */
export interface MockSessionStatsHooks {
  readonly onStreamOpened?: () => void;
  readonly onStreamClosed?: () => void;
  readonly onDatagramSent?: (byteLength: number) => void;
  readonly onDatagramReceived?: (byteLength: number) => void;
  readonly onDatagramDropped?: () => void;
  readonly onBytesSent?: (byteLength: number) => void;
  readonly onBytesReceived?: (byteLength: number) => void;
  readonly onClosed?: (info: MockSessionCloseInfo) => void;
}

export interface MockSessionPairOptions {
  readonly id?: string;
  readonly path: string;
  readonly headers?: HeadersInit;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly incomingStreamQueueSize?: number;
  readonly streamQueueSize?: number;
  readonly streamMaxChunkSize?: number;
  readonly datagramQueueSize?: number;
  readonly maxDatagramSize?: number;
  readonly datagramOverflow?: QueueOverflowPolicy;
  readonly hooks?: MockSessionStatsHooks;
}

interface ResettableStreamPair {
  reset(code?: number, cause?: unknown): Promise<void>;
}

class MockSessionConnection {
  readonly id: string;
  readonly path: string;
  readonly headers: Headers;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly signal: AbortSignal;
  readonly closed: Promise<MockSessionCloseInfo>;
  readonly datagrams: MockDatagramChannelPair;

  readonly #controller = new AbortController();
  readonly #closed = createDeferred<MockSessionCloseInfo>();
  readonly #hooks: MockSessionStatsHooks;
  readonly #streamOptions: {
    readonly queueSize: number;
    readonly maxChunkSize: number;
  };
  readonly #streams = new Set<ResettableStreamPair>();
  #state: WebTransportSessionStateValue = WebTransportSessionState.CONNECTED;
  #nextStreamId = 0n;
  #first?: MockWebTransportSession;
  #second?: MockWebTransportSession;
  #termination?: Promise<void>;
  #closeInfo?: MockSessionCloseInfo;

  constructor(options: MockSessionPairOptions) {
    if (!options.path.startsWith('/')) {
      throw new TypeError('A virtual session path must start with "/"');
    }

    this.id = options.id ?? `mock-session-${nextStandaloneSessionId++}`;
    this.path = options.path;
    this.headers = new Headers(options.headers);
    this.remoteAddress = options.remoteAddress ?? '127.0.0.1';
    this.remotePort = options.remotePort ?? 0;
    this.signal = this.#controller.signal;
    this.closed = this.#closed.promise;
    this.#hooks = options.hooks ?? {};
    this.#streamOptions = {
      queueSize: options.streamQueueSize ?? 16,
      maxChunkSize: options.streamMaxChunkSize ?? 64 * 1024,
    };
    this.datagrams = createMockDatagramChannelPair({
      ...(options.datagramQueueSize === undefined ? {} : { queueSize: options.datagramQueueSize }),
      ...(options.maxDatagramSize === undefined
        ? {}
        : { maxDatagramSize: options.maxDatagramSize }),
      ...(options.datagramOverflow === undefined ? {} : { overflow: options.datagramOverflow }),
      assertOpen: () => this.assertConnected(),
      onSecondToFirst: (byteLength) => this.#hooks.onDatagramSent?.(byteLength),
      onFirstToSecond: (byteLength) => this.#hooks.onDatagramReceived?.(byteLength),
      onSecondDropped: () => this.#hooks.onDatagramDropped?.(),
      onCloseSession: (reason) => {
        void this.abort(reason);
      },
    });
  }

  get state(): WebTransportSessionStateValue {
    return this.#state;
  }

  get closeInfo(): MockSessionCloseInfo | undefined {
    return this.#closeInfo;
  }

  attach(first: MockWebTransportSession, second: MockWebTransportSession): void {
    this.#first = first;
    this.#second = second;
  }

  peerOf(session: MockWebTransportSession): MockWebTransportSession {
    if (session === this.#first && this.#second !== undefined) {
      return this.#second;
    }
    if (session === this.#second && this.#first !== undefined) {
      return this.#first;
    }
    throw new TypeError('Session does not belong to this virtual connection');
  }

  assertConnected(): void {
    if (this.#state !== WebTransportSessionState.CONNECTED) {
      throw new SessionClosedError(`Virtual session ${this.id} is closed`, {
        code: 'TEST_SESSION_CLOSED',
        recoverable: true,
        scope: 'SESSION',
      });
    }
  }

  async createBidirectionalStream(
    owner: MockWebTransportSession,
  ): Promise<MockWebTransportBidirectionalStream> {
    this.assertConnected();
    const id = this.#allocateStreamId();
    let trackedPair!: MockBidirectionalStreamPair;
    trackedPair = createMockBidirectionalStreamPair({
      id,
      ...this.#streamOptions,
      onFirstToSecondBytes: (byteLength) =>
        this.#recordStreamBytes(byteLength, owner === this.#second),
      onSecondToFirstBytes: (byteLength) =>
        this.#recordStreamBytes(byteLength, owner !== this.#second),
      onTerminal: () => this.#finishStream(trackedPair),
    });
    this.#startStream(trackedPair);

    try {
      this.peerOf(owner).acceptBidirectionalStream(trackedPair.second);
    } catch (cause) {
      await trackedPair.reset(0, cause);
      throw new WebTransportResourceLimitError('Incoming bidirectional stream queue is full', {
        code: 'TEST_STREAM_QUEUE_FULL',
        recoverable: true,
        scope: 'STREAM',
        cause,
      });
    }

    return trackedPair.first;
  }

  async createUnidirectionalStream(
    owner: MockWebTransportSession,
  ): Promise<MockWebTransportSendStream> {
    this.assertConnected();
    const id = this.#allocateStreamId();
    let trackedPair!: MockUnidirectionalStreamPair;
    trackedPair = createMockUnidirectionalStreamPair({
      id,
      ...this.#streamOptions,
      onFirstToSecondBytes: (byteLength) =>
        this.#recordStreamBytes(byteLength, owner === this.#second),
      onTerminal: () => this.#finishStream(trackedPair),
    });
    this.#startStream(trackedPair);

    try {
      this.peerOf(owner).acceptUnidirectionalStream(trackedPair.receiver);
    } catch (cause) {
      await trackedPair.reset(0, cause);
      throw new WebTransportResourceLimitError('Incoming unidirectional stream queue is full', {
        code: 'TEST_STREAM_QUEUE_FULL',
        recoverable: true,
        scope: 'STREAM',
        cause,
      });
    }

    return trackedPair.sender;
  }

  close(options: SessionCloseOptions = {}): Promise<void> {
    return this.#beginTermination({
      closeCode: options.closeCode ?? 0,
      reason: options.reason ?? '',
      aborted: false,
    });
  }

  abort(reason?: unknown): Promise<void> {
    const error =
      reason ??
      new SessionClosedError(`Virtual session ${this.id} was aborted`, {
        code: 'TEST_SESSION_ABORTED',
        recoverable: true,
        scope: 'SESSION',
      });
    return this.#beginTermination({
      closeCode: 0,
      reason: error instanceof Error ? error.message : String(error),
      aborted: true,
      error,
    });
  }

  #allocateStreamId(): bigint {
    const id = this.#nextStreamId;
    this.#nextStreamId += 1n;
    return id;
  }

  #startStream(pair: ResettableStreamPair): void {
    this.#streams.add(pair);
    this.#hooks.onStreamOpened?.();
  }

  #finishStream(pair: ResettableStreamPair): void {
    if (this.#streams.delete(pair)) {
      this.#hooks.onStreamClosed?.();
    }
  }

  #recordStreamBytes(byteLength: number, fromServer: boolean): void {
    if (fromServer) {
      this.#hooks.onBytesSent?.(byteLength);
    } else {
      this.#hooks.onBytesReceived?.(byteLength);
    }
  }

  #beginTermination(info: MockSessionCloseInfo): Promise<void> {
    this.#termination ??= this.#terminate(info);
    return this.#termination;
  }

  async #terminate(info: MockSessionCloseInfo): Promise<void> {
    if (this.#state === WebTransportSessionState.CLOSED) {
      return;
    }

    this.#state = WebTransportSessionState.CLOSING;
    this.#closeInfo = info;
    const signalReason =
      info.error ??
      new SessionClosedError(`Virtual session ${this.id} closed`, {
        code: 'TEST_SESSION_CLOSED',
        recoverable: true,
        scope: 'SESSION',
      });
    this.#controller.abort(signalReason);

    const resets = [...this.#streams].map((stream) => stream.reset(info.closeCode, signalReason));
    if (info.aborted) {
      this.datagrams.abort(signalReason);
      this.#first?.terminateIncomingStreams(signalReason);
      this.#second?.terminateIncomingStreams(signalReason);
    } else {
      this.datagrams.close(signalReason);
      this.#first?.closeIncomingStreams();
      this.#second?.closeIncomingStreams();
    }
    await Promise.allSettled(resets);

    this.#state = WebTransportSessionState.CLOSED;
    this.#closed.resolve(info);
    this.#hooks.onClosed?.(info);
  }
}

export class MockWebTransportSession implements WebTransportSession {
  readonly id: string;
  readonly path: string;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly datagrams: MockWebTransportDatagramChannel;
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
  readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;
  readonly closed: Promise<MockSessionCloseInfo>;

  readonly #connection: MockSessionConnection;
  readonly #headers: Headers;
  readonly #incomingBidirectional: BoundedValueQueue<WebTransportBidirectionalStream>;
  readonly #incomingUnidirectional: BoundedValueQueue<WebTransportReceiveStream>;

  constructor(options: {
    readonly connection: MockSessionConnection;
    readonly datagrams: MockWebTransportDatagramChannel;
    readonly incomingStreamQueueSize: number;
  }) {
    this.#connection = options.connection;
    this.id = options.connection.id;
    this.path = options.connection.path;
    this.#headers = new Headers(options.connection.headers);
    this.remoteAddress = options.connection.remoteAddress;
    this.remotePort = options.connection.remotePort;
    this.datagrams = options.datagrams;
    this.closed = options.connection.closed;
    this.#incomingBidirectional = new BoundedValueQueue({
      capacity: options.incomingStreamQueueSize,
      overflow: 'reject',
      onDrop: (stream) => {
        void stream.reset(0);
      },
    });
    this.#incomingUnidirectional = new BoundedValueQueue({
      capacity: options.incomingStreamQueueSize,
      overflow: 'reject',
      onDrop: (stream) => {
        void stream.stop(0);
      },
    });
    this.incomingBidirectionalStreams = this.#incomingBidirectional.readable;
    this.incomingUnidirectionalStreams = this.#incomingUnidirectional.readable;
  }

  get headers(): Readonly<Headers> {
    return new Headers(this.#headers);
  }

  get state(): WebTransportSessionStateValue {
    return this.#connection.state;
  }

  get signal(): AbortSignal {
    return this.#connection.signal;
  }

  get closeInfo(): MockSessionCloseInfo | undefined {
    return this.#connection.closeInfo;
  }

  createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    return this.#connection.createBidirectionalStream(this);
  }

  createUnidirectionalStream(): Promise<WebTransportSendStream> {
    return this.#connection.createUnidirectionalStream(this);
  }

  close(options?: SessionCloseOptions): Promise<void> {
    return this.#connection.close(options);
  }

  abort(reason?: unknown): Promise<void> {
    return this.#connection.abort(reason);
  }

  acceptBidirectionalStream(stream: WebTransportBidirectionalStream): void {
    this.#connection.assertConnected();
    this.#incomingBidirectional.push(stream);
  }

  acceptUnidirectionalStream(stream: WebTransportReceiveStream): void {
    this.#connection.assertConnected();
    this.#incomingUnidirectional.push(stream);
  }

  closeIncomingStreams(): void {
    this.#incomingBidirectional.close({ discard: true });
    this.#incomingUnidirectional.close({ discard: true });
  }

  terminateIncomingStreams(reason: unknown): void {
    this.#incomingBidirectional.abort(reason);
    this.#incomingUnidirectional.abort(reason);
  }
}

export interface MockWebTransportSessionPair {
  readonly client: MockWebTransportSession;
  readonly server: MockWebTransportSession;
  close(options?: SessionCloseOptions): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export function createMockWebTransportSessionPair(
  options: MockSessionPairOptions,
): MockWebTransportSessionPair {
  const connection = new MockSessionConnection(options);
  const incomingStreamQueueSize =
    options.incomingStreamQueueSize ?? DEFAULT_INCOMING_STREAM_QUEUE_SIZE;
  const client = new MockWebTransportSession({
    connection,
    datagrams: connection.datagrams.first,
    incomingStreamQueueSize,
  });
  const server = new MockWebTransportSession({
    connection,
    datagrams: connection.datagrams.second,
    incomingStreamQueueSize,
  });
  connection.attach(client, server);

  return {
    client,
    server,
    close: (closeOptions?: SessionCloseOptions) => connection.close(closeOptions),
    abort: (reason?: unknown) => connection.abort(reason),
  };
}
