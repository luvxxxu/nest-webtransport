import { describe, expect, it } from 'vitest';

import { WebTransportResourceLimitError } from '../errors/resource-limit.error.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';

describe('ConcurrencyLimiter', () => {
  it('does not create a waiter queue when full', () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.acquire();

    expect(limiter.active).toBe(1);
    expect(limiter.available).toBe(0);
    expect(limiter.tryAcquire()).toBeUndefined();
    expect(() => limiter.acquire()).toThrow(WebTransportResourceLimitError);

    release();
    release();
    expect(limiter.active).toBe(0);
  });

  it('rejects invalid limits', () => {
    expect(() => new ConcurrencyLimiter(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
