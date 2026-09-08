import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

import type { ProductionConfig } from './config.js';
import { PRODUCTION_CONFIG } from './tokens.js';

const PRESENCE_TTL_SECONDS = 120;
const COMMAND_TIMEOUT_MS = 1_000;
const CONNECT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 1_000;

@Injectable()
export class RedisPresenceService implements OnModuleInit, OnApplicationShutdown {
  private readonly client: RedisClientType;
  private ready = false;
  private failed = false;
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(@Inject(PRODUCTION_CONFIG) config: ProductionConfig) {
    this.client = createClient({
      url: config.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 256,
      socket: {
        connectTimeout: 1_000,
        reconnectStrategy: (retries) => {
          if (this.stopping || retries >= 5) {
            this.failed = !this.stopping;
            return false;
          }
          return Math.min(100 * 2 ** retries, 1_000) + Math.floor(Math.random() * 100);
        },
      },
    });
    this.client.on('ready', () => {
      this.ready = true;
    });
    for (const event of ['end', 'error', 'reconnecting']) {
      this.client.on(event, () => {
        this.ready = false;
      });
    }
  }

  get isReady(): boolean {
    return !this.stopping && !this.failed && this.ready && this.client.isReady;
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.withDeadline(this.client.connect(), CONNECT_TIMEOUT_MS);
    } catch {
      this.fail();
      // Avoid including a credential-bearing Redis URL in bootstrap errors.
      throw new Error('Redis presence could not connect within its startup budget.');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (!this.client.isOpen) return;
    try {
      await this.withDeadline(Promise.allSettled([...this.inFlight]), SHUTDOWN_TIMEOUT_MS);
    } catch {
      // The deadline already destroyed the socket and rejected queued commands.
    } finally {
      // node-redis close() clears isOpen before waiting for replies; destroy() can
      // no longer force-close it then. Drain our bounded work before destroying.
      if (this.client.isOpen) this.client.destroy();
    }
  }

  async markConnected(sessionId: string, userId: string, signal?: AbortSignal): Promise<void> {
    await this.command(
      ['SET', this.key(sessionId), userId, 'EX', String(PRESENCE_TTL_SECONDS)],
      signal,
    );
  }

  async refresh(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.command(['EXPIRE', this.key(sessionId), String(PRESENCE_TTL_SECONDS)], signal);
  }

  async markDisconnected(sessionId: string): Promise<void> {
    await this.command(['DEL', this.key(sessionId)]);
  }

  private async command(args: string[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.isReady) throw new Error('Redis presence is unavailable.');
    const command = this.withDeadline(
      this.client.sendCommand(args, signal === undefined ? undefined : { abortSignal: signal }),
      COMMAND_TIMEOUT_MS,
    );
    this.inFlight.add(command);
    void command.finally(() => this.inFlight.delete(command)).catch(() => {});
    if (signal === undefined) {
      await command;
      return;
    }
    // node-redis can only remove a command before it is written. Keep the deadline
    // alive for a sent command even when the session stops waiting for its reply.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('Session closed.'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      await Promise.race([command, aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  private async withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.fail();
        reject(new Error('Redis presence operation timed out.'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(): void {
    this.ready = false;
    this.failed = !this.stopping;
    if (this.client.isOpen) this.client.destroy();
  }

  private key(sessionId: string): string {
    return `webtransport:presence:${sessionId}`;
  }
}
