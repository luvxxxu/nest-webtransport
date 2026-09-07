import { WEBTRANSPORT_GATEWAY_METADATA } from '../metadata/constants.js';
import type { WebTransportGatewayOptions } from '../metadata/types.js';

export function WebTransportGateway(
  pathOrOptions: string | WebTransportGatewayOptions,
): ClassDecorator {
  const options = normalizeGatewayOptions(pathOrOptions);

  return (target) => {
    Reflect.defineMetadata(WEBTRANSPORT_GATEWAY_METADATA, options, target);
  };
}

function normalizeGatewayOptions(
  pathOrOptions: string | WebTransportGatewayOptions,
): WebTransportGatewayOptions {
  const path = typeof pathOrOptions === 'string' ? pathOrOptions : pathOrOptions.path;

  if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/')) {
    throw new TypeError('A WebTransport gateway path must be a non-empty absolute path.');
  }

  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return Object.freeze({ path: normalized });
}
