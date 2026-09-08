import type { BoundedQueueOverflowPolicy } from '../utilities/bounded-queue.js';

export type DatagramOverflowPolicy = BoundedQueueOverflowPolicy;

export type HandlerOverflowPolicy = 'drop' | 'reject' | 'close-session';

export interface WebTransportServerLimits {
  readonly maxSessions: number;
  /** Aggregate execution limits across all sessions, including admission. */
  readonly maxConcurrentHandlers: number;
  readonly maxPendingHandlers: number;
  /** Bytes retained in framework datagram queues, including scheduled work. */
  readonly maxQueuedDatagramBytes: number;
  /** Active decorator-managed incoming streams across all sessions. */
  readonly maxStreams: number;
}

export interface WebTransportIpLimits {
  readonly maxSessions: number;
  readonly sessionsPerSecond: number;
}

export interface WebTransportSessionLimits {
  readonly maxBidirectionalStreams: number;
  readonly maxUnidirectionalStreams: number;
  readonly maxDatagramsPerSecond: number;
  readonly maxConcurrentHandlers: number;
  readonly maxPendingHandlers: number;
}

export interface WebTransportStreamLimits {
  readonly maxLifetimeMs: number;
}

export interface WebTransportResourceLimits {
  readonly server: WebTransportServerLimits;
  readonly ip: WebTransportIpLimits;
  readonly session: WebTransportSessionLimits;
  readonly stream: WebTransportStreamLimits;
}

export interface WebTransportDatagramQueueOptions {
  readonly size: number;
  readonly overflow: DatagramOverflowPolicy;
}

export interface WebTransportExecutionOptions {
  readonly maxConcurrentHandlers: number;
  readonly maxPendingHandlers: number;
  readonly overflow: HandlerOverflowPolicy;
}
