import { Injectable } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  WEBTRANSPORT_GATEWAY_METADATA,
  WEBTRANSPORT_HANDLER_METADATA,
  WEBTRANSPORT_PARAMETER_METADATA,
} from '../metadata/constants.js';
import type {
  WebTransportGatewayOptions,
  WebTransportHandlerMetadata,
  WebTransportParameterMetadata,
} from '../metadata/types.js';
import { WebTransportGateway } from './gateway.decorator.js';
import {
  OnBidirectionalStream,
  OnDatagram,
  OnSession,
  OnUnidirectionalStream,
} from './handler.decorator.js';
import { Payload, Session, Stream, WebTransportContext } from './parameter.decorator.js';

describe('WebTransport decorators', () => {
  it('records normalized gateway metadata without creating runtime state', () => {
    @WebTransportGateway('/chat/')
    @Injectable()
    class ChatGateway {}

    expect(
      Reflect.getMetadata(WEBTRANSPORT_GATEWAY_METADATA, ChatGateway) as WebTransportGatewayOptions,
    ).toEqual({ path: '/chat' });
  });

  it('records all four handler kinds and optional route names', () => {
    class Gateway {
      @OnSession()
      connect(): void {}

      @OnDatagram('typing')
      datagram(): void {}

      @OnBidirectionalStream('upload')
      bidirectional(): void {}

      @OnUnidirectionalStream()
      unidirectional(): void {}
    }

    const prototype = Gateway.prototype;
    expect(metadataFor(prototype.connect)).toEqual({ kind: 'session', route: undefined });
    expect(metadataFor(prototype.datagram)).toEqual({ kind: 'datagram', route: 'typing' });
    expect(metadataFor(prototype.bidirectional)).toEqual({
      kind: 'bidirectional-stream',
      route: 'upload',
    });
    expect(metadataFor(prototype.unidirectional)).toEqual({
      kind: 'unidirectional-stream',
      route: undefined,
    });
  });

  it('records parameter extraction and per-parameter pipes in index order', () => {
    const pipe = { transform: (value: unknown) => value };

    class Gateway {
      event(
        @Payload(pipe) _payload: unknown,
        @Session() _session: unknown,
        @Stream() _stream: unknown,
        @WebTransportContext() _context: unknown,
      ): void {}
    }

    const metadata = Reflect.getOwnMetadata(
      WEBTRANSPORT_PARAMETER_METADATA,
      Gateway.prototype,
      'event',
    ) as readonly WebTransportParameterMetadata[];

    expect(metadata.map(({ index, kind }) => ({ index, kind }))).toEqual([
      { index: 0, kind: 'payload' },
      { index: 1, kind: 'session' },
      { index: 2, kind: 'stream' },
      { index: 3, kind: 'context' },
    ]);
    expect(metadata[0]?.pipes).toEqual([pipe]);
  });

  it('rejects invalid gateway and route declarations early', () => {
    expect(() => WebTransportGateway('relative')).toThrow(/absolute path/);
    expect(() => OnDatagram('')).toThrow(/empty string/);
  });
});

function metadataFor(method: object): WebTransportHandlerMetadata | undefined {
  return Reflect.getMetadata(WEBTRANSPORT_HANDLER_METADATA, method) as
    | WebTransportHandlerMetadata
    | undefined;
}
