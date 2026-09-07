import {
  StreamResetError,
  type WebTransportBidirectionalStream,
  type WebTransportReceiveStream,
  type WebTransportSendStream,
} from 'webtransport-core';

import { BoundedBytePipe } from './internal/bounded-stream.js';

const DEFAULT_STREAM_QUEUE_SIZE = 16;
const DEFAULT_MAX_CHUNK_SIZE = 64 * 1024;

export interface MockStreamOptions {
  readonly queueSize?: number;
  readonly maxChunkSize?: number;
}

interface MockStreamPairOptions extends MockStreamOptions {
  readonly id: bigint;
  readonly onFirstToSecondBytes?: (byteLength: number) => void;
  readonly onSecondToFirstBytes?: (byteLength: number) => void;
  readonly onTerminal?: () => void;
}

export class MockStreamResetError extends StreamResetError {
  readonly resetCode: number;

  constructor(streamId: bigint, resetCode: number, cause?: unknown) {
    super(`Virtual stream ${streamId} was reset with code ${resetCode}`, {
      code: 'TEST_STREAM_RESET',
      recoverable: true,
      scope: 'STREAM',
      ...(cause === undefined ? {} : { cause }),
    });
    this.resetCode = resetCode;
  }
}

class StreamLifecycle {
  readonly signal: AbortSignal;

  readonly #id: bigint;
  readonly #controller = new AbortController();
  readonly #pipes: BoundedBytePipe[] = [];
  readonly #onTerminal: (() => void) | undefined;
  #remainingPipes: number;
  #terminalNotified = false;

  constructor(id: bigint, pipeCount: number, onTerminal?: () => void) {
    this.#id = id;
    this.#remainingPipes = pipeCount;
    this.#onTerminal = onTerminal;
    this.signal = this.#controller.signal;
  }

  addPipe(pipe: BoundedBytePipe): void {
    this.#pipes.push(pipe);
  }

  pipeTerminated(): void {
    this.#remainingPipes = Math.max(0, this.#remainingPipes - 1);
    if (this.#remainingPipes === 0) {
      this.#notifyTerminal();
    }
  }

  async reset(code = 0, cause?: unknown): Promise<void> {
    if (this.signal.aborted) {
      return;
    }

    const error = new MockStreamResetError(this.#id, code, cause);
    this.#controller.abort(error);
    for (const pipe of this.#pipes) {
      pipe.abort(error);
    }
    this.#notifyTerminal();
  }

  #notifyTerminal(): void {
    if (this.#terminalNotified) {
      return;
    }
    this.#terminalNotified = true;
    if (!this.signal.aborted) {
      this.#controller.abort();
    }
    this.#onTerminal?.();
  }
}

export class MockWebTransportBidirectionalStream implements WebTransportBidirectionalStream {
  readonly id: bigint;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly signal: AbortSignal;

  readonly #reset: (code?: number) => Promise<void>;

  constructor(options: {
    readonly id: bigint;
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly signal: AbortSignal;
    readonly reset: (code?: number) => Promise<void>;
  }) {
    this.id = options.id;
    this.readable = options.readable;
    this.writable = options.writable;
    this.signal = options.signal;
    this.#reset = options.reset;
  }

  reset(code?: number): Promise<void> {
    return this.#reset(code);
  }
}

export class MockWebTransportSendStream implements WebTransportSendStream {
  readonly id: bigint;
  readonly writable: WritableStream<Uint8Array>;
  readonly signal: AbortSignal;

  readonly #reset: (code?: number) => Promise<void>;

  constructor(options: {
    readonly id: bigint;
    readonly writable: WritableStream<Uint8Array>;
    readonly signal: AbortSignal;
    readonly reset: (code?: number) => Promise<void>;
  }) {
    this.id = options.id;
    this.writable = options.writable;
    this.signal = options.signal;
    this.#reset = options.reset;
  }

  reset(code?: number): Promise<void> {
    return this.#reset(code);
  }
}

export class MockWebTransportReceiveStream implements WebTransportReceiveStream {
  readonly id: bigint;
  readonly readable: ReadableStream<Uint8Array>;
  readonly signal: AbortSignal;

  readonly #stop: (code?: number) => Promise<void>;

  constructor(options: {
    readonly id: bigint;
    readonly readable: ReadableStream<Uint8Array>;
    readonly signal: AbortSignal;
    readonly stop: (code?: number) => Promise<void>;
  }) {
    this.id = options.id;
    this.readable = options.readable;
    this.signal = options.signal;
    this.#stop = options.stop;
  }

  stop(code?: number): Promise<void> {
    return this.#stop(code);
  }
}

export interface MockBidirectionalStreamPair {
  readonly first: MockWebTransportBidirectionalStream;
  readonly second: MockWebTransportBidirectionalStream;
  reset(code?: number, cause?: unknown): Promise<void>;
}

export interface MockUnidirectionalStreamPair {
  readonly sender: MockWebTransportSendStream;
  readonly receiver: MockWebTransportReceiveStream;
  reset(code?: number, cause?: unknown): Promise<void>;
}

export function createMockBidirectionalStreamPair(
  options: MockStreamPairOptions,
): MockBidirectionalStreamPair {
  const lifecycle = new StreamLifecycle(options.id, 2, options.onTerminal);
  const firstToSecond = new BoundedBytePipe({
    capacity: options.queueSize ?? DEFAULT_STREAM_QUEUE_SIZE,
    maxChunkSize: options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE,
    ...(options.onFirstToSecondBytes === undefined
      ? {}
      : { onBytes: options.onFirstToSecondBytes }),
    onTerminal: () => lifecycle.pipeTerminated(),
  });
  const secondToFirst = new BoundedBytePipe({
    capacity: options.queueSize ?? DEFAULT_STREAM_QUEUE_SIZE,
    maxChunkSize: options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE,
    ...(options.onSecondToFirstBytes === undefined
      ? {}
      : { onBytes: options.onSecondToFirstBytes }),
    onTerminal: () => lifecycle.pipeTerminated(),
  });
  lifecycle.addPipe(firstToSecond);
  lifecycle.addPipe(secondToFirst);

  const reset = (code?: number): Promise<void> => lifecycle.reset(code);
  return {
    first: new MockWebTransportBidirectionalStream({
      id: options.id,
      readable: secondToFirst.readable,
      writable: firstToSecond.writable,
      signal: lifecycle.signal,
      reset,
    }),
    second: new MockWebTransportBidirectionalStream({
      id: options.id,
      readable: firstToSecond.readable,
      writable: secondToFirst.writable,
      signal: lifecycle.signal,
      reset,
    }),
    reset: (code?: number, cause?: unknown) => lifecycle.reset(code, cause),
  };
}

export function createMockUnidirectionalStreamPair(
  options: Omit<MockStreamPairOptions, 'onSecondToFirstBytes'>,
): MockUnidirectionalStreamPair {
  const lifecycle = new StreamLifecycle(options.id, 1, options.onTerminal);
  const pipe = new BoundedBytePipe({
    capacity: options.queueSize ?? DEFAULT_STREAM_QUEUE_SIZE,
    maxChunkSize: options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE,
    ...(options.onFirstToSecondBytes === undefined
      ? {}
      : { onBytes: options.onFirstToSecondBytes }),
    onTerminal: () => lifecycle.pipeTerminated(),
  });
  lifecycle.addPipe(pipe);

  const reset = (code?: number): Promise<void> => lifecycle.reset(code);
  return {
    sender: new MockWebTransportSendStream({
      id: options.id,
      writable: pipe.writable,
      signal: lifecycle.signal,
      reset,
    }),
    receiver: new MockWebTransportReceiveStream({
      id: options.id,
      readable: pipe.readable,
      signal: lifecycle.signal,
      stop: reset,
    }),
    reset: (code?: number, cause?: unknown) => lifecycle.reset(code, cause),
  };
}
