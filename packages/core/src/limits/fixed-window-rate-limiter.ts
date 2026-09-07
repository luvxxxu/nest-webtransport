export class FixedWindowRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  #windowStartedAt: number | undefined;
  #used = 0;

  constructor(limit: number, windowMs: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('Rate limit must be a positive safe integer');
    }

    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('Rate limit window must be a positive finite number');
    }

    this.limit = limit;
    this.windowMs = windowMs;
  }

  get used(): number {
    return this.#used;
  }

  tryConsume(amount = 1, now = Date.now()): boolean {
    this.#assertAmount(amount);
    this.#refreshWindow(now);

    if (amount > this.limit - this.#used) {
      return false;
    }

    this.#used += amount;
    return true;
  }

  retryAfterMs(now = Date.now()): number {
    this.#refreshWindow(now);

    if (this.#used < this.limit || this.#windowStartedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.#windowStartedAt + this.windowMs - now);
  }

  reset(): void {
    this.#windowStartedAt = undefined;
    this.#used = 0;
  }

  #refreshWindow(now: number): void {
    if (!Number.isFinite(now)) {
      throw new RangeError('Current time must be a finite number');
    }

    if (
      this.#windowStartedAt === undefined ||
      now < this.#windowStartedAt ||
      now - this.#windowStartedAt >= this.windowMs
    ) {
      this.#windowStartedAt = now;
      this.#used = 0;
    }
  }

  #assertAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new RangeError('Consumed amount must be a positive safe integer');
    }
  }
}
