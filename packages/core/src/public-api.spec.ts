import { describe, expect, it } from 'vitest';

import {
  rawWebTransportCodec,
  WebTransportErrorScope,
  type WebTransportErrorScope as WebTransportErrorScopeValue,
  WebTransportServerState,
  type WebTransportServerState as WebTransportServerStateValue,
  WebTransportSessionState,
  type WebTransportSessionState as WebTransportSessionStateValue,
} from './index.js';

describe('core public API', () => {
  it('exports state constants and their same-named value unions', () => {
    const serverState: WebTransportServerStateValue = WebTransportServerState.RUNNING;
    const sessionState: WebTransportSessionStateValue = WebTransportSessionState.CONNECTED;
    const errorScope: WebTransportErrorScopeValue = WebTransportErrorScope.STREAM;

    expect([serverState, sessionState, errorScope]).toEqual(['RUNNING', 'CONNECTED', 'STREAM']);
  });

  it('keeps raw Uint8Array payloads first-class and allocation-free', () => {
    const value = new Uint8Array([1, 2, 3]);

    expect(rawWebTransportCodec.encode(value)).toBe(value);
    expect(rawWebTransportCodec.decode(value)).toBe(value);
  });
});
