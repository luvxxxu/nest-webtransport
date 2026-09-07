export interface WebTransportSendStream {
  readonly id: bigint;
  readonly writable: WritableStream<Uint8Array>;
  /** Aborts exactly once when the send direction finishes normally or is reset. */
  readonly signal: AbortSignal;

  reset(code?: number): Promise<void>;
}
