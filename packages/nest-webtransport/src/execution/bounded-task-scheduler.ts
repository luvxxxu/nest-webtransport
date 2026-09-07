import type { HandlerOverflowPolicy } from 'webtransport-core';

export type ScheduledTask = () => void | Promise<void>;

export type TaskSubmissionResult =
  | 'started'
  | 'queued'
  | 'dropped'
  | 'rejected'
  | 'close-session'
  | 'closed';

interface PendingTask {
  readonly task: ScheduledTask;
  readonly onError: (error: unknown) => void | Promise<void>;
}

export class BoundedTaskScheduler {
  readonly maxConcurrent: number;
  readonly maxPending: number;
  readonly overflow: HandlerOverflowPolicy;

  private readonly pending: PendingTask[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private readonly capacityWaiters = new Set<() => void>();
  private activeCount = 0;
  private accepting = true;

  constructor(options: {
    readonly maxConcurrent: number;
    readonly maxPending: number;
    readonly overflow: HandlerOverflowPolicy;
  }) {
    this.maxConcurrent = options.maxConcurrent;
    this.maxPending = options.maxPending;
    this.overflow = options.overflow;
  }

  get active(): number {
    return this.activeCount;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get isAccepting(): boolean {
    return this.accepting;
  }

  get hasCapacity(): boolean {
    return this.accepting && this.activeCount + this.pending.length < this.capacity;
  }

  get isIdle(): boolean {
    return this.activeCount === 0 && this.pending.length === 0;
  }

  submit(
    task: ScheduledTask,
    onError: (error: unknown) => void | Promise<void>,
  ): TaskSubmissionResult {
    if (!this.accepting) {
      return 'closed';
    }

    if (this.activeCount < this.maxConcurrent) {
      this.start({ task, onError });
      return 'started';
    }

    if (this.pending.length < this.maxPending) {
      this.pending.push({ task, onError });
      return 'queued';
    }

    switch (this.overflow) {
      case 'drop':
        return 'dropped';
      case 'reject':
        return 'rejected';
      case 'close-session':
        return 'close-session';
    }
  }

  close(options: { readonly discardPending?: boolean } = {}): void {
    this.accepting = false;
    if (options.discardPending === true) {
      this.pending.length = 0;
    }
    this.flushWaiters();
  }

  async whenCapacityAvailable(signal?: AbortSignal): Promise<void> {
    if (this.hasCapacity || !this.accepting || signal?.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        signal?.removeEventListener('abort', finish);
        this.capacityWaiters.delete(finish);
        resolve();
      };
      this.capacityWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (this.hasCapacity || !this.accepting || signal?.aborted) {
        finish();
      }
    });
  }

  async onIdle(signal?: AbortSignal): Promise<void> {
    if (this.isIdle || signal?.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        signal?.removeEventListener('abort', finish);
        this.idleWaiters.delete(finish);
        resolve();
      };
      this.idleWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (this.isIdle || signal?.aborted) {
        finish();
      }
    });
  }

  private get capacity(): number {
    return this.maxConcurrent + this.maxPending;
  }

  private start(pendingTask: PendingTask): void {
    this.activeCount += 1;
    void Promise.resolve()
      .then(pendingTask.task)
      .catch(async (error) => {
        try {
          await pendingTask.onError(error);
        } catch {
          // An error observer must not strand scheduler capacity.
        }
      })
      .finally(() => {
        this.activeCount -= 1;
        const next = this.pending.shift();
        if (next !== undefined) {
          this.start(next);
        }
        this.flushWaiters();
      });
  }

  private flushWaiters(): void {
    if (this.hasCapacity || !this.accepting) {
      for (const resolve of this.capacityWaiters) {
        resolve();
      }
      this.capacityWaiters.clear();
    }

    if (this.isIdle) {
      for (const resolve of this.idleWaiters) {
        resolve();
      }
      this.idleWaiters.clear();
    }
  }
}
