import { describe, expect, it } from 'vitest';

import { BoundedQueue } from './bounded-queue.js';

describe('BoundedQueue', () => {
  it('never grows past its capacity', () => {
    const queue = new BoundedQueue<number>({
      capacity: 2,
      overflow: 'drop-oldest',
    });

    expect(queue.enqueue(1)).toEqual({ accepted: true, outcome: 'enqueued' });
    expect(queue.enqueue(2)).toEqual({ accepted: true, outcome: 'enqueued' });
    expect(queue.enqueue(3)).toEqual({
      accepted: true,
      outcome: 'dropped-oldest',
      dropped: 1,
    });
    expect(queue.size).toBe(2);
    expect(queue.toArray()).toEqual([2, 3]);
  });

  it.each([
    ['drop-newest', 'dropped-newest'],
    ['reject', 'rejected'],
    ['close-session', 'close-session'],
  ] as const)('reports the %s overflow decision without enqueueing', (overflow, outcome) => {
    const queue = new BoundedQueue<number>({ capacity: 1, overflow });
    queue.enqueue(1);

    expect(queue.enqueue(2)).toMatchObject({ accepted: false, outcome });
    expect(queue.toArray()).toEqual([1]);
  });

  it('supports undefined values without confusing them with an empty slot', () => {
    const queue = new BoundedQueue<undefined>({
      capacity: 1,
      overflow: 'drop-oldest',
    });

    queue.enqueue(undefined);
    expect(queue.enqueue(undefined)).toEqual({
      accepted: true,
      outcome: 'dropped-oldest',
      dropped: undefined,
    });
    expect(queue.size).toBe(1);
  });

  it('preserves FIFO order while the fixed-size storage wraps around', () => {
    const queue = new BoundedQueue<number>({ capacity: 3, overflow: 'reject' });
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    expect(queue.dequeue()).toBe(1);
    queue.enqueue(4);

    expect([...queue]).toEqual([2, 3, 4]);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(3);
    expect(queue.dequeue()).toBe(4);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('rejects invalid capacities', () => {
    expect(() => new BoundedQueue({ capacity: 0, overflow: 'reject' })).toThrow(RangeError);
  });
});
