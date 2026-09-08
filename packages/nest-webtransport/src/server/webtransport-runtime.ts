import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type ContextId, ContextIdFactory, ModuleRef } from '@nestjs/core';
import {
  BoundedQueue,
  type SessionContext,
  SessionRejectedError,
  type WebTransportBidirectionalStream,
  type WebTransportDriver,
  WebTransportError,
  WebTransportLifecycle,
  type WebTransportLifecycleSnapshot,
  type WebTransportReceiveStream,
  WebTransportServerState,
  type WebTransportSession,
  WebTransportTimeoutError,
} from 'webtransport-core';

import type { WebTransportHandlerArguments } from '../context/webtransport-arguments-host.js';
import {
  BoundedTaskScheduler,
  type TaskSubmissionResult,
} from '../execution/bounded-task-scheduler.js';
import { WebTransportExecutionPipeline } from '../execution/execution-pipeline.js';
import type {
  WebTransportLogRecord,
  WebTransportRouteResolution,
} from '../interfaces/module-options.interface.js';
import {
  type NormalizedWebTransportModuleOptions,
  normalizeWebTransportOrigin,
} from '../module/options.js';
import { WEBTRANSPORT_MODULE_OPTIONS } from '../module/tokens.js';
import { GatewayRegistry } from '../routing/gateway-registry.js';
import { HandlerBudget } from './handler-budget.js';
import type { WebTransportRuntimeStats } from './runtime-stats.js';

const CLOSE_CODE = Object.freeze({
  REJECTED: 0x100,
  RESOURCE_LIMIT: 0x101,
  NO_ROUTE: 0x102,
  TIMEOUT: 0x103,
  INTERNAL_ERROR: 0x104,
});

interface ManagedSession {
  readonly session: WebTransportSession;
  readonly context: SessionContext;
  readonly scheduler: BoundedTaskScheduler;
  readonly datagrams: BoundedQueue<Uint8Array>;
  readonly ipAddress: string;
  readonly pumps: Set<Promise<void>>;
  readonly contextId: ContextId;
  readonly intakeController: AbortController;
  readonly admissionController: AbortController;
  readonly streamIdleWaiters: Set<() => void>;
  datagramReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  bidirectionalReader: ReadableStreamDefaultReader<WebTransportBidirectionalStream> | undefined;
  unidirectionalReader: ReadableStreamDefaultReader<WebTransportReceiveStream> | undefined;
  removeSessionAbortListener: () => void;
  bidirectionalStreams: number;
  unidirectionalStreams: number;
  datagramWindowStartedAt: number;
  datagramsInWindow: number;
  drainingDatagrams: boolean;
  queuedDatagramBytes: number;
  lastActivityAt: number;
  finalized: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  admission: Promise<void> | undefined;
  retirement: Promise<void> | undefined;
}

interface IpRecord {
  active: number;
  attempts: number[];
}

@Injectable()
export class WebTransportRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly lifecycle = new WebTransportLifecycle();
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly outstandingSessions = new Set<ManagedSession>();
  private readonly ipRecords = new Map<string, IpRecord>();
  private readonly handlerBudget: HandlerBudget;
  private queuedDatagramBytes = 0;
  private activeStreams = 0;
  private acceptedSessions = 0;
  private rejectedSessions = 0;
  private rejectedHandlers = 0;
  private droppedDatagrams = 0;
  private suppressedLogs = 0;
  private logWindowAt = 0;
  private logsInWindow = 0;
  private pendingLogCallbacks = 0;
  private readonly rejections: Record<string, number> = Object.create(null);
  private readonly drops: Record<string, number> = Object.create(null);
  private unsubscribeFromDriver: (() => void) | undefined;
  private removeServerAbortListener: () => void = () => {};
  private startupController: AbortController | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(
    @Inject(WEBTRANSPORT_MODULE_OPTIONS)
    private readonly options: NormalizedWebTransportModuleOptions,
    @Inject(GatewayRegistry)
    private readonly registry: GatewayRegistry,
    @Inject(WebTransportExecutionPipeline)
    private readonly pipeline: WebTransportExecutionPipeline,
    @Inject(ModuleRef)
    private readonly moduleRef: ModuleRef,
  ) {
    this.handlerBudget = new HandlerBudget(
      options.limits.server.maxConcurrentHandlers,
      options.limits.server.maxPendingHandlers,
    );
  }

  getStats(): WebTransportRuntimeStats {
    return Object.freeze({
      sessions: Object.freeze({
        accepted: this.acceptedSessions,
        rejected: this.rejectedSessions,
        rejections: Object.freeze({ ...this.rejections }),
      }),
      datagrams: Object.freeze({
        dropped: this.droppedDatagrams,
        drops: Object.freeze({ ...this.drops }),
        queuedBytes: this.queuedDatagramBytes,
      }),
      handlers: Object.freeze({
        active: this.handlerBudget.active,
        outstanding: this.handlerBudget.outstanding,
        rejected: this.rejectedHandlers,
      }),
      logs: Object.freeze({ suppressed: this.suppressedLogs }),
    });
  }

  get snapshot(): WebTransportLifecycleSnapshot {
    return this.lifecycle.snapshot;
  }

  get driver(): WebTransportDriver {
    return this.options.driver;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  onApplicationBootstrap(): Promise<void> {
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }
    if (this.lifecycle.state === WebTransportServerState.RUNNING) {
      return Promise.resolve();
    }
    if (this.lifecycle.state !== WebTransportServerState.STOPPED) {
      return this.stopPromise ?? Promise.resolve();
    }

    this.validateRegistryConfiguration();
    this.lifecycle.transition(WebTransportServerState.STARTING);
    const startupController = new AbortController();
    this.startupController = startupController;
    const unsubscribe = this.options.driver.onSession(async (session) => {
      try {
        await this.acceptSession(session);
      } catch (error) {
        this.logError('session.accept.failed', error, session.id);
        await this.closeSession(session, CLOSE_CODE.INTERNAL_ERROR, 'Session setup failed');
      }
    });
    this.unsubscribeFromDriver = unsubscribe;

    const serverSignal = this.options.server.signal;
    let removeServerAbortListener: () => void = () => {};
    if (serverSignal !== undefined) {
      const stopForAbort = () => {
        void this.stop().catch((error) => this.logError('server.signal-stop.failed', error));
      };
      serverSignal.addEventListener('abort', stopForAbort, { once: true });
      removeServerAbortListener = () => serverSignal.removeEventListener('abort', stopForAbort);
      this.removeServerAbortListener = removeServerAbortListener;
      if (serverSignal.aborted) {
        queueMicrotask(stopForAbort);
      }
    }
    const signal =
      serverSignal === undefined
        ? startupController.signal
        : AbortSignal.any([serverSignal, startupController.signal]);
    const operation = this.performStart(
      unsubscribe,
      startupController,
      signal,
      removeServerAbortListener,
    );
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (this.startPromise === tracked) {
        this.startPromise = undefined;
      }
      if (this.startupController === startupController) {
        this.startupController = undefined;
      }
    });
    this.startPromise = tracked;
    return tracked;
  }

  private async performStart(
    unsubscribe: () => void,
    startupController: AbortController,
    signal: AbortSignal,
    removeServerAbortListener: () => void,
  ): Promise<void> {
    try {
      await this.options.driver.start({ ...this.options.server, signal });
      if (
        this.startupController === startupController &&
        this.currentLifecycleState() === WebTransportServerState.STARTING
      ) {
        this.lifecycle.transition(WebTransportServerState.RUNNING);
        this.log({ level: 'info', event: 'server.started' });
      }
    } catch (error) {
      unsubscribe();
      if (this.unsubscribeFromDriver === unsubscribe) {
        this.unsubscribeFromDriver = undefined;
      }
      removeServerAbortListener();
      if (this.removeServerAbortListener === removeServerAbortListener) {
        this.removeServerAbortListener = () => {};
      }
      if (
        this.startupController === startupController &&
        this.currentLifecycleState() === WebTransportServerState.STARTING
      ) {
        this.lifecycle.transition(WebTransportServerState.STOPPING);
        this.lifecycle.transition(WebTransportServerState.STOPPED);
      }
      throw error;
    }
  }

  private validateRegistryConfiguration(): void {
    for (const handler of this.registry.list()) {
      if (handler.kind === 'datagram') {
        if (!this.options.driver.capabilities.datagrams) {
          throw new TypeError('The configured driver does not support datagram handlers.');
        }
        if (handler.route !== undefined && this.options.routing.datagram === undefined) {
          throw new TypeError(
            `Named datagram handler "${handler.route}" requires routing.datagram.`,
          );
        }
      }
      if (handler.kind === 'bidirectional-stream') {
        if (!this.options.driver.capabilities.bidirectionalStreams) {
          throw new TypeError(
            'The configured driver does not support bidirectional stream handlers.',
          );
        }
        if (handler.route !== undefined && this.options.routing.bidirectionalStream === undefined) {
          throw new TypeError(
            `Named bidirectional stream handler "${handler.route}" requires routing.bidirectionalStream.`,
          );
        }
      }
      if (handler.kind === 'unidirectional-stream') {
        if (!this.options.driver.capabilities.unidirectionalStreams) {
          throw new TypeError(
            'The configured driver does not support unidirectional stream handlers.',
          );
        }
        if (
          handler.route !== undefined &&
          this.options.routing.unidirectionalStream === undefined
        ) {
          throw new TypeError(
            `Named unidirectional stream handler "${handler.route}" requires routing.unidirectionalStream.`,
          );
        }
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    this.stopPromise = this.performStop().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.lifecycle.state === WebTransportServerState.STOPPED) {
      return;
    }

    const stoppingDuringStart = this.lifecycle.state === WebTransportServerState.STARTING;
    if (this.lifecycle.state === WebTransportServerState.RUNNING) {
      this.lifecycle.transition(WebTransportServerState.DRAINING);
    } else if (stoppingDuringStart) {
      this.lifecycle.transition(WebTransportServerState.STOPPING);
    }

    this.removeServerAbortListener();
    this.removeServerAbortListener = () => {};
    this.startupController?.abort(new DOMException('Server startup cancelled', 'AbortError'));
    this.unsubscribeFromDriver?.();
    this.unsubscribeFromDriver = undefined;

    for (const managed of this.outstandingSessions) {
      if (this.options.shutdown.graceful && this.driver.capabilities.gracefulShutdown) {
        try {
          managed.session.drain?.();
        } catch (error) {
          this.logError('session.drain.failed', error, managed.session.id);
        }
      }
      this.stopIntake(managed, 'Server is draining');
    }

    if (this.lifecycle.state === WebTransportServerState.DRAINING) {
      if (this.options.shutdown.graceful) {
        const drainingSessions = [...this.outstandingSessions];
        await withTimeout(
          Promise.all(
            drainingSessions.map(async (managed) => {
              await Promise.allSettled([
                managed.scheduler.onIdle(),
                managed.admission ?? Promise.resolve(),
                Promise.allSettled([...managed.pumps]),
                this.waitForStreams(managed),
              ]);
            }),
          ),
          this.options.shutdown.drainTimeoutMs,
          'Timed out while draining WebTransport handlers.',
        ).catch((error) => this.logError('server.drain.timeout', error));
      }
      this.lifecycle.transition(WebTransportServerState.STOPPING);
    }

    for (const managed of this.outstandingSessions) {
      managed.admissionController.abort('Server is stopping');
      managed.scheduler.close({ discardPending: true });
    }

    const forceCloseDeadline = Date.now() + this.options.shutdown.forceCloseTimeoutMs;
    if (stoppingDuringStart && this.startPromise !== undefined) {
      await withTimeout(
        this.startPromise.catch(() => undefined),
        remainingTime(forceCloseDeadline),
        'Timed out while cancelling WebTransport server startup.',
      ).catch((error) => this.logError('server.start-cancel.timeout', error));
    }

    const closeAll = Promise.allSettled(
      [...this.sessions.values()].map((managed) =>
        this.closeSession(managed.session, 0, 'Server shutting down'),
      ),
    ).then(() => undefined);
    await withTimeout(
      closeAll,
      remainingTime(forceCloseDeadline),
      'Timed out while closing WebTransport sessions.',
    ).catch((error) => this.logError('server.force-close.timeout', error));

    const driverStopController = new AbortController();
    let driverStopError: unknown;
    try {
      const driverStopTimeoutMs = remainingTime(forceCloseDeadline);
      await withTimeout(
        this.options.driver.stop({
          graceful:
            this.options.shutdown.graceful && this.options.driver.capabilities.gracefulShutdown,
          timeoutMs: driverStopTimeoutMs,
          signal: driverStopController.signal,
        }),
        driverStopTimeoutMs,
        'Timed out while stopping the WebTransport driver.',
        (error) => driverStopController.abort(error),
      );
    } catch (error) {
      driverStopError = error;
      this.logError('driver.stop.failed', error);
    } finally {
      for (const managed of [...this.sessions.values()]) {
        this.finalizeSession(managed);
      }
      if (
        driverStopError === undefined &&
        this.currentLifecycleState() === WebTransportServerState.STOPPING
      ) {
        this.lifecycle.transition(WebTransportServerState.STOPPED);
        this.log({ level: 'info', event: 'server.stopped' });
      }
    }
    if (driverStopError !== undefined) {
      throw driverStopError;
    }
  }

  private async acceptSession(session: WebTransportSession): Promise<void> {
    if (
      !this.lifecycle.snapshot.acceptingSessions ||
      this.driver.getStats().state !== WebTransportServerState.RUNNING
    ) {
      this.recordRejection('server-unavailable');
      await this.closeSession(session, CLOSE_CODE.REJECTED, 'Server is not accepting sessions');
      return;
    }

    if (!this.registry.hasPath(session.path)) {
      this.recordRejection('no-route');
      await this.closeSession(session, CLOSE_CODE.NO_ROUTE, 'No WebTransport gateway for path');
      return;
    }

    const rejection = this.validateSession(session);
    if (rejection !== undefined) {
      this.recordRejection(rejection.code);
      this.log({
        level: 'warn',
        event: 'session.rejected',
        sessionId: session.id,
        code: rejection.code,
      });
      await this.closeSession(session, CLOSE_CODE.REJECTED, rejection.message);
      return;
    }

    const ipAddress = session.remoteAddress ?? '<unknown>';
    if (!this.acquireIpSlot(ipAddress)) {
      this.recordRejection('ip-limit');
      await this.closeSession(session, CLOSE_CODE.RESOURCE_LIMIT, 'Per-IP session limit exceeded');
      return;
    }

    const releaseAdmissionBudget = this.handlerBudget.reserve();
    if (releaseAdmissionBudget === undefined) {
      this.releaseIpSlot(ipAddress);
      this.rejectedHandlers++;
      this.recordRejection('handler-limit');
      await this.closeSession(session, CLOSE_CODE.RESOURCE_LIMIT, 'Server work limit exceeded');
      return;
    }

    let reservedReaders: {
      datagram: ReadableStreamDefaultReader<Uint8Array> | undefined;
      bidirectional: ReadableStreamDefaultReader<WebTransportBidirectionalStream> | undefined;
      unidirectional: ReadableStreamDefaultReader<WebTransportReceiveStream> | undefined;
    };
    try {
      reservedReaders = this.reserveIncomingReaders(session);
    } catch (error) {
      releaseAdmissionBudget();
      this.releaseIpSlot(ipAddress);
      this.recordRejection('reader-setup');
      this.logError('session.reader-reservation.failed', error, session.id);
      await this.closeSession(session, CLOSE_CODE.INTERNAL_ERROR, 'Incoming reader setup failed');
      return;
    }

    const admissionController = new AbortController();
    const context: SessionContext = {
      sessionId: session.id,
      metadata: new Map(),
      createdAt: Date.now(),
      signal: AbortSignal.any([session.signal, admissionController.signal]),
      touch: () => this.touch(managed),
    };
    const contextId = ContextIdFactory.create();
    this.moduleRef.registerRequestByContextId(context, contextId);
    const managed: ManagedSession = {
      session,
      context,
      scheduler: new BoundedTaskScheduler({
        maxConcurrent: this.options.execution.maxConcurrentHandlers,
        maxPending: this.options.execution.maxPendingHandlers,
        overflow: this.options.execution.overflow,
      }),
      datagrams: new BoundedQueue({
        capacity: this.options.datagrams.queue.size,
        overflow: this.options.datagrams.queue.overflow,
      }),
      ipAddress,
      pumps: new Set(),
      contextId,
      intakeController: new AbortController(),
      admissionController,
      streamIdleWaiters: new Set(),
      datagramReader: reservedReaders.datagram,
      bidirectionalReader: reservedReaders.bidirectional,
      unidirectionalReader: reservedReaders.unidirectional,
      removeSessionAbortListener: () => undefined,
      bidirectionalStreams: 0,
      unidirectionalStreams: 0,
      datagramWindowStartedAt: Date.now(),
      datagramsInWindow: 0,
      drainingDatagrams: false,
      queuedDatagramBytes: 0,
      lastActivityAt: performance.now(),
      finalized: false,
      idleTimer: undefined,
      admission: undefined,
      retirement: undefined,
    };

    this.sessions.set(session.id, managed);
    this.outstandingSessions.add(managed);
    const finalize = () => this.finalizeSession(managed);
    managed.removeSessionAbortListener = () =>
      session.signal.removeEventListener('abort', finalize);
    if (session.signal.aborted) {
      releaseAdmissionBudget();
      this.finalizeSession(managed);
      return;
    }
    session.signal.addEventListener('abort', finalize, { once: true });
    this.touch(managed);

    // A timeout stops admission, not an arbitrary user Promise. Keep the real work
    // charged to the server/IP limits until it settles, including after disconnect.
    const work = this.handlerBudget
      .run(() => this.authenticateAndRunSessionHandlers(managed), managed.context.signal)
      .finally(releaseAdmissionBudget);
    managed.admission = work;
    const releaseAdmission = () => {
      if (managed.admission === work) managed.admission = undefined;
    };
    void work.then(releaseAdmission, releaseAdmission);
    const admission = withTimeout(
      withAbortSignal(work, managed.context.signal),
      this.options.security.handshakeTimeoutMs,
      'WebTransport session admission timed out.',
      (error) => admissionController.abort(error),
    );
    try {
      await admission;
    } catch (error) {
      this.recordRejection(
        error instanceof WebTransportTimeoutError ? 'admission-timeout' : 'admission-failed',
      );
      this.logError('session.rejected', error, session.id);
      await this.closeSession(session, CLOSE_CODE.REJECTED, 'Session rejected');
      return;
    }

    if (session.signal.aborted) {
      this.finalizeSession(managed);
      return;
    }
    if (
      managed.intakeController.signal.aborted ||
      this.lifecycle.state !== WebTransportServerState.RUNNING
    ) {
      return;
    }

    this.acceptedSessions++;
    this.log({ level: 'info', event: 'session.accepted', sessionId: session.id });
    if (managed.datagramReader !== undefined) {
      this.startPump(managed, this.pumpDatagrams(managed));
    }
    if (managed.bidirectionalReader !== undefined) {
      this.startPump(managed, this.pumpBidirectionalStreams(managed));
    }
    if (managed.unidirectionalReader !== undefined) {
      this.startPump(managed, this.pumpUnidirectionalStreams(managed));
    }
  }

  private reserveIncomingReaders(session: WebTransportSession): {
    readonly datagram: ReadableStreamDefaultReader<Uint8Array> | undefined;
    readonly bidirectional:
      | ReadableStreamDefaultReader<WebTransportBidirectionalStream>
      | undefined;
    readonly unidirectional: ReadableStreamDefaultReader<WebTransportReceiveStream> | undefined;
  } {
    let datagram: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bidirectional: ReadableStreamDefaultReader<WebTransportBidirectionalStream> | undefined;
    let unidirectional: ReadableStreamDefaultReader<WebTransportReceiveStream> | undefined;

    try {
      if (this.registry.hasHandlers(session.path, 'datagram')) {
        datagram = session.datagrams.readable.getReader();
      }
      if (this.registry.hasHandlers(session.path, 'bidirectional-stream')) {
        bidirectional = session.incomingBidirectionalStreams.getReader();
      }
      if (this.registry.hasHandlers(session.path, 'unidirectional-stream')) {
        unidirectional = session.incomingUnidirectionalStreams.getReader();
      }
      return { datagram, bidirectional, unidirectional };
    } catch (error) {
      void cancelAndReleaseReader(datagram, error);
      void cancelAndReleaseReader(bidirectional, error);
      void cancelAndReleaseReader(unidirectional, error);
      throw error;
    }
  }

  private validateSession(session: WebTransportSession): SessionRejectedError | undefined {
    if (this.outstandingSessions.size >= this.options.limits.server.maxSessions) {
      return new SessionRejectedError('Global session limit exceeded.', {
        code: 'ERR_WEBTRANSPORT_GLOBAL_SESSION_LIMIT',
      });
    }
    if (this.sessions.has(session.id)) {
      return new SessionRejectedError('Duplicate session id.', {
        code: 'ERR_WEBTRANSPORT_DUPLICATE_SESSION_ID',
      });
    }

    const headerSize = measureHeaders(session.headers);
    if (headerSize > this.options.security.maxHeaderSize) {
      return new SessionRejectedError('Session headers exceed the configured limit.', {
        code: 'ERR_WEBTRANSPORT_HEADER_LIMIT',
      });
    }

    const origin = session.headers.get('origin');
    if (this.options.security.requireOrigin && origin === null) {
      return new SessionRejectedError('An Origin header is required.', {
        code: 'ERR_WEBTRANSPORT_ORIGIN_REQUIRED',
      });
    }
    if (origin !== null) {
      let normalizedOrigin: string;
      try {
        normalizedOrigin = normalizeWebTransportOrigin(origin, 'Origin header');
      } catch (cause) {
        return new SessionRejectedError('Origin header is malformed.', {
          code: 'ERR_WEBTRANSPORT_ORIGIN_MALFORMED',
          cause,
        });
      }
      if (
        this.options.security.allowedOrigins.size > 0 &&
        !this.options.security.allowedOrigins.has(normalizedOrigin)
      ) {
        return new SessionRejectedError('Origin is not allowed.', {
          code: 'ERR_WEBTRANSPORT_ORIGIN_REJECTED',
        });
      }
    }

    return undefined;
  }

  private async authenticateAndRunSessionHandlers(managed: ManagedSession): Promise<void> {
    this.throwIfAdmissionEnded(managed);
    const authenticate = this.options.security.authenticate;
    if (authenticate !== undefined) {
      const principal = await authenticate(managed.session, managed.context);
      this.throwIfAdmissionEnded(managed);
      if (principal === false) {
        throw new SessionRejectedError('Session authentication failed.', {
          code: 'ERR_WEBTRANSPORT_AUTHENTICATION_REJECTED',
        });
      }
      if (principal !== undefined) {
        managed.context.principal = principal;
      }
    }

    const handlers = this.registry.find(managed.session.path, 'session');
    for (const handler of handlers) {
      this.throwIfAdmissionEnded(managed);
      const args: WebTransportHandlerArguments = [
        managed.session,
        undefined,
        undefined,
        managed.session,
        managed.context,
      ];
      await this.pipeline.invoke(handler, args, managed.contextId);
      this.throwIfAdmissionEnded(managed);
    }
  }

  private throwIfAdmissionEnded(managed: ManagedSession): void {
    if (!managed.context.signal.aborted && !managed.finalized) {
      return;
    }
    throw (
      managed.context.signal.reason ??
      new DOMException('WebTransport session admission was cancelled', 'AbortError')
    );
  }

  private async pumpDatagrams(managed: ManagedSession): Promise<void> {
    const reader = managed.datagramReader;
    if (reader === undefined) {
      return;
    }
    const cancel = () => {
      void reader.cancel(managed.session.signal.reason).catch(() => undefined);
    };
    managed.session.signal.addEventListener('abort', cancel, { once: true });
    managed.intakeController.signal.addEventListener('abort', cancel, { once: true });

    try {
      while (!managed.session.signal.aborted && !managed.intakeController.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }

        if (managed.intakeController.signal.aborted || managed.session.signal.aborted) return;
        this.touch(managed);
        if (value.byteLength > this.maximumDatagramSize(managed.session)) {
          this.recordDatagramDrop('size-limit', managed);
          continue;
        }
        if (!this.consumeDatagramRate(managed)) {
          this.recordDatagramDrop('rate-limit', managed);
          continue;
        }
        // Charge actual retained bytes, including datagrams waiting in the scheduler.
        const replacedBytes =
          managed.datagrams.isFull && managed.datagrams.overflow === 'drop-oldest'
            ? (managed.datagrams.peek()?.byteLength ?? 0)
            : 0;
        if (
          this.queuedDatagramBytes - replacedBytes + value.byteLength >
          this.options.limits.server.maxQueuedDatagramBytes
        ) {
          this.recordDatagramDrop('server-byte-limit', managed);
          continue;
        }
        // Copy once to prevent a tiny view retaining an arbitrarily large backing buffer.
        const result = managed.datagrams.enqueue(new Uint8Array(value));
        if (result.accepted) {
          this.queuedDatagramBytes += value.byteLength;
          managed.queuedDatagramBytes += value.byteLength;
        }
        if (result.outcome === 'dropped-oldest') {
          this.queuedDatagramBytes -= result.dropped.byteLength;
          managed.queuedDatagramBytes -= result.dropped.byteLength;
        }
        if (result.outcome !== 'enqueued') this.recordDatagramDrop(result.outcome, managed);
        if (result.outcome === 'close-session') {
          await this.closeSession(
            managed.session,
            CLOSE_CODE.RESOURCE_LIMIT,
            'Datagram queue limit exceeded',
          );
          return;
        }

        if (!managed.drainingDatagrams) this.startPump(managed, this.drainDatagrams(managed));
      }
    } catch (error) {
      if (!managed.session.signal.aborted && !managed.intakeController.signal.aborted) {
        await this.handleRuntimeError(error, managed);
      }
    } finally {
      managed.session.signal.removeEventListener('abort', cancel);
      managed.intakeController.signal.removeEventListener('abort', cancel);
      if (managed.datagramReader === reader) {
        managed.datagramReader = undefined;
      }
      releaseReaderLock(reader);
    }
  }

  private async drainDatagrams(managed: ManagedSession): Promise<void> {
    if (managed.drainingDatagrams) {
      return;
    }
    managed.drainingDatagrams = true;

    try {
      while (
        !managed.datagrams.isEmpty &&
        !managed.session.signal.aborted &&
        !managed.intakeController.signal.aborted
      ) {
        await managed.scheduler.whenCapacityAvailable(managed.session.signal);
        if (!managed.scheduler.hasCapacity) {
          if (
            !managed.scheduler.isAccepting ||
            managed.session.signal.aborted ||
            managed.intakeController.signal.aborted
          ) {
            return;
          }
          continue;
        }

        const datagram = managed.datagrams.dequeue();
        if (datagram === undefined) {
          return;
        }
        managed.queuedDatagramBytes -= datagram.byteLength;
        const outcome = this.submit(
          managed,
          () => this.dispatchDatagram(managed, datagram),
          async (error) => {
            await this.handleRuntimeError(error, managed);
          },
          () => {
            this.queuedDatagramBytes -= datagram.byteLength;
          },
        );
        if (outcome !== 'started' && outcome !== 'queued')
          this.recordDatagramDrop('handler-limit', managed);
        await this.handleSubmissionOutcome(outcome, managed);
      }
    } finally {
      managed.drainingDatagrams = false;
    }
  }

  private async dispatchDatagram(managed: ManagedSession, datagram: Uint8Array): Promise<void> {
    const resolution = this.options.routing.datagram
      ? await this.options.routing.datagram(datagram, managed.session, managed.context)
      : ({ value: datagram, payload: datagram } satisfies WebTransportRouteResolution<Uint8Array>);
    managed.context.signal.throwIfAborted();
    const value = resolution.value ?? datagram;
    const payload = hasOwn(resolution, 'payload') ? resolution.payload : value;
    const handlers = this.registry.find(managed.session.path, 'datagram', resolution.route);

    for (const handler of handlers) {
      managed.context.signal.throwIfAborted();
      const args: WebTransportHandlerArguments = [
        managed.session,
        undefined,
        value,
        payload,
        managed.context,
      ];
      try {
        await this.pipeline.invoke(handler, args, managed.contextId);
      } catch (error) {
        if ((await this.handleRuntimeError(error, managed)) === 'stop') {
          break;
        }
      }
    }
  }

  private async pumpBidirectionalStreams(managed: ManagedSession): Promise<void> {
    const reader = managed.bidirectionalReader;
    if (reader === undefined) {
      return;
    }
    const cancel = () => {
      void reader.cancel(managed.session.signal.reason).catch(() => undefined);
    };
    managed.session.signal.addEventListener('abort', cancel, { once: true });
    managed.intakeController.signal.addEventListener('abort', cancel, { once: true });

    try {
      while (!managed.session.signal.aborted && !managed.intakeController.signal.aborted) {
        await managed.scheduler.whenCapacityAvailable(managed.session.signal);
        if (!managed.scheduler.hasCapacity) {
          if (
            !managed.scheduler.isAccepting ||
            managed.session.signal.aborted ||
            managed.intakeController.signal.aborted
          ) {
            return;
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        if (managed.intakeController.signal.aborted || managed.session.signal.aborted) {
          await value.reset(CLOSE_CODE.REJECTED);
          return;
        }
        this.touch(managed);
        if (
          this.activeStreams >= this.options.limits.server.maxStreams ||
          managed.bidirectionalStreams >= this.options.limits.session.maxBidirectionalStreams
        ) {
          await value.reset(CLOSE_CODE.RESOURCE_LIMIT);
          continue;
        }

        this.trackStream(managed, value, 'bidirectional');
        const outcome = this.submit(
          managed,
          () => this.dispatchBidirectionalStream(managed, value),
          async (error) => {
            await this.handleRuntimeError(error, managed, value);
          },
        );
        await this.handleStreamSubmissionOutcome(outcome, managed, value);
      }
    } catch (error) {
      if (!managed.session.signal.aborted && !managed.intakeController.signal.aborted) {
        await this.handleRuntimeError(error, managed);
      }
    } finally {
      managed.session.signal.removeEventListener('abort', cancel);
      managed.intakeController.signal.removeEventListener('abort', cancel);
      if (managed.bidirectionalReader === reader) {
        managed.bidirectionalReader = undefined;
      }
      releaseReaderLock(reader);
    }
  }

  private async dispatchBidirectionalStream(
    managed: ManagedSession,
    stream: WebTransportBidirectionalStream,
  ): Promise<void> {
    const resolution = this.options.routing.bidirectionalStream
      ? await this.options.routing.bidirectionalStream(stream, managed.session, managed.context)
      : ({
          value: stream,
          payload: stream,
        } satisfies WebTransportRouteResolution<WebTransportBidirectionalStream>);
    managed.context.signal.throwIfAborted();
    const value = resolution.value ?? stream;
    const payload = hasOwn(resolution, 'payload') ? resolution.payload : value;
    const handlers = this.registry.find(
      managed.session.path,
      'bidirectional-stream',
      resolution.route,
    );

    if (handlers.length === 0) {
      await stream
        .reset(CLOSE_CODE.NO_ROUTE)
        .catch((error) =>
          this.logError('stream.no-route.reset.failed', error, managed.session.id, stream.id),
        );
      return;
    }

    for (const handler of handlers) {
      managed.context.signal.throwIfAborted();
      try {
        await this.pipeline.invoke(
          handler,
          [managed.session, value, undefined, payload, managed.context],
          managed.contextId,
        );
      } catch (error) {
        if ((await this.handleRuntimeError(error, managed, value)) === 'stop') {
          break;
        }
      }
    }
  }

  private async pumpUnidirectionalStreams(managed: ManagedSession): Promise<void> {
    const reader = managed.unidirectionalReader;
    if (reader === undefined) {
      return;
    }
    const cancel = () => {
      void reader.cancel(managed.session.signal.reason).catch(() => undefined);
    };
    managed.session.signal.addEventListener('abort', cancel, { once: true });
    managed.intakeController.signal.addEventListener('abort', cancel, { once: true });

    try {
      while (!managed.session.signal.aborted && !managed.intakeController.signal.aborted) {
        await managed.scheduler.whenCapacityAvailable(managed.session.signal);
        if (!managed.scheduler.hasCapacity) {
          if (
            !managed.scheduler.isAccepting ||
            managed.session.signal.aborted ||
            managed.intakeController.signal.aborted
          ) {
            return;
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        if (managed.intakeController.signal.aborted || managed.session.signal.aborted) {
          await value.stop(CLOSE_CODE.REJECTED);
          return;
        }
        this.touch(managed);
        if (
          this.activeStreams >= this.options.limits.server.maxStreams ||
          managed.unidirectionalStreams >= this.options.limits.session.maxUnidirectionalStreams
        ) {
          await value.stop(CLOSE_CODE.RESOURCE_LIMIT);
          continue;
        }

        this.trackStream(managed, value, 'unidirectional');
        const outcome = this.submit(
          managed,
          () => this.dispatchUnidirectionalStream(managed, value),
          async (error) => {
            await this.handleRuntimeError(error, managed, value);
          },
        );
        await this.handleStreamSubmissionOutcome(outcome, managed, value);
      }
    } catch (error) {
      if (!managed.session.signal.aborted && !managed.intakeController.signal.aborted) {
        await this.handleRuntimeError(error, managed);
      }
    } finally {
      managed.session.signal.removeEventListener('abort', cancel);
      managed.intakeController.signal.removeEventListener('abort', cancel);
      if (managed.unidirectionalReader === reader) {
        managed.unidirectionalReader = undefined;
      }
      releaseReaderLock(reader);
    }
  }

  private async dispatchUnidirectionalStream(
    managed: ManagedSession,
    stream: WebTransportReceiveStream,
  ): Promise<void> {
    const resolution = this.options.routing.unidirectionalStream
      ? await this.options.routing.unidirectionalStream(stream, managed.session, managed.context)
      : ({
          value: stream,
          payload: stream,
        } satisfies WebTransportRouteResolution<WebTransportReceiveStream>);
    managed.context.signal.throwIfAborted();
    const value = resolution.value ?? stream;
    const payload = hasOwn(resolution, 'payload') ? resolution.payload : value;
    const handlers = this.registry.find(
      managed.session.path,
      'unidirectional-stream',
      resolution.route,
    );

    if (handlers.length === 0) {
      await stream
        .stop(CLOSE_CODE.NO_ROUTE)
        .catch((error) =>
          this.logError('stream.no-route.stop.failed', error, managed.session.id, stream.id),
        );
      return;
    }

    for (const handler of handlers) {
      managed.context.signal.throwIfAborted();
      try {
        await this.pipeline.invoke(
          handler,
          [managed.session, value, undefined, payload, managed.context],
          managed.contextId,
        );
      } catch (error) {
        if ((await this.handleRuntimeError(error, managed, value)) === 'stop') {
          break;
        }
      }
    }
  }

  private trackStream(
    managed: ManagedSession,
    stream: WebTransportBidirectionalStream | WebTransportReceiveStream,
    kind: 'bidirectional' | 'unidirectional',
  ): void {
    this.activeStreams++;
    if (kind === 'bidirectional') {
      managed.bidirectionalStreams += 1;
    } else {
      managed.unidirectionalStreams += 1;
    }

    let released = false;
    const timer = setTimeout(() => {
      const operation =
        'reset' in stream ? stream.reset(CLOSE_CODE.TIMEOUT) : stream.stop(CLOSE_CODE.TIMEOUT);
      void operation.catch((error) =>
        this.logError('stream.timeout.close.failed', error, managed.session.id, stream.id),
      );
    }, this.options.limits.stream.maxLifetimeMs);

    const release = () => {
      if (released) {
        return;
      }
      released = true;
      clearTimeout(timer);
      this.activeStreams--;
      stream.signal.removeEventListener('abort', release);
      managed.session.signal.removeEventListener('abort', release);
      if (kind === 'bidirectional') {
        managed.bidirectionalStreams -= 1;
      } else {
        managed.unidirectionalStreams -= 1;
      }
      if (managed.bidirectionalStreams === 0 && managed.unidirectionalStreams === 0) {
        for (const resolve of managed.streamIdleWaiters) {
          resolve();
        }
        managed.streamIdleWaiters.clear();
        if (!managed.finalized && !managed.session.signal.aborted) {
          this.touch(managed);
        }
      }
    };
    if (stream.signal.aborted || managed.session.signal.aborted) {
      release();
    } else {
      stream.signal.addEventListener('abort', release, { once: true });
      managed.session.signal.addEventListener('abort', release, { once: true });
    }
  }

  private async handleStreamSubmissionOutcome(
    outcome: TaskSubmissionResult,
    managed: ManagedSession,
    stream: WebTransportBidirectionalStream | WebTransportReceiveStream,
  ): Promise<void> {
    if (outcome === 'started' || outcome === 'queued') {
      return;
    }
    if (outcome === 'close-session') {
      await this.closeSession(
        managed.session,
        CLOSE_CODE.RESOURCE_LIMIT,
        'Handler queue limit exceeded',
      );
      return;
    }

    const operation =
      'reset' in stream
        ? stream.reset(CLOSE_CODE.RESOURCE_LIMIT)
        : stream.stop(CLOSE_CODE.RESOURCE_LIMIT);
    await operation.catch((error) =>
      this.logError('stream.reject.failed', error, managed.session.id, stream.id),
    );
  }

  private async handleSubmissionOutcome(
    outcome: TaskSubmissionResult,
    managed: ManagedSession,
  ): Promise<void> {
    if (outcome === 'close-session') {
      await this.closeSession(
        managed.session,
        CLOSE_CODE.RESOURCE_LIMIT,
        'Handler queue limit exceeded',
      );
    }
  }

  private async handleRuntimeError(
    error: unknown,
    managed: ManagedSession,
    stream?: WebTransportBidirectionalStream | WebTransportReceiveStream,
  ): Promise<'continue' | 'stop'> {
    this.logError('handler.error', error, managed.session.id, stream?.id);

    if (!(error instanceof WebTransportError)) {
      return 'continue';
    }

    switch (error.scope) {
      case 'HANDLER':
        return 'continue';
      case 'STREAM':
        if (stream !== undefined) {
          const operation = 'reset' in stream ? stream.reset() : stream.stop();
          await operation.catch(() => undefined);
        }
        return 'stop';
      case 'SESSION':
        await this.closeSession(managed.session, CLOSE_CODE.INTERNAL_ERROR, error.code);
        return 'stop';
      case 'SERVER':
      case 'FATAL':
        void this.stop().catch((stopError) => this.logError('server.stop.failed', stopError));
        return 'stop';
    }
  }

  private consumeDatagramRate(managed: ManagedSession): boolean {
    const now = Date.now();
    if (now - managed.datagramWindowStartedAt >= 1_000) {
      managed.datagramWindowStartedAt = now;
      managed.datagramsInWindow = 0;
    }
    if (managed.datagramsInWindow >= this.options.limits.session.maxDatagramsPerSecond) {
      return false;
    }
    managed.datagramsInWindow += 1;
    return true;
  }

  private maximumDatagramSize(session: WebTransportSession): number {
    return Math.min(this.options.security.maxDatagramSize, session.datagrams.maxDatagramSize);
  }

  private acquireIpSlot(ipAddress: string): boolean {
    let record = this.ipRecords.get(ipAddress);
    if (record === undefined) {
      if (this.ipRecords.size >= this.options.limits.server.maxSessions) {
        this.sweepExpiredIpRecords();
        if (this.ipRecords.size >= this.options.limits.server.maxSessions) {
          return false;
        }
      }
      record = { active: 0, attempts: [] };
      this.ipRecords.set(ipAddress, record);
    }

    const threshold = Date.now() - 1_000;
    while ((record.attempts[0] ?? Number.POSITIVE_INFINITY) <= threshold) {
      record.attempts.shift();
    }
    if (
      record.active >= this.options.limits.ip.maxSessions ||
      record.attempts.length >= this.options.limits.ip.sessionsPerSecond
    ) {
      return false;
    }

    record.active += 1;
    record.attempts.push(Date.now());
    return true;
  }

  private sweepExpiredIpRecords(): void {
    const threshold = Date.now() - 1_000;
    for (const [ipAddress, record] of this.ipRecords) {
      if (record.active !== 0) {
        continue;
      }
      while ((record.attempts[0] ?? Number.POSITIVE_INFINITY) <= threshold) {
        record.attempts.shift();
      }
      if (record.attempts.length === 0) {
        this.ipRecords.delete(ipAddress);
      }
    }
  }

  private releaseIpSlot(ipAddress: string): void {
    const record = this.ipRecords.get(ipAddress);
    if (record === undefined) {
      return;
    }
    record.active = Math.max(0, record.active - 1);
    const threshold = Date.now() - 1_000;
    while ((record.attempts[0] ?? Number.POSITIVE_INFINITY) <= threshold) {
      record.attempts.shift();
    }
    if (record.active === 0 && record.attempts.length === 0) {
      this.ipRecords.delete(ipAddress);
    }
  }

  private touch(managed: ManagedSession): void {
    if (
      managed.finalized ||
      managed.session.signal.aborted ||
      this.options.security.idleTimeoutMs === 0
    )
      return;
    managed.lastActivityAt = performance.now();
    if (managed.idleTimer !== undefined) return;
    const checkIdle = () => {
      managed.idleTimer = undefined;
      if (managed.finalized || managed.intakeController.signal.aborted) return;
      if (managed.bidirectionalStreams > 0 || managed.unidirectionalStreams > 0) {
        this.touch(managed);
        return;
      }
      const remaining =
        this.options.security.idleTimeoutMs - (performance.now() - managed.lastActivityAt);
      if (remaining > 0) {
        managed.idleTimer = setTimeout(checkIdle, remaining);
      } else {
        void this.closeSession(managed.session, CLOSE_CODE.TIMEOUT, 'Session idle timeout');
      }
    };
    managed.idleTimer = setTimeout(checkIdle, this.options.security.idleTimeoutMs);
  }

  private submit(
    managed: ManagedSession,
    task: () => Promise<void>,
    onError: (error: unknown) => Promise<void>,
    onSettled: () => void = () => {},
  ): TaskSubmissionResult {
    const release = this.handlerBudget.reserve();
    if (release === undefined) {
      onSettled();
      this.rejectedHandlers++;
      return this.options.execution.overflow === 'drop'
        ? 'dropped'
        : this.options.execution.overflow === 'reject'
          ? 'rejected'
          : 'close-session';
    }
    const settle = () => {
      release();
      onSettled();
    };
    const outcome = managed.scheduler.submit(
      () => this.handlerBudget.run(task, managed.context.signal),
      async (error) => {
        if (!managed.context.signal.aborted) await onError(error);
      },
      settle,
    );
    if (outcome !== 'started' && outcome !== 'queued') {
      this.rejectedHandlers++;
      settle();
    }
    return outcome;
  }

  private recordRejection(reason: string): void {
    this.rejectedSessions++;
    this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
  }

  private recordDatagramDrop(reason: string, managed: ManagedSession): void {
    this.droppedDatagrams++;
    this.drops[reason] = (this.drops[reason] ?? 0) + 1;
    this.log({
      level: 'warn',
      event: 'datagram.dropped',
      sessionId: managed.session.id,
      code: reason,
    });
  }

  private clearDatagrams(managed: ManagedSession): void {
    this.queuedDatagramBytes -= managed.queuedDatagramBytes;
    managed.queuedDatagramBytes = 0;
    managed.datagrams.clear();
  }

  private startPump(managed: ManagedSession, pump: Promise<void>): void {
    managed.pumps.add(pump);
    void pump.then(
      () => {
        managed.pumps.delete(pump);
      },
      async (error) => {
        managed.pumps.delete(pump);
        if (!managed.session.signal.aborted && !managed.intakeController.signal.aborted) {
          this.logError('session.pump.failed', error, managed.session.id);
          await this.closeSession(
            managed.session,
            CLOSE_CODE.INTERNAL_ERROR,
            'Incoming transport pump failed',
          );
        }
      },
    );
  }

  private waitForStreams(managed: ManagedSession): Promise<void> {
    if (managed.bidirectionalStreams === 0 && managed.unidirectionalStreams === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => managed.streamIdleWaiters.add(resolve));
  }

  private finalizeSession(managed: ManagedSession): void {
    if (managed.finalized) {
      return;
    }
    managed.finalized = true;
    managed.removeSessionAbortListener();
    if (managed.idleTimer !== undefined) {
      clearTimeout(managed.idleTimer);
    }
    this.stopIntake(managed, managed.session.signal.reason);
    managed.admissionController.abort(managed.session.signal.reason ?? 'Session finalized');
    managed.scheduler.close({ discardPending: true });
    this.clearDatagrams(managed);
    for (const resolve of managed.streamIdleWaiters) {
      resolve();
    }
    managed.streamIdleWaiters.clear();
    this.sessions.delete(managed.session.id);
    this.log({ level: 'info', event: 'session.closed', sessionId: managed.session.id });
    managed.retirement ??= this.retireSession(managed);
  }

  private async retireSession(managed: ManagedSession): Promise<void> {
    await Promise.allSettled([
      managed.admission ?? Promise.resolve(),
      managed.scheduler.onIdle(),
      Promise.allSettled([...managed.pumps]),
    ]);
    if (this.outstandingSessions.delete(managed)) {
      this.releaseIpSlot(managed.ipAddress);
    }
  }

  private stopIntake(managed: ManagedSession, reason: unknown): void {
    if (!managed.intakeController.signal.aborted) {
      managed.intakeController.abort(reason);
    }
    managed.scheduler.close();
    this.clearDatagrams(managed);
    const datagramReader = managed.datagramReader;
    managed.datagramReader = undefined;
    const bidirectionalReader = managed.bidirectionalReader;
    managed.bidirectionalReader = undefined;
    const unidirectionalReader = managed.unidirectionalReader;
    managed.unidirectionalReader = undefined;
    void cancelAndReleaseReader(datagramReader, reason);
    void cancelAndReleaseReader(bidirectionalReader, reason);
    void cancelAndReleaseReader(unidirectionalReader, reason);
  }

  private async closeSession(
    session: WebTransportSession,
    closeCode: number,
    reason: string,
  ): Promise<void> {
    await withTimeout(
      Promise.resolve().then(() => session.close({ closeCode, reason })),
      this.options.shutdown.forceCloseTimeoutMs,
      'Timed out while closing a WebTransport session.',
    ).catch((error) => this.logError('session.close.failed', error, session.id));
  }

  private currentLifecycleState(): string {
    return this.lifecycle.state;
  }

  private log(record: Omit<WebTransportLogRecord, 'timestamp'>, error?: unknown): void {
    const now = performance.now();
    if (now - this.logWindowAt >= 1_000) {
      this.logWindowAt = now;
      this.logsInWindow = 0;
    }
    if (
      this.logsInWindow >= this.options.observability.maxLogsPerSecond ||
      this.pendingLogCallbacks >= this.options.observability.maxLogsPerSecond
    ) {
      this.suppressedLogs++;
      return;
    }
    this.logsInWindow++;
    const entry = { ...record, timestamp: Date.now() };
    const pending: Promise<void>[] = [];
    const observe = (value: unknown) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        'then' in value &&
        typeof value.then === 'function'
      ) {
        pending.push(Promise.resolve(value as PromiseLike<void>));
      }
    };
    try {
      if (error !== undefined) {
        observe(this.options.observability.onError?.(error, entry));
      }
    } catch {
      /* Diagnostics must not affect transport behavior. */
    }
    try {
      observe(this.options.logger(entry));
    } catch {
      // Observability must never affect transport availability or isolation.
    }
    if (pending.length > 0) {
      this.pendingLogCallbacks++;
      void Promise.allSettled(pending).then(() => {
        this.pendingLogCallbacks--;
      });
    }
  }

  private logError(event: string, error: unknown, sessionId?: string, streamId?: bigint): void {
    const record: Omit<WebTransportLogRecord, 'timestamp'> = {
      level: 'error',
      event,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(streamId === undefined ? {} : { streamId: streamId.toString() }),
      ...(error instanceof WebTransportError ? { code: error.code } : {}),
      detail: {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
    };
    this.log(record, error);
  }
}

function measureHeaders(headers: Readonly<Headers>): number {
  const encoder = new TextEncoder();
  let size = 0;
  for (const [name, value] of headers) {
    size += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
  }
  return size;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function cancelAndReleaseReader<T>(
  reader: ReadableStreamDefaultReader<T> | undefined,
  reason: unknown,
): Promise<void> {
  if (reader === undefined) {
    return;
  }
  try {
    await reader.cancel(reason);
  } catch {
    // Session closure may already have terminated the underlying collection.
  } finally {
    releaseReaderLock(reader);
  }
}

function releaseReaderLock<T>(reader: ReadableStreamDefaultReader<T>): void {
  try {
    reader.releaseLock();
  } catch {
    // A concurrent cancellation can keep the reader locked until its read settles.
  }
}

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: (error: WebTransportTimeoutError) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new WebTransportTimeoutError(message, {
        code: 'ERR_WEBTRANSPORT_TIMEOUT',
        scope: 'HANDLER',
      });
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
