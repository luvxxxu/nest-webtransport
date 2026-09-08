/** Reservations include local queues, global waiters, admission, and running user work. */
export class HandlerBudget {
  private reserved = 0;
  private running = 0;
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly concurrency: number,
    readonly pending: number,
  ) {}

  get active(): number {
    return this.running;
  }
  get outstanding(): number {
    return this.reserved;
  }

  reserve(): (() => void) | undefined {
    if (this.reserved >= this.concurrency + this.pending) return undefined;
    this.reserved++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved--;
    };
  }

  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      this.running--;
      this.wake();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.running < this.concurrency && this.waiters.size === 0) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(grant);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
        this.wake();
      };
      const grant = () => {
        this.waiters.delete(grant);
        signal.removeEventListener('abort', abort);
        this.running++;
        resolve();
      };
      this.waiters.add(grant);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private wake(): void {
    for (const grant of this.waiters) {
      if (this.running >= this.concurrency) break;
      grant();
    }
  }
}
