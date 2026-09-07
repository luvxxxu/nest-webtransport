import type { WebTransportDatagramDuplexStream as NativeDatagramChannel } from 'rwebtransport';
import type { WebTransportDatagramChannel as CoreDatagramChannel } from 'webtransport-core';

import { mapRWebTransportError } from './error.mapper.js';
import { NOOP_RWEBTRANSPORT_METRICS, type RWebTransportAdapterMetrics } from './metrics.js';

export interface RWebTransportDatagramActivity {
  received(): void;
  sent(): void;
}

const NOOP_DATAGRAM_ACTIVITY: RWebTransportDatagramActivity = Object.freeze({
  received() {},
  sent() {},
});

export class RWebTransportDatagramAdapter implements CoreDatagramChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readController!: ReadableStreamDefaultController<Uint8Array>;
  private writeController!: WritableStreamDefaultController;
  private readerReleased = false;
  private writerReleased = false;

  constructor(
    private readonly native: NativeDatagramChannel,
    metrics: RWebTransportAdapterMetrics = NOOP_RWEBTRANSPORT_METRICS,
    activity: RWebTransportDatagramActivity = NOOP_DATAGRAM_ACTIVITY,
  ) {
    this.reader = native.readable.getReader();
    this.writer = native.writable.getWriter();

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readController = controller;
        void this.reader.closed.catch((error: unknown) => {
          if (this.readerReleased) return;
          controller.error(
            mapRWebTransportError(error, {
              target: 'session',
              operation: 'datagram reader closed',
            }),
          );
          this.releaseReader();
        });
      },
      pull: async (controller) => {
        try {
          const result = await this.reader.read();
          if (result.done) {
            controller.close();
            this.releaseReader();
            return;
          }

          activity.received();
          metrics.datagramReceived(result.value.byteLength);
          controller.enqueue(result.value);
        } catch (error) {
          controller.error(
            mapRWebTransportError(error, {
              target: 'session',
              operation: 'read datagram',
            }),
          );
          this.releaseReader();
        }
      },
      cancel: async (reason) => {
        try {
          await this.reader.cancel(reason);
        } catch (error) {
          throw mapRWebTransportError(error, {
            target: 'session',
            operation: 'cancel datagram reader',
          });
        } finally {
          this.releaseReader();
        }
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      start: (controller) => {
        this.writeController = controller;
        void this.writer.closed.then(
          () => this.releaseWriter(),
          (error: unknown) => {
            if (this.writerReleased) return;
            controller.error(
              mapRWebTransportError(error, {
                target: 'session',
                operation: 'datagram writer closed',
              }),
            );
            this.releaseWriter();
          },
        );
      },
      write: async (chunk) => {
        try {
          await this.writer.write(chunk);
          activity.sent();
          metrics.datagramSent(chunk.byteLength);
        } catch (error) {
          throw mapRWebTransportError(error, {
            target: 'session',
            operation: 'write datagram',
          });
        }
      },
      close: async () => {
        try {
          await this.writer.close();
        } catch (error) {
          throw mapRWebTransportError(error, {
            target: 'session',
            operation: 'close datagram writer',
          });
        } finally {
          this.releaseWriter();
        }
      },
      abort: async (reason) => {
        try {
          await this.writer.abort(reason);
        } catch (error) {
          throw mapRWebTransportError(error, {
            target: 'session',
            operation: 'abort datagram writer',
          });
        } finally {
          this.releaseWriter();
        }
      },
    });
  }

  get maxDatagramSize(): number {
    return this.native.maxDatagramSize;
  }

  async close(reason?: unknown): Promise<void> {
    const error = reason ?? new DOMException('Datagram session closed', 'AbortError');
    this.readController.error(error);
    this.writeController.error(error);
    await Promise.allSettled([this.reader.cancel(reason), this.writer.abort(reason)]);
    this.releaseReader();
    this.releaseWriter();
  }

  private releaseReader(): void {
    if (this.readerReleased) return;
    this.readerReleased = true;
    try {
      this.reader.releaseLock();
    } catch {
      // The lock may already have been released by a concurrent session close.
    }
  }

  private releaseWriter(): void {
    if (this.writerReleased) return;
    this.writerReleased = true;
    try {
      this.writer.releaseLock();
    } catch {
      // The lock may already have been released by a concurrent session close.
    }
  }
}
