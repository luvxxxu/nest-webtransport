import { WebTransportResourceLimitError } from '../errors/resource-limit.error.js';

export type ReleasePermit = () => void;

export class ConcurrencyLimiter {
  readonly limit: number;
  #active = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('Concurrency limit must be a positive safe integer');
    }

    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get available(): number {
    return this.limit - this.#active;
  }

  tryAcquire(): ReleasePermit | undefined {
    if (this.#active >= this.limit) {
      return undefined;
    }

    this.#active += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.#active -= 1;
    };
  }

  acquire(): ReleasePermit {
    const release = this.tryAcquire();

    if (release === undefined) {
      throw new WebTransportResourceLimitError('Handler concurrency limit exceeded', {
        code: 'ERR_WEBTRANSPORT_CONCURRENCY_LIMIT',
        scope: 'HANDLER',
      });
    }

    return release;
  }
}
