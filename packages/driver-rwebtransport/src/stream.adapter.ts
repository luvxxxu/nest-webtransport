import type {
  WebTransportBidirectionalStream as NativeBidirectionalStream,
  WebTransportReceiveStream as NativeReceiveStream,
  WebTransportSendStream as NativeSendStream,
} from 'rwebtransport';
import {
  type WebTransportBidirectionalStream as CoreBidirectionalStream,
  type WebTransportReceiveStream as CoreReceiveStream,
  type WebTransportSendStream as CoreSendStream,
  WebTransportProtocolError,
  WebTransportStreamError,
} from 'webtransport-core';

import { createNativeStreamError, mapRWebTransportError } from './error.mapper.js';
import { NOOP_RWEBTRANSPORT_METRICS, type RWebTransportAdapterMetrics } from './metrics.js';

export interface RWebTransportStreamAbortContext {
  readonly signal: AbortSignal;
  subscribe(listener: (reason: unknown) => void): () => void;
}

export function createRWebTransportStreamAbortContext(
  signal: AbortSignal,
): RWebTransportStreamAbortContext {
  return {
    signal,
    subscribe(listener) {
      if (signal.aborted) {
        listener(signal.reason);
        return () => {};
      }

      const handleAbort = (): void => listener(signal.reason);
      signal.addEventListener('abort', handleAbort, { once: true });
      return () => signal.removeEventListener('abort', handleAbort);
    },
  };
}

function streamId(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebTransportProtocolError('rwebtransport returned an invalid stream id', {
      code: 'RWEBTRANSPORT_INVALID_STREAM_ID',
      recoverable: false,
      scope: 'STREAM',
    });
  }

  return BigInt(value);
}

function errorController(
  controller: ReadableStreamDefaultController<Uint8Array> | WritableStreamDefaultController,
  reason: unknown,
): void {
  try {
    controller.error(reason);
  } catch {
    // The Web Streams implementation can be closing concurrently with a peer abort.
    // A terminal controller must not turn that harmless race into an unhandled rejection.
  }
}

class StreamLifecycle {
  readonly controller = new AbortController();

  private remainingParts: number;
  private unsubscribeParent: () => void = () => {};
  private closed = false;

  constructor(
    partCount: number,
    parent: RWebTransportStreamAbortContext,
    private readonly metrics: RWebTransportAdapterMetrics,
  ) {
    this.remainingParts = partCount;
    this.metrics.streamOpened();
    this.unsubscribeParent = parent.subscribe((reason) => this.abort(reason));
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  finishPart(): void {
    if (this.closed) {
      return;
    }

    this.remainingParts = Math.max(0, this.remainingParts - 1);
    if (this.remainingParts === 0) {
      this.abort();
    }
  }

  abort(reason?: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.unsubscribeParent();
    this.controller.abort(reason);
    this.metrics.streamClosed();
  }
}

class ReadableBridge {
  readonly readable: ReadableStream<Uint8Array>;

  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private finished = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    native: ReadableStream<Uint8Array>,
    private readonly lifecycle: StreamLifecycle,
    private readonly metrics: RWebTransportAdapterMetrics,
  ) {
    this.reader = native.getReader();
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const abort = () => {
          if (this.finished) return;
          errorController(controller, this.lifecycle.signal.reason);
          void this.stop(this.lifecycle.signal.reason).catch(() => {});
        };
        this.lifecycle.signal.addEventListener('abort', abort, { once: true });
        if (this.lifecycle.signal.aborted) abort();
        void this.reader.closed.catch((error: unknown) => {
          if (this.finished) return;
          const mapped = mapRWebTransportError(error, {
            target: 'stream',
            operation: 'receive stream closed',
          });
          errorController(controller, mapped);
          this.finish(false);
          this.lifecycle.abort(mapped);
        });
      },
      pull: async (controller) => {
        try {
          const result = await this.reader.read();
          if (result.done) {
            controller.close();
            this.finish();
            return;
          }

          this.metrics.bytesReceived(result.value.byteLength);
          controller.enqueue(result.value);
        } catch (error) {
          const mapped = mapRWebTransportError(error, {
            target: 'stream',
            operation: 'read stream',
          });
          errorController(controller, mapped);
          this.lifecycle.abort(mapped);
          this.finish(false);
        }
      },
      cancel: async (reason) => {
        try {
          await this.reader.cancel(reason);
        } catch (error) {
          throw mapRWebTransportError(error, {
            target: 'stream',
            operation: 'cancel receive stream',
          });
        } finally {
          this.finish();
        }
      },
    });
  }

  stop(reason: unknown): Promise<void> {
    this.stopPromise ??= this.performStop(reason);
    return this.stopPromise;
  }

  private async performStop(reason: unknown): Promise<void> {
    if (this.finished) {
      return;
    }

    try {
      await this.reader.cancel(reason);
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'stream',
        operation: 'stop receive stream',
      });
    } finally {
      this.finish();
    }
  }

  private finish(countAsPart = true): void {
    const firstFinish = !this.finished;
    this.finished = true;
    try {
      this.reader.releaseLock();
    } catch {
      // A pending native read releases its lock after cancellation settles.
    }

    if (firstFinish && countAsPart) {
      this.lifecycle.finishPart();
    }
  }
}

class WritableBridge {
  readonly writable: WritableStream<Uint8Array>;

  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private finished = false;
  private resetPromise: Promise<void> | undefined;

  constructor(
    native: WritableStream<Uint8Array>,
    private readonly lifecycle: StreamLifecycle,
    private readonly metrics: RWebTransportAdapterMetrics,
  ) {
    this.writer = native.getWriter();
    this.writable = new WritableStream<Uint8Array>({
      start: (controller) => {
        const abort = () => {
          if (this.finished) return;
          errorController(controller, this.lifecycle.signal.reason);
          void this.reset(this.lifecycle.signal.reason).catch(() => {});
        };
        this.lifecycle.signal.addEventListener('abort', abort, { once: true });
        if (this.lifecycle.signal.aborted) abort();
        void this.writer.closed.then(
          () => this.finish(),
          (error: unknown) => {
            if (this.finished) return;
            const mapped = mapRWebTransportError(error, {
              target: 'stream',
              operation: 'send stream closed',
            });
            errorController(controller, mapped);
            this.lifecycle.abort(mapped);
            this.finish();
          },
        );
      },
      write: async (chunk) => {
        try {
          await this.writer.write(chunk);
          this.metrics.bytesSent(chunk.byteLength);
        } catch (error) {
          const mapped = mapRWebTransportError(error, {
            target: 'stream',
            operation: 'write stream',
          });
          this.lifecycle.abort(mapped);
          this.finish();
          throw mapped;
        }
      },
      close: async () => {
        try {
          await this.writer.close();
        } catch (error) {
          const mapped = mapRWebTransportError(error, {
            target: 'stream',
            operation: 'close send stream',
          });
          this.lifecycle.abort(mapped);
          throw mapped;
        } finally {
          this.finish();
        }
      },
      abort: async (reason) => {
        try {
          await this.writer.abort(reason);
        } catch (error) {
          throw mapRWebTransportError(error, {
            target: 'stream',
            operation: 'abort send stream',
          });
        } finally {
          this.finish();
        }
      },
    });
  }

  reset(reason: unknown): Promise<void> {
    this.resetPromise ??= this.performReset(reason);
    return this.resetPromise;
  }

  private async performReset(reason: unknown): Promise<void> {
    if (this.finished) {
      return;
    }

    try {
      await this.writer.abort(reason);
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'stream',
        operation: 'reset send stream',
      });
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    if (this.finished) {
      return;
    }

    this.finished = true;
    try {
      this.writer.releaseLock();
    } catch {
      // Ignore duplicate close/abort races from the peer and application.
    }
    this.lifecycle.finishPart();
  }
}

export class RWebTransportReceiveStreamAdapter implements CoreReceiveStream {
  readonly id: bigint;
  readonly readable: ReadableStream<Uint8Array>;

  private readonly lifecycle: StreamLifecycle;
  private readonly bridge: ReadableBridge;

  constructor(
    native: NativeReceiveStream,
    parent: RWebTransportStreamAbortContext,
    metrics: RWebTransportAdapterMetrics = NOOP_RWEBTRANSPORT_METRICS,
  ) {
    this.id = streamId(native.streamId);
    this.lifecycle = new StreamLifecycle(1, parent, metrics);
    this.bridge = new ReadableBridge(native, this.lifecycle, metrics);
    this.readable = this.bridge.readable;
  }

  get signal(): AbortSignal {
    return this.lifecycle.signal;
  }

  async stop(code = 0): Promise<void> {
    const nativeError = createNativeStreamError(code, 'receive stream stopped by application');
    const coreError = new WebTransportStreamError('receive stream stopped by application', {
      code: 'RWEBTRANSPORT_RECEIVE_STREAM_STOPPED',
    });
    const stopping = this.bridge.stop(nativeError);
    this.lifecycle.abort(coreError);
    await stopping;
  }
}

export class RWebTransportSendStreamAdapter implements CoreSendStream {
  readonly id: bigint;
  readonly writable: WritableStream<Uint8Array>;

  private readonly lifecycle: StreamLifecycle;
  private readonly bridge: WritableBridge;

  constructor(
    native: NativeSendStream,
    parent: RWebTransportStreamAbortContext,
    metrics: RWebTransportAdapterMetrics = NOOP_RWEBTRANSPORT_METRICS,
  ) {
    this.id = streamId(native.streamId);
    this.lifecycle = new StreamLifecycle(1, parent, metrics);
    this.bridge = new WritableBridge(native, this.lifecycle, metrics);
    this.writable = this.bridge.writable;
  }

  get signal(): AbortSignal {
    return this.lifecycle.signal;
  }

  async reset(code = 0): Promise<void> {
    const nativeError = createNativeStreamError(code);
    const coreError = new WebTransportStreamError('send stream reset by application', {
      code: 'RWEBTRANSPORT_SEND_STREAM_RESET',
    });
    const resetting = this.bridge.reset(nativeError);
    this.lifecycle.abort(coreError);
    await resetting;
  }
}

export class RWebTransportBidirectionalStreamAdapter implements CoreBidirectionalStream {
  readonly id: bigint;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  private readonly lifecycle: StreamLifecycle;
  private readonly readableBridge: ReadableBridge;
  private readonly writableBridge: WritableBridge;

  constructor(
    native: NativeBidirectionalStream,
    parent: RWebTransportStreamAbortContext,
    metrics: RWebTransportAdapterMetrics = NOOP_RWEBTRANSPORT_METRICS,
  ) {
    if (native.readable.streamId !== native.writable.streamId) {
      throw new WebTransportProtocolError('bidirectional stream halves have different ids', {
        code: 'RWEBTRANSPORT_BIDI_STREAM_ID_MISMATCH',
        recoverable: false,
        scope: 'STREAM',
      });
    }

    this.id = streamId(native.readable.streamId);
    this.lifecycle = new StreamLifecycle(2, parent, metrics);
    this.readableBridge = new ReadableBridge(native.readable, this.lifecycle, metrics);
    this.writableBridge = new WritableBridge(native.writable, this.lifecycle, metrics);
    this.readable = this.readableBridge.readable;
    this.writable = this.writableBridge.writable;
  }

  get signal(): AbortSignal {
    return this.lifecycle.signal;
  }

  async reset(code = 0): Promise<void> {
    const nativeError = createNativeStreamError(code);
    const coreError = new WebTransportStreamError('bidirectional stream reset by application', {
      code: 'RWEBTRANSPORT_BIDI_STREAM_RESET',
    });
    const resetting = Promise.allSettled([
      this.readableBridge.stop(nativeError),
      this.writableBridge.reset(nativeError),
    ]);
    this.lifecycle.abort(coreError);
    const results = await resetting;
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      throw mapRWebTransportError(failure.reason, {
        target: 'stream',
        operation: 'reset bidirectional stream',
      });
    }
  }
}
