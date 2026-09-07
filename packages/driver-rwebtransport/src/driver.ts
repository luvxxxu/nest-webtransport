import type { WebTransportServerSession as NativeSession } from 'rwebtransport';
import {
  type WebTransportServerState as CoreServerState,
  type DriverStopOptions,
  type Unsubscribe,
  type WebTransportDriver,
  type WebTransportDriverCapabilities,
  type WebTransportDriverStats,
  type WebTransportServerOptions,
  WebTransportServerState,
  type WebTransportSessionCallback,
} from 'webtransport-core';

import { mapRWebTransportError } from './error.mapper.js';
import type { RWebTransportAdapterMetrics } from './metrics.js';
import {
  RWebTransportServerAdapter,
  type RWebTransportServerAdapterOptions,
  type RWebTransportServerFactory,
} from './server.adapter.js';
import { RWebTransportSessionAdapter } from './session.adapter.js';

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export const RWEBTRANSPORT_DRIVER_CAPABILITIES: WebTransportDriverCapabilities = Object.freeze({
  datagrams: true,
  bidirectionalStreams: true,
  unidirectionalStreams: true,
  gracefulShutdown: true,
  connectionStats: true,
  keyingMaterialExport: true,
});

export interface RWebTransportDriverOptions {
  readonly allowedOrigins?: readonly string[];
  readonly reusePort?: boolean;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly defaultDrainTimeoutMs?: number;
  /** Bounds established native sessions, including sessions being rejected/closed. */
  readonly maxSessions?: number;
  /** Bounds outstanding session callbacks, even after their peer disconnects. */
  readonly maxPendingSessionCallbacks?: number;
}

interface RWebTransportDriverInternalOptions extends RWebTransportDriverOptions {
  readonly serverFactory?: RWebTransportServerFactory;
  readonly sessionIdFactory?: () => string;
  readonly now?: () => number;
}

export class RWebTransportDriver implements WebTransportDriver {
  readonly capabilities = RWEBTRANSPORT_DRIVER_CAPABILITIES;

  private readonly callbacks = new Set<WebTransportSessionCallback>();
  private readonly sessions = new Map<string, RWebTransportSessionAdapter>();
  private readonly connectionStats = new Map<
    string,
    Awaited<ReturnType<RWebTransportSessionAdapter['captureConnectionStats']>>
  >();
  private readonly dispatchTasks = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly sessionIdFactory: (() => string) | undefined;
  private readonly serverFactory: RWebTransportServerFactory | undefined;
  private readonly serverOptions: RWebTransportServerAdapterOptions;
  private readonly defaultDrainTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly maxPendingSessionCallbacks: number;
  private readonly metrics: RWebTransportAdapterMetrics;

  private server: RWebTransportServerAdapter | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private removeStartAbortListener: () => void = () => {};
  private refreshingStats = false;
  private state: CoreServerState = WebTransportServerState.STOPPED;
  private sessionsTotal = 0;
  private sessionsRejected = 0;
  private streamsActive = 0;
  private streamsTotal = 0;
  private datagramsReceived = 0;
  private datagramsSent = 0;
  private datagramsDropped = 0;
  private bytesReceived = 0;
  private bytesSent = 0;

  constructor(options: RWebTransportDriverOptions = {}) {
    const internalOptions = options as RWebTransportDriverInternalOptions;
    this.now = internalOptions.now ?? Date.now;
    this.sessionIdFactory = internalOptions.sessionIdFactory;
    this.serverFactory = internalOptions.serverFactory;
    this.serverOptions = {
      ...(options.allowedOrigins === undefined
        ? {}
        : { allowedOrigins: [...options.allowedOrigins] }),
      ...(options.reusePort === undefined ? {} : { reusePort: options.reusePort }),
      ...(options.responseHeaders === undefined
        ? {}
        : { responseHeaders: { ...options.responseHeaders } }),
    };
    this.defaultDrainTimeoutMs = options.defaultDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? 50_000;
    this.maxPendingSessionCallbacks = options.maxPendingSessionCallbacks ?? 1_024;
    for (const [name, value] of Object.entries({
      maxSessions: this.maxSessions,
      maxPendingSessionCallbacks: this.maxPendingSessionCallbacks,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    if (
      !Number.isFinite(this.defaultDrainTimeoutMs) ||
      this.defaultDrainTimeoutMs < 0 ||
      this.defaultDrainTimeoutMs > 2_147_483_647
    ) {
      throw new RangeError('defaultDrainTimeoutMs must be a finite non-negative number');
    }

    this.metrics = {
      streamOpened: () => {
        this.streamsActive += 1;
        this.streamsTotal += 1;
      },
      streamClosed: () => {
        this.streamsActive = Math.max(0, this.streamsActive - 1);
      },
      bytesReceived: (bytes) => {
        this.bytesReceived += bytes;
      },
      bytesSent: (bytes) => {
        this.bytesSent += bytes;
      },
      datagramReceived: (bytes) => {
        this.datagramsReceived += 1;
        this.bytesReceived += bytes;
      },
      datagramSent: (bytes) => {
        this.datagramsSent += 1;
        this.bytesSent += bytes;
      },
      datagramDropped: (count = 1) => {
        this.datagramsDropped += count;
      },
    };
  }

  start(options: WebTransportServerOptions): Promise<void> {
    if (this.state === WebTransportServerState.RUNNING) {
      return Promise.resolve();
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    const operation =
      this.stopPromise === undefined
        ? this.performStart(options)
        : this.stopPromise.then(() => this.performStart(options));
    this.startPromise = operation.finally(() => {
      this.startPromise = undefined;
    });
    void this.startPromise.catch(() => {});
    return this.startPromise;
  }

  stop(options: DriverStopOptions = {}): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    if (this.state === WebTransportServerState.STOPPED && this.startPromise === undefined) {
      return Promise.resolve();
    }

    this.stopPromise = this.performStop(options).finally(() => {
      this.stopPromise = undefined;
    });
    void this.stopPromise.catch(() => {});
    return this.stopPromise;
  }

  onSession(callback: WebTransportSessionCallback): Unsubscribe {
    this.callbacks.add(callback);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.callbacks.delete(callback);
    };
  }

  /** The bound UDP port, or zero while stopped. Supports servers configured with port 0. */
  get port(): number {
    return this.server?.port ?? 0;
  }

  getStats(): WebTransportDriverStats {
    void this.refreshConnectionStats();
    return {
      capturedAt: this.now(),
      state: this.state,
      sessions: {
        active: this.sessions.size,
        total: this.sessionsTotal,
        rejected: this.sessionsRejected,
      },
      streams: {
        active: this.streamsActive,
        total: this.streamsTotal,
      },
      datagrams: {
        received: this.datagramsReceived,
        sent: this.datagramsSent,
        dropped: this.datagramsDropped,
      },
      bytes: {
        received: this.bytesReceived,
        sent: this.bytesSent,
      },
      connections: [...this.connectionStats.values()],
    };
  }

  private async performStart(options: WebTransportServerOptions): Promise<void> {
    this.state = WebTransportServerState.STARTING;
    const server = new RWebTransportServerAdapter(this.serverOptions, this.serverFactory);
    this.server = server;
    if (options.signal !== undefined) {
      const handleAbort = (): void => {
        void this.stop({ graceful: true }).catch(() => {});
      };
      options.signal.addEventListener('abort', handleAbort, { once: true });
      this.removeStartAbortListener = () =>
        options.signal?.removeEventListener('abort', handleAbort);
    }

    try {
      await server.start(options, {
        session: (native) => this.acceptSession(native),
        error: (error) => this.handleServerError(error),
      });
      if (this.server === server && this.state === WebTransportServerState.STARTING) {
        this.state = WebTransportServerState.RUNNING;
      }
    } catch (error) {
      this.removeStartAbortListener();
      this.removeStartAbortListener = () => {};
      this.state = WebTransportServerState.STOPPED;
      if (this.server === server) {
        this.server = undefined;
      }
      throw mapRWebTransportError(error, {
        target: 'driver',
        operation: 'start rwebtransport driver',
      });
    }
  }

  private async performStop(options: DriverStopOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.defaultDrainTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      throw new RangeError('stop timeoutMs must be between 0 and 2147483647');
    }
    const deadline = Date.now() + timeoutMs;
    const server = this.server;
    if (server === undefined) {
      this.state = WebTransportServerState.STOPPED;
      return;
    }

    const starting = this.state === WebTransportServerState.STARTING;
    try {
      if (
        !starting &&
        this.state !== WebTransportServerState.STOPPING &&
        (options.graceful ?? true)
      ) {
        this.state = WebTransportServerState.DRAINING;
        for (const session of this.sessions.values()) {
          try {
            session.drain();
          } catch {
            // One broken session must not prevent the others from draining.
          }
        }
        await this.waitForDrainWork(options);
      }

      this.state = WebTransportServerState.STOPPING;
      // Initiate native shutdown even if the deadline/signal has already expired.
      // Bound the actual server/session close promises, not just graceful drain.
      const closing = Promise.all([
        server.stop(),
        ...[...this.sessions.values()].map((session) =>
          session.close({ closeCode: 0, reason: 'server shutdown' }),
        ),
        ...(starting && this.startPromise !== undefined ? [this.startPromise.catch(() => {})] : []),
      ]);
      await waitForStop(closing, Math.max(0, deadline - Date.now()), options.signal);
      this.server = undefined;
      this.state = WebTransportServerState.STOPPED;
    } catch (error) {
      this.state = WebTransportServerState.STOPPING;
      throw mapRWebTransportError(error, {
        target: 'driver',
        operation: 'stop rwebtransport driver',
      });
    } finally {
      this.removeStartAbortListener();
      this.removeStartAbortListener = () => {};
    }
  }

  private acceptSession(native: NativeSession): void {
    this.sessionsTotal += 1;
    if (
      this.sessions.size >= this.maxSessions ||
      this.dispatchTasks.size >= this.maxPendingSessionCallbacks
    ) {
      this.sessionsRejected += 1;
      try {
        native.close({ closeCode: 1, reason: 'driver session capacity exceeded' });
      } catch {
        // A peer may already have closed. Do not allocate another dispatch task.
      }
      return;
    }
    const id = this.sessionIdFactory?.();
    const session = new RWebTransportSessionAdapter(
      native,
      this.metrics,
      {
        closed: (closedSession) => this.sessionClosed(closedSession),
      },
      id,
    );
    this.sessions.set(session.id, session);
    void this.captureSessionStats(session);

    if (
      this.state === WebTransportServerState.DRAINING ||
      this.state === WebTransportServerState.STOPPING ||
      this.state === WebTransportServerState.STOPPED ||
      this.callbacks.size === 0
    ) {
      this.sessionsRejected += 1;
      void session
        .close({ closeCode: 1, reason: 'server is not accepting sessions' })
        .catch(() => {});
      return;
    }

    const task = this.dispatchSession(session);
    this.dispatchTasks.add(task);
    void task.finally(() => this.dispatchTasks.delete(task)).catch(() => {});
  }

  private async dispatchSession(session: RWebTransportSessionAdapter): Promise<void> {
    for (const callback of [...this.callbacks]) {
      try {
        await callback(session);
      } catch {
        this.sessionsRejected += 1;
        await session.close({ closeCode: 1, reason: 'session callback failed' }).catch(() => {});
        return;
      }
    }
  }

  private sessionClosed(session: RWebTransportSessionAdapter): void {
    if (!this.sessions.delete(session.id)) {
      return;
    }
    this.connectionStats.delete(session.id);
    void session.captureConnectionStats().catch(() => {});
  }

  private handleServerError(_error: unknown): void {
    if (
      this.state === WebTransportServerState.RUNNING ||
      this.state === WebTransportServerState.STARTING
    ) {
      void this.stop({ graceful: false }).catch(() => {});
    }
  }

  private async waitForDrainWork(options: DriverStopOptions): Promise<void> {
    const sessions = [...this.sessions.values()];
    const dispatchTasks = [...this.dispatchTasks];
    if (sessions.length === 0 && dispatchTasks.length === 0) {
      return;
    }

    const timeoutMs = options.timeoutMs ?? this.defaultDrainTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('stop timeoutMs must be a finite non-negative number');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = (): void => {};
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const aborted = new Promise<void>((resolve) => {
      if (options.signal === undefined) {
        return;
      }
      if (options.signal.aborted) {
        resolve();
        return;
      }
      const handleAbort = (): void => resolve();
      options.signal.addEventListener('abort', handleAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener('abort', handleAbort);
    });

    try {
      await Promise.race([
        Promise.all([
          ...sessions.map((session) => session.closed),
          ...dispatchTasks.map((task) => task.catch(() => {})),
        ]).then(() => {}),
        timeout,
        aborted,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      removeAbortListener();
    }
  }

  private async refreshConnectionStats(): Promise<void> {
    if (this.refreshingStats) {
      return;
    }
    this.refreshingStats = true;
    try {
      await Promise.all(
        [...this.sessions.values()].map((session) => this.captureSessionStats(session)),
      );
    } finally {
      this.refreshingStats = false;
    }
  }

  private async captureSessionStats(session: RWebTransportSessionAdapter): Promise<void> {
    try {
      const stats = await session.captureConnectionStats();
      if (this.sessions.has(session.id)) {
        this.connectionStats.set(session.id, stats);
      }
    } catch {
      // Stats are best-effort and must not affect session processing.
    }
  }
}

async function waitForStop(
  promise: Promise<unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DOMException('Native shutdown timed out', 'TimeoutError')),
      timeoutMs,
    );
    if (signal !== undefined) {
      const abort = () =>
        reject(signal.reason ?? new DOMException('Shutdown aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
  });
  try {
    await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort();
  }
}
