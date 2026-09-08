import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('redis', () => ({ createClient }));

import type { ProductionConfig } from './config.js';
import { RedisPresenceService } from './redis-presence.service.js';

class FakeRedis extends EventEmitter {
  isOpen = false;
  isReady = false;
  connect = vi.fn(async () => {
    this.isOpen = true;
    this.isReady = true;
    this.emit('ready');
  });
  close = vi.fn(async () => {
    this.isOpen = false;
  });
  destroy = vi.fn(() => {
    this.isOpen = false;
    this.isReady = false;
  });
  sendCommand = vi.fn(
    async (_args: readonly string[], _options?: { abortSignal?: AbortSignal }) => 'OK',
  );
}

let client: FakeRedis;
let service: RedisPresenceService;
beforeEach(() => {
  client = new FakeRedis();
  createClient.mockReturnValue(client);
  service = new RedisPresenceService({ redisUrl: 'redis://localhost' } as ProductionConfig);
});
afterEach(() => vi.useRealTimers());

describe('bounded Redis presence', () => {
  it('fails fast during reconnect and bounds retries and the command queue', async () => {
    const options = createClient.mock.lastCall?.[0];
    expect(options).toMatchObject({ disableOfflineQueue: true, commandsQueueMaxLength: 256 });
    await service.onModuleInit();
    await service.markConnected('s1', 'user');
    expect(client.sendCommand).toHaveBeenCalledWith(
      ['SET', 'webtransport:presence:s1', 'user', 'EX', '120'],
      undefined,
    );
    client.emit('reconnecting');
    await expect(service.refresh('s1')).rejects.toThrow(/unavailable/);
    client.emit('ready');
    await expect(service.refresh('s1')).resolves.toBeUndefined();
    expect(options.socket.reconnectStrategy(5)).toBe(false);
    expect(service.hasFailed).toBe(true);
  });

  it('bounds a stalled command and marks liveness failed without retaining the connection', async () => {
    vi.useFakeTimers();
    await service.onModuleInit();
    client.sendCommand.mockImplementation(() => new Promise(() => {}));
    const pending = expect(service.refresh('s1')).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(service.hasFailed).toBe(true);
    expect(service.isReady).toBe(false);
  });

  it('releases an aborted caller promptly while bounding a sent command that ignores abort', async () => {
    vi.useFakeTimers();
    await service.onModuleInit();
    client.sendCommand.mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = expect(service.markConnected('s1', 'user', abort.signal)).rejects.toThrow(
      'gone',
    );
    abort.abort(new Error('gone'));
    await pending;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it('bounds startup even when the Redis client never resolves', async () => {
    vi.useFakeTimers();
    client.isOpen = true;
    client.connect.mockImplementation(() => new Promise(() => {}));
    const startup = expect(service.onModuleInit()).rejects.toThrow(/startup budget/);
    await vi.advanceTimersByTimeAsync(5_000);
    await startup;
    expect(client.destroy).toHaveBeenCalledOnce();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds shutdown while replies are stalled and destroys the still-open client', async () => {
    vi.useFakeTimers();
    await service.onModuleInit();
    client.sendCommand.mockImplementation(() => new Promise(() => {}));
    const pending = expect(service.refresh('s1')).rejects.toThrow(/timed out/);
    const shutdown = service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([shutdown, pending]);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains completed writes before destroying the connection on shutdown', async () => {
    await service.onModuleInit();
    let finish!: (value: string) => void;
    client.sendCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.markDisconnected('s1');
    const shutdown = service.onApplicationShutdown();
    expect(client.destroy).not.toHaveBeenCalled();
    finish('OK');
    await Promise.all([shutdown, pending]);
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
