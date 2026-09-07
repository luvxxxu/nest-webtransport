import { describe, expect, it } from 'vitest';

import { WebTransportError } from '../errors/base.error.js';
import { WebTransportLifecycle } from './lifecycle.js';
import { WebTransportServerState } from './server-state.js';

describe('WebTransportLifecycle', () => {
  it('tracks readiness independently from liveness while draining', () => {
    const lifecycle = new WebTransportLifecycle();

    lifecycle.transition(WebTransportServerState.STARTING);
    lifecycle.transition(WebTransportServerState.RUNNING);
    expect(lifecycle.snapshot).toMatchObject({
      alive: true,
      ready: true,
      acceptingSessions: true,
    });

    lifecycle.transition(WebTransportServerState.DRAINING);
    expect(lifecycle.snapshot).toMatchObject({
      alive: true,
      ready: false,
      acceptingSessions: false,
    });
  });

  it('rejects invalid transitions as fatal invariant errors', () => {
    const lifecycle = new WebTransportLifecycle();

    expect(() => lifecycle.transition(WebTransportServerState.RUNNING)).toThrow(WebTransportError);
  });
});
