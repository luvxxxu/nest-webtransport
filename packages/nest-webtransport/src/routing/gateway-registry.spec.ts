import { describe, expect, it } from 'vitest';

import { GatewayRegistry, normalizeGatewayPath } from './gateway-registry.js';

class Gateway {}

const sharedHandler = {
  gatewayPath: '/chat',
  instance: new Gateway(),
  metatype: Gateway,
  methodName: 'handle',
  callback: () => undefined,
  parameters: [],
  parameterTypes: [],
} as const;

describe('GatewayRegistry', () => {
  it('normalizes query strings and trailing slashes for exact path routing', () => {
    expect(normalizeGatewayPath('/chat/?token=redacted')).toBe('/chat');
    expect(normalizeGatewayPath('chat')).toBe('/chat');
  });

  it('combines an exact named route with the unnamed fallback', () => {
    const registry = new GatewayRegistry();
    registry.register({ ...sharedHandler, kind: 'datagram', route: undefined });
    registry.register({ ...sharedHandler, kind: 'datagram', route: 'typing' });

    expect(registry.find('/chat?x=1', 'datagram', 'typing')).toHaveLength(2);
    expect(registry.find('/chat', 'datagram', 'position')).toHaveLength(1);
    expect(registry.hasPath('/chat/')).toBe(true);
    expect(registry.hasHandlers('/chat', 'datagram')).toBe(true);
    expect(registry.hasHandlers('/chat', 'bidirectional-stream')).toBe(false);
  });

  it('clears both handlers and the path index', () => {
    const registry = new GatewayRegistry();
    registry.register({ ...sharedHandler, kind: 'session', route: undefined });
    registry.clear();

    expect(registry.size).toBe(0);
    expect(registry.hasPath('/chat')).toBe(false);
    expect(registry.hasHandlers('/chat', 'session')).toBe(false);
  });

  it('runs the unnamed fallback only once when a resolver returns an empty route', () => {
    const registry = new GatewayRegistry();
    const fallback = { ...sharedHandler, kind: 'datagram', route: undefined } as const;
    registry.register(fallback);
    registry.register({ ...sharedHandler, kind: 'datagram', route: 'typing' });

    expect(registry.find('/chat', 'datagram', '')).toEqual([fallback]);
  });
});
