export type QueueOverflowPolicy = 'drop-oldest' | 'drop-newest' | 'reject' | 'close-session';

export interface QueuePushResult<T> {
  readonly accepted: boolean;
  readonly dropped?: T;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function abortReason(reason: unknown, fallback: string): unknown {
  return reason ?? new DOMException(fallback, 'AbortError');
}

/**
 * A deterministic in-memory byte pipe. The readable side has a hard chunk
 * bound and the writable side waits for consumer demand instead of growing an
 * application-owned queue.
 */
export class BoundedBytePipe {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  readonly #capacity: number;
  readonly #maxChunkSize: number;
  readonly #onBytes: ((byteLength: number) => void) | undefined;
  readonly #onTerminal: (() => void) | undefined;

  #readController!: ReadableStreamDefaultController<Uint8Array>;
  #writeController: WritableStreamDefaultController | undefined;
  #removeWritableAbortListener: (() => void) | undefined;
  #capacityWaiter: Deferred | undefined;
  #state: 'open' | 'closed' | 'aborted' = 'open';
  #terminalNotified = false;

  constructor(options: {
    readonly capacity: number;
    readonly maxChunkSize: number;
    readonly onBytes?: (byteLength: number) => void;
    readonly onTerminal?: () => void;
  }) {
    assertPositiveInteger(options.capacity, 'capacity');
    assertPositiveInteger(options.maxChunkSize, 'maxChunkSize');

    this.#capacity = options.capacity;
    this.#maxChunkSize = options.maxChunkSize;
    this.#onBytes = options.onBytes;
    this.#onTerminal = options.onTerminal;

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#readController = controller;
        },
        pull: () => {
          this.#releaseCapacityWaiter();
        },
        cancel: (reason) => {
          this.abort(abortReason(reason, 'The receiving side cancelled the stream'));
        },
      },
      new CountQueuingStrategy({ highWaterMark: this.#capacity }),
    );

    this.writable = new WritableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#writeController = controller;
          // WritableStream delays the sink abort callback until an in-flight
          // write finishes. Observe its signal so a backpressured write can be
          // interrupted before that callback would otherwise wait forever.
          const abort = (): void => this.#abort(controller.signal.reason, false);
          controller.signal.addEventListener('abort', abort, { once: true });
          this.#removeWritableAbortListener = () =>
            controller.signal.removeEventListener('abort', abort);
        },
        write: async (chunk) => {
          try {
            this.#assertChunk(chunk);
            await this.#waitForCapacity();
            this.#assertOpen();
            this.#readController.enqueue(new Uint8Array(chunk));
            this.#onBytes?.(chunk.byteLength);
          } catch (error) {
            this.abort(error);
            throw error;
          }
        },
        close: () => {
          this.close();
        },
        abort: (reason) => {
          this.abort(abortReason(reason, 'The sending side aborted the stream'));
        },
      },
      new CountQueuingStrategy({ highWaterMark: this.#capacity }),
    );
  }

  close(): void {
    if (this.#state !== 'open') {
      return;
    }

    this.#state = 'closed';
    this.#releaseCapacityWaiter();
    try {
      this.#readController.close();
    } catch {
      // A reader may already have cancelled the stream.
    }
    this.#notifyTerminal();
  }

  abort(reason?: unknown): void {
    this.#abort(reason, true);
  }

  #abort(reason: unknown, errorWritable: boolean): void {
    if (this.#state !== 'open') {
      return;
    }

    const error = abortReason(reason, 'The virtual stream was aborted');
    this.#state = 'aborted';
    this.#rejectCapacityWaiter(error);
    try {
      this.#readController.error(error);
    } catch {
      // The readable may already be terminal.
    }
    if (errorWritable) {
      try {
        this.#writeController?.error(error);
      } catch {
        // The writable may already be terminal.
      }
    }
    this.#notifyTerminal();
  }

  #assertChunk(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Virtual streams only accept Uint8Array chunks');
    }
    if (chunk.byteLength > this.#maxChunkSize) {
      throw new RangeError(
        `Chunk size ${chunk.byteLength} exceeds the ${this.#maxChunkSize} byte limit`,
      );
    }
  }

  #assertOpen(): void {
    if (this.#state !== 'open') {
      throw new DOMException('The virtual stream is closed', 'InvalidStateError');
    }
  }

  async #waitForCapacity(): Promise<void> {
    this.#assertOpen();
    while ((this.#readController.desiredSize ?? 0) <= 0) {
      this.#capacityWaiter ??= createDeferred();
      await this.#capacityWaiter.promise;
      this.#assertOpen();
    }
  }

  #releaseCapacityWaiter(): void {
    const waiter = this.#capacityWaiter;
    this.#capacityWaiter = undefined;
    waiter?.resolve();
  }

  #rejectCapacityWaiter(reason: unknown): void {
    const waiter = this.#capacityWaiter;
    this.#capacityWaiter = undefined;
    waiter?.reject(reason);
  }

  #notifyTerminal(): void {
    if (this.#terminalNotified) {
      return;
    }
    this.#terminalNotified = true;
    this.#removeWritableAbortListener?.();
    this.#removeWritableAbortListener = undefined;
    this.#onTerminal?.();
  }
}

/** A hard-bounded queue exposed as a demand-driven ReadableStream. */
export class BoundedValueQueue<T> {
  readonly readable: ReadableStream<T>;

  readonly #capacity: number;
  readonly #overflow: QueueOverflowPolicy;
  readonly #onDrop: ((value: T) => void) | undefined;
  readonly #onCloseSession: ((reason: unknown) => void) | undefined;
  readonly #values: T[] = [];

  #controller!: ReadableStreamDefaultController<T>;
  #waitingForValue = false;
  #state: 'open' | 'closing' | 'closed' | 'aborted' = 'open';

  constructor(options: {
    readonly capacity: number;
    readonly overflow: QueueOverflowPolicy;
    readonly onDrop?: (value: T) => void;
    readonly onCloseSession?: (reason: unknown) => void;
  }) {
    assertPositiveInteger(options.capacity, 'capacity');
    this.#capacity = options.capacity;
    this.#overflow = options.overflow;
    this.#onDrop = options.onDrop;
    this.#onCloseSession = options.onCloseSession;

    this.readable = new ReadableStream<T>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => {
          this.#flushOne();
        },
        cancel: (reason) => {
          this.abort(abortReason(reason, 'The queue consumer cancelled'));
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
  }

  get size(): number {
    return this.#values.length;
  }

  push(value: T): QueuePushResult<T> {
    if (this.#state !== 'open') {
      throw new DOMException('The queue is closed', 'InvalidStateError');
    }

    if (this.#waitingForValue) {
      this.#waitingForValue = false;
      this.#controller.enqueue(value);
      return { accepted: true };
    }

    if (this.#values.length < this.#capacity) {
      this.#values.push(value);
      return { accepted: true };
    }

    if (this.#overflow === 'drop-oldest') {
      const dropped = this.#values.shift();
      if (dropped !== undefined) {
        this.#onDrop?.(dropped);
      }
      this.#values.push(value);
      return dropped === undefined ? { accepted: true } : { accepted: true, dropped };
    }

    this.#onDrop?.(value);
    if (this.#overflow === 'drop-newest') {
      return { accepted: false, dropped: value };
    }

    const error = new DOMException('The bounded queue is full', 'QuotaExceededError');
    if (this.#overflow === 'close-session') {
      this.#onCloseSession?.(error);
    }
    throw error;
  }

  close(options: { readonly discard?: boolean } = {}): void {
    if (this.#state !== 'open' && this.#state !== 'closing') {
      return;
    }

    if (options.discard) {
      this.#values.length = 0;
    }

    this.#state = 'closing';
    if (this.#values.length === 0) {
      this.#finishClose();
    }
  }

  abort(reason?: unknown): void {
    if (this.#state === 'closed' || this.#state === 'aborted') {
      return;
    }

    this.#state = 'aborted';
    this.#values.length = 0;
    this.#waitingForValue = false;
    try {
      this.#controller.error(abortReason(reason, 'The bounded queue was aborted'));
    } catch {
      // The consumer may already have cancelled the stream.
    }
  }

  #flushOne(): void {
    const value = this.#values.shift();
    if (value !== undefined) {
      this.#controller.enqueue(value);
      if (this.#values.length === 0 && this.#state === 'closing') {
        this.#finishClose();
      }
      return;
    }

    if (this.#state === 'closing') {
      this.#finishClose();
      return;
    }

    if (this.#state === 'open') {
      this.#waitingForValue = true;
    }
  }

  #finishClose(): void {
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'closed';
    this.#waitingForValue = false;
    try {
      this.#controller.close();
    } catch {
      // The consumer may already have cancelled the stream.
    }
  }
}
