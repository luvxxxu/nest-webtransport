import {
  type DriverStopOptions,
  SessionRejectedError,
  type Unsubscribe,
  type WebTransportDriver,
  type WebTransportDriverCapabilities,
  WebTransportDriverError,
  type WebTransportDriverStats,
  WebTransportResourceLimitError,
  type WebTransportServerOptions,
  WebTransportServerState,
  type WebTransportServerState as WebTransportServerStateValue,
  type WebTransportSessionCallback,
} from 'webtransport-core';
import type { QueueOverflowPolicy } from './mock-datagram.js';
import {
  createMockWebTransportSessionPair,
  type MockSessionStatsHooks,
  type MockWebTransportSession,
  type MockWebTransportSessionPair,
} from './mock-session.js';

export interface VirtualWebTransportDriverOptions {
  readonly maxSessions?: number;
  readonly incomingStreamQueueSize?: number;
  readonly streamQueueSize?: number;
  readonly streamMaxChunkSize?: number;
  readonly datagramQueueSize?: number;
  readonly maxDatagramSize?: number;
  readonly datagramOverflow?: QueueOverflowPolicy;
  readonly remoteAddress?: string;
  readonly firstRemotePort?: number;
  readonly now?: () => number;
}

interface MutableStats {
  sessionsActive: number;
  sessionsTotal: number;
  sessionsRejected: number;
  streamsActive: number;
  streamsTotal: number;
  datagramsReceived: number;
  datagramsSent: number;
  datagramsDropped: number;
  bytesReceived: number;
  bytesSent: number;
}

const CAPABILITIES: WebTransportDriverCapabilities = Object.freeze({
  datagrams: true,
  bidirectionalStreams: true,
  unidirectionalStreams: true,
  gracefulShutdown: true,
  connectionStats: false,
  keyingMaterialExport: false,
});

export class VirtualWebTransportDriver implements WebTransportDriver {
  readonly capabilities = CAPABILITIES;

  readonly #options: Required<
    Omit<VirtualWebTransportDriverOptions, 'datagramOverflow' | 'now'>
  > & {
    readonly datagramOverflow: QueueOverflowPolicy;
    readonly now: () => number;
  };
  readonly #callbacks = new Set<WebTransportSessionCallback>();
  readonly #sessions = new Map<string, MockWebTransportSessionPair>();
  readonly #stats: MutableStats = {
    sessionsActive: 0,
    sessionsTotal: 0,
    sessionsRejected: 0,
    streamsActive: 0,
    streamsTotal: 0,
    datagramsReceived: 0,
    datagramsSent: 0,
    datagramsDropped: 0,
    bytesReceived: 0,
    bytesSent: 0,
  };

  #state: WebTransportServerStateValue = WebTransportServerState.STOPPED;
  #serverOptions: WebTransportServerOptions | undefined;
  #nextSessionId = 1;
  #removeStartSignalListener: (() => void) | undefined;

  constructor(options: VirtualWebTransportDriverOptions = {}) {
    this.#options = {
      maxSessions: options.maxSessions ?? 1_024,
      incomingStreamQueueSize: options.incomingStreamQueueSize ?? 16,
      streamQueueSize: options.streamQueueSize ?? 16,
      streamMaxChunkSize: options.streamMaxChunkSize ?? 64 * 1024,
      datagramQueueSize: options.datagramQueueSize ?? 64,
      maxDatagramSize: options.maxDatagramSize ?? 1_200,
      datagramOverflow: options.datagramOverflow ?? 'drop-oldest',
      remoteAddress: options.remoteAddress ?? '127.0.0.1',
      firstRemotePort: options.firstRemotePort ?? 40_000,
      now: options.now ?? Date.now,
    };

    for (const [name, value] of Object.entries({
      maxSessions: this.#options.maxSessions,
      incomingStreamQueueSize: this.#options.incomingStreamQueueSize,
      streamQueueSize: this.#options.streamQueueSize,
      streamMaxChunkSize: this.#options.streamMaxChunkSize,
      datagramQueueSize: this.#options.datagramQueueSize,
      maxDatagramSize: this.#options.maxDatagramSize,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  get serverOptions(): WebTransportServerOptions | undefined {
    return this.#serverOptions;
  }

  async start(options: WebTransportServerOptions): Promise<void> {
    if (this.#state !== WebTransportServerState.STOPPED) {
      throw new WebTransportDriverError('The virtual driver is already started', {
        code: 'TEST_DRIVER_ALREADY_STARTED',
        recoverable: true,
        scope: 'SERVER',
      });
    }
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }

    this.#state = WebTransportServerState.STARTING;
    this.#serverOptions = options;
    if (options.signal !== undefined) {
      const stop = (): void => {
        void this.stop({ graceful: false });
      };
      options.signal.addEventListener('abort', stop, { once: true });
      this.#removeStartSignalListener = () => options.signal?.removeEventListener('abort', stop);
    }
    this.#state = WebTransportServerState.RUNNING;
  }

  async stop(options: DriverStopOptions = {}): Promise<void> {
    if (this.#state === WebTransportServerState.STOPPED) {
      return;
    }

    const graceful = options.graceful ?? true;
    this.#state = graceful ? WebTransportServerState.DRAINING : WebTransportServerState.STOPPING;
    const sessions = [...this.#sessions.values()];
    if (graceful && !options.signal?.aborted) {
      await Promise.all(sessions.map((session) => session.close()));
    } else {
      const reason =
        options.signal?.reason ??
        new WebTransportDriverError('The virtual driver stopped immediately', {
          code: 'TEST_DRIVER_STOPPED',
          recoverable: true,
          scope: 'SERVER',
        });
      await Promise.all(sessions.map((session) => session.abort(reason)));
    }

    this.#state = WebTransportServerState.STOPPING;
    this.#removeStartSignalListener?.();
    this.#removeStartSignalListener = undefined;
    this.#serverOptions = undefined;
    this.#state = WebTransportServerState.STOPPED;
  }

  onSession(callback: WebTransportSessionCallback): Unsubscribe {
    this.#callbacks.add(callback);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.#callbacks.delete(callback);
    };
  }

  getStats(): WebTransportDriverStats {
    return {
      capturedAt: this.#options.now(),
      state: this.#state,
      sessions: {
        active: this.#stats.sessionsActive,
        total: this.#stats.sessionsTotal,
        rejected: this.#stats.sessionsRejected,
      },
      streams: {
        active: this.#stats.streamsActive,
        total: this.#stats.streamsTotal,
      },
      datagrams: {
        received: this.#stats.datagramsReceived,
        sent: this.#stats.datagramsSent,
        dropped: this.#stats.datagramsDropped,
      },
      bytes: {
        received: this.#stats.bytesReceived,
        sent: this.#stats.bytesSent,
      },
    };
  }

  async connect(path: string, headers: HeadersInit = {}): Promise<MockWebTransportSession> {
    if (this.#state !== WebTransportServerState.RUNNING) {
      this.#stats.sessionsRejected += 1;
      throw new SessionRejectedError('The virtual driver is not accepting sessions', {
        code: 'TEST_DRIVER_NOT_READY',
        recoverable: true,
        scope: 'SESSION',
      });
    }
    if (this.#sessions.size >= this.#options.maxSessions) {
      this.#stats.sessionsRejected += 1;
      throw new WebTransportResourceLimitError('The virtual session limit was reached', {
        code: 'TEST_SESSION_LIMIT',
        recoverable: true,
        scope: 'SESSION',
      });
    }

    const numericId = this.#nextSessionId++;
    const id = `virtual-session-${numericId}`;
    let closed = false;
    const hooks: MockSessionStatsHooks = {
      onStreamOpened: () => {
        this.#stats.streamsActive += 1;
        this.#stats.streamsTotal += 1;
      },
      onStreamClosed: () => {
        this.#stats.streamsActive = Math.max(0, this.#stats.streamsActive - 1);
      },
      onDatagramSent: (byteLength) => {
        this.#stats.datagramsSent += 1;
        this.#stats.bytesSent += byteLength;
      },
      onDatagramReceived: (byteLength) => {
        this.#stats.datagramsReceived += 1;
        this.#stats.bytesReceived += byteLength;
      },
      onDatagramDropped: () => {
        this.#stats.datagramsDropped += 1;
      },
      onBytesSent: (byteLength) => {
        this.#stats.bytesSent += byteLength;
      },
      onBytesReceived: (byteLength) => {
        this.#stats.bytesReceived += byteLength;
      },
      onClosed: () => {
        if (closed) {
          return;
        }
        closed = true;
        this.#sessions.delete(id);
        this.#stats.sessionsActive = Math.max(0, this.#stats.sessionsActive - 1);
      },
    };
    const pair = createMockWebTransportSessionPair({
      id,
      path,
      headers,
      remoteAddress: this.#options.remoteAddress,
      remotePort: this.#options.firstRemotePort + numericId - 1,
      incomingStreamQueueSize: this.#options.incomingStreamQueueSize,
      streamQueueSize: this.#options.streamQueueSize,
      streamMaxChunkSize: this.#options.streamMaxChunkSize,
      datagramQueueSize: this.#options.datagramQueueSize,
      maxDatagramSize: this.#options.maxDatagramSize,
      datagramOverflow: this.#options.datagramOverflow,
      hooks,
    });
    this.#sessions.set(id, pair);
    this.#stats.sessionsActive += 1;
    this.#stats.sessionsTotal += 1;

    try {
      for (const callback of [...this.#callbacks]) {
        await callback(pair.server);
      }
    } catch (cause) {
      this.#stats.sessionsRejected += 1;
      await pair.abort(cause);
      throw new SessionRejectedError('A virtual session callback rejected the connection', {
        code: 'TEST_SESSION_CALLBACK_REJECTED',
        recoverable: true,
        scope: 'SESSION',
        cause,
      });
    }

    return pair.client;
  }
}
