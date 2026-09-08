import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebTransportSession } from 'webtransport-core';
import {
  createMockUnidirectionalStreamPair,
  createMockWebTransportSessionPair,
} from '../../../packages/testing/src/index.js';

import { DemoGateway } from './demo.gateway.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DemoGateway bounds', () => {
  it.each(['x', '\0'])(
    'acknowledges large uni payloads with a bounded preview (%j)',
    async (character) => {
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      const gateway = new DemoGateway();
      const session = createMockWebTransportSessionPair({ path: '/demo' });
      const stream = createMockUnidirectionalStreamPair({ id: 1n });
      const consumer = gateway.consumeUnidirectional(session.server, stream.receiver);
      const writer = stream.sender.writable.getWriter();
      await writer.write(new TextEncoder().encode(character.repeat(4_096)));
      await writer.close();
      writer.releaseLock();
      await consumer;
      const reader = session.client.datagrams.readable.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      expect(value?.byteLength).toBeLessThanOrEqual(1_200);
      const packet = JSON.parse(new TextDecoder().decode(value));
      expect(packet).toMatchObject({
        event: 'unidirectional-received',
        bytes: 4_096,
        truncated: true,
      });
      if (packet.message !== undefined)
        expect(new TextEncoder().encode(packet.message).byteLength).toBeLessThanOrEqual(256);
      await session.close();
    },
  );

  it('bounds recipient write chains and closes a writer that never makes progress', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.fn(() => hold);
    const writable = new WritableStream<Uint8Array>({ write });
    const controller = new AbortController();
    const close = vi.fn(async () => controller.abort(new Error('closed')));
    const session = {
      id: 'slow',
      signal: controller.signal,
      datagrams: { writable, maxDatagramSize: 1_200 },
      close,
    } as unknown as WebTransportSession;
    const gateway = new DemoGateway();
    const packet = new TextEncoder().encode(
      JSON.stringify({ type: 'echo', id: '1', message: 'test', sentAt: 1 }),
    );
    let overflows = 0;
    const pending = Promise.allSettled(
      Array.from({ length: 30 }, () =>
        gateway.handleDatagram(session, packet).catch((error: Error) => {
          if (error.message.includes('queue is full')) overflows++;
          throw error;
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(overflows).toBe(14);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await pending).every((result) => result.status === 'rejected')).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(writable.locked).toBe(false);
  });
});
