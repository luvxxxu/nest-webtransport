import { randomUUID } from 'node:crypto';
import type {
  WebTransportBidirectionalStream as NativeBidirectionalStream,
  WebTransportConnectionStats as NativeConnectionStats,
  WebTransportReceiveStream as NativeReceiveStream,
  WebTransportServerSession as NativeSession,
} from 'rwebtransport';
import {
  type WebTransportConnectionStats as CoreConnectionStats,
  type WebTransportSession as CoreSession,
  type WebTransportSessionState as CoreSessionState,
  type KeyingMaterialExportOptions,
  SessionClosedError,
  type SessionCloseOptions,
  WebTransportSessionState,
} from 'webtransport-core';

import { RWebTransportDatagramAdapter } from './datagram.adapter.js';
import { mapRWebTransportError } from './error.mapper.js';
import { NOOP_RWEBTRANSPORT_METRICS, type RWebTransportAdapterMetrics } from './metrics.js';
import {
  RWebTransportBidirectionalStreamAdapter,
  RWebTransportReceiveStreamAdapter,
  RWebTransportSendStreamAdapter,
  type RWebTransportStreamAbortContext,
} from './stream.adapter.js';

export interface RWebTransportSessionEvents {
  closed(session: RWebTransportSessionAdapter, error?: unknown): void;
}

const NOOP_SESSION_EVENTS: RWebTransportSessionEvents = Object.freeze({
  closed() {},
});

interface IncomingStreamBridge<T> {
  readonly readable: ReadableStream<T>;
  cancel(reason?: unknown): Promise<void>;
}

function mapIncomingStream<Native, Adapted>(
  source: ReadableStream<Native>,
  adapt: (stream: Native) => Adapted,
): IncomingStreamBridge<Adapted> {
  const reader = source.getReader();
  let finished = false;

  const release = (): void => {
    finished = true;
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may still be settling; there is no additional work to enqueue.
    }
  };

  const cancel = async (reason?: unknown): Promise<void> => {
    if (finished) {
      return;
    }
    try {
      await reader.cancel(reason);
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'session',
        operation: 'cancel incoming stream reader',
      });
    } finally {
      release();
    }
  };

  return {
    readable: new ReadableStream<Adapted>({
      pull: async (controller) => {
        try {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            release();
            return;
          }
          controller.enqueue(adapt(result.value));
        } catch (error) {
          controller.error(
            mapRWebTransportError(error, {
              target: 'session',
              operation: 'read incoming stream',
            }),
          );
          release();
        }
      },
      cancel,
    }),
    cancel,
  };
}

export class RWebTransportSessionAdapter implements CoreSession {
  readonly id: string;
  readonly path: string;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly datagrams: RWebTransportDatagramAdapter;
  readonly incomingBidirectionalStreams: ReadableStream<RWebTransportBidirectionalStreamAdapter>;
  readonly incomingUnidirectionalStreams: ReadableStream<RWebTransportReceiveStreamAdapter>;

  private readonly abortController = new AbortController();
  private readonly requestHeaders: Headers;
  private readonly streamAbortListeners = new Set<(reason: unknown) => void>();
  private readonly streamAbortContext: RWebTransportStreamAbortContext;
  private readonly bidiBridge: IncomingStreamBridge<RWebTransportBidirectionalStreamAdapter>;
  private readonly uniBridge: IncomingStreamBridge<RWebTransportReceiveStreamAdapter>;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private currentState: CoreSessionState = WebTransportSessionState.CONNECTED;
  private closePromise?: Promise<void>;
  private terminalError?: unknown;
  private closedNotified = false;
  private datagramsReceived = 0;
  private datagramsSent = 0;
  private observedDroppedDatagrams = 0;

  constructor(
    private readonly native: NativeSession,
    private readonly metrics: RWebTransportAdapterMetrics = NOOP_RWEBTRANSPORT_METRICS,
    private readonly events: RWebTransportSessionEvents = NOOP_SESSION_EVENTS,
    id: string = randomUUID(),
  ) {
    this.id = id;
    this.path = native.path;
    this.requestHeaders = new Headers(native.headers);
    if (native.origin !== null) {
      this.requestHeaders.set('origin', native.origin);
    }
    this.remoteAddress = native.remoteAddress;
    this.remotePort = native.remotePort;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.streamAbortContext = {
      signal: this.abortController.signal,
      subscribe: (listener) => {
        if (this.abortController.signal.aborted) {
          listener(this.abortController.signal.reason);
          return () => {};
        }
        this.streamAbortListeners.add(listener);
        return () => this.streamAbortListeners.delete(listener);
      },
    };

    this.datagrams = new RWebTransportDatagramAdapter(native.datagrams, metrics, {
      received: () => {
        this.datagramsReceived += 1;
      },
      sent: () => {
        this.datagramsSent += 1;
      },
    });
    this.bidiBridge = mapIncomingStream(
      native.incomingBidirectionalStreams,
      (stream: NativeBidirectionalStream) =>
        new RWebTransportBidirectionalStreamAdapter(stream, this.streamAbortContext, metrics),
    );
    this.uniBridge = mapIncomingStream(
      native.incomingUnidirectionalStreams,
      (stream: NativeReceiveStream) =>
        new RWebTransportReceiveStreamAdapter(stream, this.streamAbortContext, metrics),
    );
    this.incomingBidirectionalStreams = this.bidiBridge.readable;
    this.incomingUnidirectionalStreams = this.uniBridge.readable;

    void native.ready.catch((error) => {
      this.finish(
        mapRWebTransportError(error, {
          target: 'session',
          operation: 'establish session',
        }),
      );
    });
    void native.closed.then(
      () => this.finish(),
      (error) =>
        this.finish(
          mapRWebTransportError(error, {
            target: 'session',
            operation: 'session closed',
          }),
        ),
    );
  }

  get state(): CoreSessionState {
    return this.currentState;
  }

  get headers(): Readonly<Headers> {
    return new Headers(this.requestHeaders);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get closed(): Promise<void> {
    return this.closedPromise;
  }

  async createBidirectionalStream(): Promise<RWebTransportBidirectionalStreamAdapter> {
    this.assertConnected();
    try {
      const native = await this.native.createBidirectionalStream();
      return new RWebTransportBidirectionalStreamAdapter(
        native,
        this.streamAbortContext,
        this.metrics,
      );
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'session',
        operation: 'create bidirectional stream',
      });
    }
  }

  async createUnidirectionalStream(): Promise<RWebTransportSendStreamAdapter> {
    this.assertConnected();
    try {
      const native = await this.native.createUnidirectionalStream();
      return new RWebTransportSendStreamAdapter(native, this.streamAbortContext, this.metrics);
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'session',
        operation: 'create unidirectional stream',
      });
    }
  }

  close(options: SessionCloseOptions = {}): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.currentState === WebTransportSessionState.CLOSED) {
      return this.closedPromise;
    }

    this.currentState = WebTransportSessionState.CLOSING;
    this.closePromise = (async () => {
      try {
        this.native.close({
          closeCode: options.closeCode ?? 0,
          reason: options.reason ?? '',
        });
        await this.closedPromise;
        if (this.terminalError !== undefined) {
          throw this.terminalError;
        }
      } catch (error) {
        const mapped = mapRWebTransportError(error, {
          target: 'session',
          operation: 'close session',
        });
        this.finish(mapped);
        throw mapped;
      }
    })();
    void this.closePromise.catch(() => {});
    return this.closePromise;
  }

  async exportKeyingMaterial(options: KeyingMaterialExportOptions): Promise<Uint8Array> {
    this.assertConnected();
    if (!Number.isSafeInteger(options.length) || options.length <= 0) {
      throw new RangeError('keying material length must be a positive safe integer');
    }

    try {
      return await this.native.exportKeyingMaterial(
        new TextEncoder().encode(options.label),
        options.context ?? new Uint8Array(),
        options.length,
      );
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'session',
        operation: 'export keying material',
      });
    }
  }

  drain(): void {
    if (this.currentState !== WebTransportSessionState.CONNECTED) {
      return;
    }
    try {
      this.native.drain();
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'session',
        operation: 'drain session',
      });
    }
  }

  async captureConnectionStats(): Promise<CoreConnectionStats> {
    let stats: NativeConnectionStats;
    try {
      stats = await this.native.getStats();
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'session',
        operation: 'read connection stats',
      });
    }

    const dropped =
      stats.datagrams.droppedIncoming +
      stats.datagrams.expiredIncoming +
      stats.datagrams.expiredOutgoing +
      stats.datagrams.lostOutgoing;
    const newlyDropped = Math.max(0, dropped - this.observedDroppedDatagrams);
    this.observedDroppedDatagrams = Math.max(this.observedDroppedDatagrams, dropped);
    if (newlyDropped > 0) {
      this.metrics.datagramDropped(newlyDropped);
    }

    return {
      sessionId: this.id,
      remoteAddress: this.remoteAddress,
      remotePort: this.remotePort,
      bytesReceived: stats.bytesReceived,
      bytesSent: stats.bytesSent,
      datagramsReceived: this.datagramsReceived,
      datagramsSent: this.datagramsSent,
      packetsLost: stats.packetsLost,
      smoothedRttMs: stats.smoothedRtt,
    };
  }

  private assertConnected(): void {
    if (this.currentState !== WebTransportSessionState.CONNECTED) {
      throw new SessionClosedError('WebTransport session is not connected', {
        code: 'RWEBTRANSPORT_SESSION_NOT_CONNECTED',
      });
    }
  }

  private finish(error?: unknown): void {
    if (this.currentState === WebTransportSessionState.CLOSED) {
      return;
    }

    this.currentState = WebTransportSessionState.CLOSED;
    this.terminalError = error;
    const reason = error ?? new DOMException('Session closed', 'AbortError');
    this.abortController.abort(reason);
    for (const listener of this.streamAbortListeners) {
      try {
        listener(reason);
      } catch {
        // A stream must not prevent sibling streams from observing session close.
      }
    }
    this.streamAbortListeners.clear();
    this.resolveClosed();

    void this.bidiBridge.cancel(reason).catch(() => {});
    void this.uniBridge.cancel(reason).catch(() => {});
    void this.datagrams.close(reason).catch(() => {});

    if (!this.closedNotified) {
      this.closedNotified = true;
      try {
        this.events.closed(this, error);
      } catch {
        // Lifecycle observers cannot reopen or destabilize a terminal session.
      }
    }
  }
}
