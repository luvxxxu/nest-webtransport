import type { PipeTransform, Type } from '@nestjs/common';

export type WebTransportHandlerKind =
  | 'session'
  | 'datagram'
  | 'bidirectional-stream'
  | 'unidirectional-stream';

export interface WebTransportGatewayOptions {
  readonly path: string;
}

export interface WebTransportHandlerMetadata {
  readonly kind: WebTransportHandlerKind;
  readonly route: string | undefined;
}

export type WebTransportParameterKind = 'session' | 'stream' | 'payload' | 'context';

export type WebTransportPipe = PipeTransform | Type<PipeTransform>;

export interface WebTransportParameterMetadata {
  readonly index: number;
  readonly kind: WebTransportParameterKind;
  readonly pipes: readonly WebTransportPipe[];
}
