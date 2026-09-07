export interface RWebTransportAdapterMetrics {
  streamOpened(): void;
  streamClosed(): void;
  bytesReceived(bytes: number): void;
  bytesSent(bytes: number): void;
  datagramReceived(bytes: number): void;
  datagramSent(bytes: number): void;
  datagramDropped(count?: number): void;
}

export const NOOP_RWEBTRANSPORT_METRICS: RWebTransportAdapterMetrics = Object.freeze({
  streamOpened() {},
  streamClosed() {},
  bytesReceived() {},
  bytesSent() {},
  datagramReceived() {},
  datagramSent() {},
  datagramDropped() {},
});
