import type { WebTransportDatagramChannel } from '../datagram/datagram-channel.js';
import type { WebTransportBidirectionalStream } from '../stream/bidirectional-stream.js';
import type { WebTransportReceiveStream } from '../stream/receive-stream.js';
import type { WebTransportSendStream } from '../stream/send-stream.js';
import type { WebTransportSessionState } from './session-state.js';

export interface SessionCloseOptions {
  readonly closeCode?: number;
  readonly reason?: string;
}

export interface KeyingMaterialExportOptions {
  readonly label: string;
  readonly length: number;
  readonly context?: Uint8Array;
}

export interface WebTransportSession {
  readonly id: string;
  readonly path: string;
  readonly headers: Readonly<Headers>;
  readonly state: WebTransportSessionState;
  readonly signal: AbortSignal;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly datagrams: WebTransportDatagramChannel;
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
  readonly incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>;

  createBidirectionalStream(): Promise<WebTransportBidirectionalStream>;
  createUnidirectionalStream(): Promise<WebTransportSendStream>;
  close(options?: SessionCloseOptions): Promise<void>;
  exportKeyingMaterial?(options: KeyingMaterialExportOptions): Promise<Uint8Array>;
}
