import {
  type WebTransportDatagramChannel,
  WebTransportResourceLimitError,
} from 'webtransport-core';

import { BoundedValueQueue, type QueueOverflowPolicy } from './internal/bounded-stream.js';

const DEFAULT_DATAGRAM_QUEUE_SIZE = 64;
const DEFAULT_MAX_DATAGRAM_SIZE = 1_200;

export interface MockDatagramOptions {
  readonly queueSize?: number;
  readonly maxDatagramSize?: number;
  readonly overflow?: QueueOverflowPolicy;
}

interface MockDatagramPairOptions extends MockDatagramOptions {
  readonly assertOpen?: () => void;
  readonly onSent?: (byteLength: number) => void;
  readonly onReceived?: (byteLength: number) => void;
  readonly onDropped?: () => void;
  readonly onCloseSession?: (reason: unknown) => void;
}

export class MockWebTransportDatagramChannel implements WebTransportDatagramChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly maxDatagramSize: number;

  readonly #incoming: BoundedValueQueue<Uint8Array>;
  #writeController?: WritableStreamDefaultController;

  constructor(options: {
    readonly incoming: BoundedValueQueue<Uint8Array>;
    readonly maxDatagramSize: number;
    readonly queueSize: number;
    readonly send: (datagram: Uint8Array) => void;
  }) {
    this.#incoming = options.incoming;
    this.readable = options.incoming.readable;
    this.maxDatagramSize = options.maxDatagramSize;
    this.writable = new WritableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#writeController = controller;
        },
        write: (datagram) => {
          if (!(datagram instanceof Uint8Array)) {
            throw new TypeError('Virtual datagrams must be Uint8Array values');
          }
          if (datagram.byteLength > this.maxDatagramSize) {
            throw new WebTransportResourceLimitError(
              `Datagram size ${datagram.byteLength} exceeds the ${this.maxDatagramSize} byte limit`,
              {
                code: 'TEST_DATAGRAM_TOO_LARGE',
                recoverable: true,
                scope: 'HANDLER',
              },
            );
          }
          options.send(datagram.slice());
        },
      },
      new CountQueuingStrategy({ highWaterMark: options.queueSize }),
    );
  }

  close(reason?: unknown): void {
    this.#incoming.close({ discard: true });
    this.#errorWritable(reason ?? new DOMException('The virtual session closed', 'AbortError'));
  }

  abort(reason?: unknown): void {
    const error = reason ?? new DOMException('The virtual session was aborted', 'AbortError');
    this.#incoming.abort(error);
    this.#errorWritable(error);
  }

  #errorWritable(reason: unknown): void {
    try {
      this.#writeController?.error(reason);
    } catch {
      // The writable may already be terminal.
    }
  }
}

export interface MockDatagramChannelPair {
  readonly first: MockWebTransportDatagramChannel;
  readonly second: MockWebTransportDatagramChannel;
  close(reason?: unknown): void;
  abort(reason?: unknown): void;
}

export function createMockDatagramChannelPair(
  options: MockDatagramPairOptions = {},
): MockDatagramChannelPair {
  const queueSize = options.queueSize ?? DEFAULT_DATAGRAM_QUEUE_SIZE;
  const maxDatagramSize = options.maxDatagramSize ?? DEFAULT_MAX_DATAGRAM_SIZE;
  const overflow = options.overflow ?? 'drop-oldest';

  const queueOptions = {
    capacity: queueSize,
    overflow,
    ...(options.onDropped === undefined
      ? {}
      : { onDrop: (_datagram: Uint8Array) => options.onDropped?.() }),
    ...(options.onCloseSession === undefined ? {} : { onCloseSession: options.onCloseSession }),
  } as const;
  const firstIncoming = new BoundedValueQueue<Uint8Array>(queueOptions);
  const secondIncoming = new BoundedValueQueue<Uint8Array>(queueOptions);

  const deliver = (target: BoundedValueQueue<Uint8Array>, datagram: Uint8Array): void => {
    options.assertOpen?.();
    options.onSent?.(datagram.byteLength);
    const result = target.push(datagram);
    if (result.accepted) {
      options.onReceived?.(datagram.byteLength);
    }
  };

  const first = new MockWebTransportDatagramChannel({
    incoming: firstIncoming,
    maxDatagramSize,
    queueSize,
    send: (datagram) => deliver(secondIncoming, datagram),
  });
  const second = new MockWebTransportDatagramChannel({
    incoming: secondIncoming,
    maxDatagramSize,
    queueSize,
    send: (datagram) => deliver(firstIncoming, datagram),
  });

  return {
    first,
    second,
    close: (reason?: unknown) => {
      first.close(reason);
      second.close(reason);
    },
    abort: (reason?: unknown) => {
      first.abort(reason);
      second.abort(reason);
    },
  };
}

export type { QueueOverflowPolicy };
