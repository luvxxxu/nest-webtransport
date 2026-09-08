import type { SessionContext, WebTransportSession } from 'nest-webtransport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealtimeGateway } from './realtime.gateway.js';
import type { RedisPresenceService } from './redis-presence.service.js';

function fixture() {
  const abort = new AbortController();
  const presence = {
    markConnected: vi.fn().mockResolvedValue(undefined),
    markDisconnected: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  const session = {
    id: 'session-1',
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebTransportSession;
  const context: SessionContext = {
    sessionId: session.id,
    signal: abort.signal,
    createdAt: Date.now(),
    metadata: new Map(),
    principal: { userId: 'user-1', roles: [], expiresAt: Date.now() + 10_000 },
  };
  const gateway = new RealtimeGateway(presence as unknown as RedisPresenceService);
  return { abort, presence, session, context, gateway };
}

afterEach(() => vi.useRealTimers());

describe('production session lifetime', () => {
  it('cleans up SET after a session aborts while SET is pending', async () => {
    const f = fixture();
    let finish!: () => void;
    f.presence.markConnected.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const connected = f.gateway.connected(f.session, f.context);
    f.abort.abort();
    finish();
    await connected;
    expect(f.presence.markDisconnected).toHaveBeenCalledExactlyOnceWith(f.session.id);
  });

  it('cleans up a SET whose reply failed and closes a live session when its JWT expires', async () => {
    vi.useFakeTimers();
    const failed = fixture();
    failed.presence.markConnected.mockRejectedValue(new Error('Reply lost'));
    await expect(failed.gateway.connected(failed.session, failed.context)).rejects.toThrow(
      'Reply lost',
    );
    expect(failed.presence.markDisconnected).toHaveBeenCalledOnce();

    const f = fixture();
    await f.gateway.connected(f.session, f.context);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.session.close).toHaveBeenCalledWith({
      closeCode: 0x100,
      reason: 'Authentication expired',
    });
    f.abort.abort();
    expect(f.presence.markDisconnected).toHaveBeenCalledOnce();
  });

  it('cancels expiration timers when a session disconnects', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.gateway.connected(f.session, f.context);
    f.abort.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.session.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
