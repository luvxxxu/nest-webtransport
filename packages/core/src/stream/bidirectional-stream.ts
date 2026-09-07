export interface WebTransportBidirectionalStream {
  readonly id: bigint;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Aborts exactly once when both directions finish normally or the stream is reset. */
  readonly signal: AbortSignal;

  reset(code?: number): Promise<void>;
}
