import { describe, expect, it } from 'vitest';

import { BoundedTaskScheduler } from './bounded-task-scheduler.js';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('BoundedTaskScheduler', () => {
  it('never exceeds the active and pending hard limits', async () => {
    const scheduler = new BoundedTaskScheduler({
      maxConcurrent: 1,
      maxPending: 1,
      overflow: 'drop',
    });
    const first = deferred();
    const second = deferred();

    expect(
      scheduler.submit(
        () => first.promise,
        () => undefined,
      ),
    ).toBe('started');
    expect(
      scheduler.submit(
        () => second.promise,
        () => undefined,
      ),
    ).toBe('queued');
    expect(
      scheduler.submit(
        () => undefined,
        () => undefined,
      ),
    ).toBe('dropped');
    expect(scheduler.active).toBe(1);
    expect(scheduler.pendingCount).toBe(1);

    first.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(scheduler.active).toBe(1);
    expect(scheduler.pendingCount).toBe(0);

    second.resolve();
    await scheduler.onIdle();
    expect(scheduler.isIdle).toBe(true);
  });

  it('reports reject and close-session overflow policies', () => {
    const never = new Promise<void>(() => undefined);
    const reject = new BoundedTaskScheduler({
      maxConcurrent: 1,
      maxPending: 0,
      overflow: 'reject',
    });
    const close = new BoundedTaskScheduler({
      maxConcurrent: 1,
      maxPending: 0,
      overflow: 'close-session',
    });

    reject.submit(
      () => never,
      () => undefined,
    );
    close.submit(
      () => never,
      () => undefined,
    );
    expect(
      reject.submit(
        () => undefined,
        () => undefined,
      ),
    ).toBe('rejected');
    expect(
      close.submit(
        () => undefined,
        () => undefined,
      ),
    ).toBe('close-session');
    reject.close({ discardPending: true });
    close.close({ discardPending: true });
  });

  it('allows a capacity waiter that lost the slot to register again', async () => {
    const scheduler = new BoundedTaskScheduler({
      maxConcurrent: 1,
      maxPending: 0,
      overflow: 'drop',
    });
    const first = deferred();
    const competing = deferred();

    expect(
      scheduler.submit(
        () => first.promise,
        () => undefined,
      ),
    ).toBe('started');
    const firstWake = scheduler.whenCapacityAvailable();
    first.resolve();
    await firstWake;

    expect(
      scheduler.submit(
        () => competing.promise,
        () => undefined,
      ),
    ).toBe('started');
    expect(scheduler.hasCapacity).toBe(false);

    let wokeAgain = false;
    const secondWake = scheduler.whenCapacityAvailable().then(() => {
      wokeAgain = true;
    });
    await Promise.resolve();
    expect(wokeAgain).toBe(false);

    competing.resolve();
    await secondWake;
    expect(scheduler.hasCapacity).toBe(true);
  });

  it('wakes capacity waiters on close and exposes that intake is closed', async () => {
    const scheduler = new BoundedTaskScheduler({
      maxConcurrent: 1,
      maxPending: 0,
      overflow: 'drop',
    });
    const active = deferred();
    scheduler.submit(
      () => active.promise,
      () => undefined,
    );

    const capacity = scheduler.whenCapacityAvailable();
    scheduler.close();
    await capacity;

    expect(scheduler.isAccepting).toBe(false);
    expect(scheduler.hasCapacity).toBe(false);
    expect(
      scheduler.submit(
        () => undefined,
        () => undefined,
      ),
    ).toBe('closed');

    active.resolve();
    await scheduler.onIdle();
  });

  it('does not strand waiters given an already-aborted signal', async () => {
    const scheduler = new BoundedTaskScheduler({
      maxConcurrent: 1,
      maxPending: 0,
      overflow: 'drop',
    });
    const active = deferred();
    scheduler.submit(
      () => active.promise,
      () => undefined,
    );
    const controller = new AbortController();
    controller.abort();

    await scheduler.whenCapacityAvailable(controller.signal);
    await scheduler.onIdle(controller.signal);

    active.resolve();
    await scheduler.onIdle();
  });
});
