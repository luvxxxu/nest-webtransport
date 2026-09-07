export interface WebTransportReceiveStream {
  readonly id: bigint;
  readonly readable: ReadableStream<Uint8Array>;
  /** Aborts exactly once when the receive direction finishes normally or is stopped. */
  readonly signal: AbortSignal;

  stop(code?: number): Promise<void>;
}
