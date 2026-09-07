import { WEBTRANSPORT_HANDLER_METADATA } from '../metadata/constants.js';
import type { WebTransportHandlerKind, WebTransportHandlerMetadata } from '../metadata/types.js';

export function OnSession(): MethodDecorator {
  return createHandlerDecorator('session');
}

export function OnDatagram(route?: string): MethodDecorator {
  return createHandlerDecorator('datagram', route);
}

export function OnBidirectionalStream(route?: string): MethodDecorator {
  return createHandlerDecorator('bidirectional-stream', route);
}

export function OnUnidirectionalStream(route?: string): MethodDecorator {
  return createHandlerDecorator('unidirectional-stream', route);
}

function createHandlerDecorator(kind: WebTransportHandlerKind, route?: string): MethodDecorator {
  if (route !== undefined && route.length === 0) {
    throw new TypeError('A WebTransport handler route cannot be an empty string.');
  }

  const metadata: WebTransportHandlerMetadata = Object.freeze({
    kind,
    route,
  });

  return (_target, _propertyKey, descriptor) => {
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      throw new TypeError('WebTransport event decorators can only be used on methods.');
    }

    Reflect.defineMetadata(WEBTRANSPORT_HANDLER_METADATA, metadata, descriptor.value);
  };
}
