import { describe, expect, it } from 'vitest';

import { FixedWindowRateLimiter } from './fixed-window-rate-limiter.js';

describe('FixedWindowRateLimiter', () => {
  it('rejects excess work without queueing it', () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);

    expect(limiter.tryConsume(1, 100)).toBe(true);
    expect(limiter.tryConsume(1, 101)).toBe(true);
    expect(limiter.tryConsume(1, 102)).toBe(false);
    expect(limiter.used).toBe(2);
    expect(limiter.retryAfterMs(600)).toBe(500);
  });

  it('starts a fresh bounded counter in the next window', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000);

    expect(limiter.tryConsume(1, 100)).toBe(true);
    expect(limiter.tryConsume(1, 1_100)).toBe(true);
    expect(limiter.used).toBe(1);
  });
});
