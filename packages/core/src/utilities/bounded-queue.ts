export type BoundedQueueOverflowPolicy = 'drop-oldest' | 'drop-newest' | 'reject' | 'close-session';

export interface BoundedQueueOptions {
  readonly capacity: number;
  readonly overflow: BoundedQueueOverflowPolicy;
}

export type BoundedQueueEnqueueResult<Value> =
  | {
      readonly accepted: true;
      readonly outcome: 'enqueued';
    }
  | {
      readonly accepted: true;
      readonly outcome: 'dropped-oldest';
      readonly dropped: Value;
    }
  | {
      readonly accepted: false;
      readonly outcome: 'dropped-newest';
      readonly dropped: Value;
    }
  | {
      readonly accepted: false;
      readonly outcome: 'rejected';
      readonly item: Value;
    }
  | {
      readonly accepted: false;
      readonly outcome: 'close-session';
      readonly item: Value;
    };

export class BoundedQueue<Value> implements Iterable<Value> {
  readonly capacity: number;
  readonly overflow: BoundedQueueOverflowPolicy;
  readonly #items: (Value | undefined)[] = [];
  #head = 0;
  #size = 0;

  constructor(options: BoundedQueueOptions) {
    if (
      !Number.isSafeInteger(options.capacity) ||
      options.capacity < 1 ||
      options.capacity > 0xffff_ffff
    ) {
      throw new RangeError('Queue capacity must be an integer between 1 and 4,294,967,295');
    }

    this.capacity = options.capacity;
    this.overflow = options.overflow;
  }

  get size(): number {
    return this.#size;
  }

  get isEmpty(): boolean {
    return this.#size === 0;
  }

  get isFull(): boolean {
    return this.#size === this.capacity;
  }

  enqueue(item: Value): BoundedQueueEnqueueResult<Value> {
    if (!this.isFull) {
      this.#items[(this.#head + this.#size) % this.capacity] = item;
      this.#size += 1;
      return { accepted: true, outcome: 'enqueued' };
    }

    switch (this.overflow) {
      case 'drop-oldest': {
        const dropped = this.#items[this.#head] as Value;
        this.#items[this.#head] = item;
        this.#head = (this.#head + 1) % this.capacity;
        return {
          accepted: true,
          outcome: 'dropped-oldest',
          dropped,
        };
      }
      case 'drop-newest':
        return { accepted: false, outcome: 'dropped-newest', dropped: item };
      case 'reject':
        return { accepted: false, outcome: 'rejected', item };
      case 'close-session':
        return { accepted: false, outcome: 'close-session', item };
    }
  }

  dequeue(): Value | undefined {
    if (this.isEmpty) {
      return undefined;
    }

    const item = this.#items[this.#head] as Value;
    this.#items[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.capacity;
    this.#size -= 1;

    if (this.#size === 0) {
      this.#head = 0;
    }

    return item;
  }

  peek(): Value | undefined {
    return this.isEmpty ? undefined : (this.#items[this.#head] as Value);
  }

  clear(): void {
    this.#items.length = 0;
    this.#head = 0;
    this.#size = 0;
  }

  toArray(): readonly Value[] {
    const values: Value[] = [];

    for (let offset = 0; offset < this.#size; offset += 1) {
      values.push(this.#items[(this.#head + offset) % this.capacity] as Value);
    }

    return values;
  }

  [Symbol.iterator](): Iterator<Value> {
    return this.toArray()[Symbol.iterator]();
  }
}
