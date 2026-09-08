import { describe, expect, it, vi } from 'vitest';

import { BoundedBytePipe } from './bounded-stream.js';

describe('BoundedBytePipe termination', () => {
  it('copies Buffer chunks without retaining their backing allocation', async () => {
    const pipe = new BoundedBytePipe({ capacity: 1, maxChunkSize: 16 });
    const writer = pipe.writable.getWriter();
    const reader = pipe.readable.getReader();
    const backing = Buffer.alloc(4_096);
    const chunk = backing.subarray(10, 12);
    chunk.set([1, 2]);
    await writer.write(chunk);
    chunk[0] = 9;
    const { value } = await reader.read();
    expect(value).toEqual(new Uint8Array([1, 2]));
    expect(value?.buffer.byteLength).toBe(2);
    await writer.close();
    writer.releaseLock();
    reader.releaseLock();
  });

  it('aborts an in-flight backpressured write without waiting for reader demand', async () => {
    const onTerminal = vi.fn();
    const pipe = new BoundedBytePipe({ capacity: 1, maxChunkSize: 16, onTerminal });
    const writer = pipe.writable.getWriter();
    const reader = pipe.readable.getReader();
    await writer.write(new Uint8Array([1]));
    const pending = writer.write(new Uint8Array([2]));
    const error = new Error('Abort blocked write');
    const rejection = expect(pending).rejects.toBe(error);
    const abort = writer.abort(error);
    await Promise.all([rejection, abort]);
    await expect(reader.read()).rejects.toBe(error);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    writer.releaseLock();
    reader.releaseLock();
  });

  it('terminates the peer reader and releases lifecycle state when a write is invalid', async () => {
    const onTerminal = vi.fn();
    const pipe = new BoundedBytePipe({ capacity: 1, maxChunkSize: 1, onTerminal });
    const writer = pipe.writable.getWriter();
    const reader = pipe.readable.getReader();
    const pendingRead = reader.read();
    const readRejection = expect(pendingRead).rejects.toThrow(/exceeds/);
    await expect(writer.write(new Uint8Array([1, 2]))).rejects.toThrow(/exceeds/);
    await readRejection;
    expect(onTerminal).toHaveBeenCalledTimes(1);
    writer.releaseLock();
    reader.releaseLock();
  });
});
