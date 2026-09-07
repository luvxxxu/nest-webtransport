import type { WebTransportResourceLimits } from 'webtransport-core';

import type { WebTransportModuleOptions } from '../interfaces/module-options.interface.js';

export interface NormalizedWebTransportModuleOptions
  extends Omit<
    WebTransportModuleOptions,
    'security' | 'limits' | 'execution' | 'datagrams' | 'routing' | 'shutdown' | 'logger'
  > {
  readonly security: {
    readonly allowedOrigins: ReadonlySet<string>;
    readonly requireOrigin: boolean;
    readonly maxHeaderSize: number;
    readonly maxDatagramSize: number;
    readonly handshakeTimeoutMs: number;
    readonly idleTimeoutMs: number;
    readonly authenticate: WebTransportModuleOptions['security'] extends infer _Security
      ? NonNullable<WebTransportModuleOptions['security']>['authenticate']
      : never;
  };
  readonly limits: WebTransportResourceLimits;
  readonly execution: {
    readonly maxConcurrentHandlers: number;
    readonly maxPendingHandlers: number;
    readonly overflow: 'drop' | 'reject' | 'close-session';
  };
  readonly datagrams: {
    readonly queue: {
      readonly size: number;
      readonly overflow: 'drop-oldest' | 'drop-newest' | 'reject' | 'close-session';
    };
  };
  readonly routing: NonNullable<WebTransportModuleOptions['routing']>;
  readonly shutdown: {
    readonly graceful: boolean;
    readonly drainTimeoutMs: number;
    readonly forceCloseTimeoutMs: number;
  };
  readonly logger: NonNullable<WebTransportModuleOptions['logger']>;
}

const DEFAULT_LIMITS: WebTransportResourceLimits = Object.freeze({
  server: Object.freeze({ maxSessions: 50_000 }),
  ip: Object.freeze({ maxSessions: 100, sessionsPerSecond: 10 }),
  session: Object.freeze({
    maxBidirectionalStreams: 100,
    maxUnidirectionalStreams: 100,
    maxDatagramsPerSecond: 1_000,
    maxConcurrentHandlers: 64,
    maxPendingHandlers: 128,
  }),
  stream: Object.freeze({ maxLifetimeMs: 300_000 }),
});

const HANDLER_OVERFLOW_POLICIES = new Set(['drop', 'reject', 'close-session']);
const DATAGRAM_OVERFLOW_POLICIES = new Set([
  'drop-oldest',
  'drop-newest',
  'reject',
  'close-session',
]);

export function normalizeWebTransportModuleOptions(
  options: WebTransportModuleOptions,
): NormalizedWebTransportModuleOptions {
  if (options == null || options.driver == null) {
    throw new TypeError('WebTransportModule requires a driver.');
  }
  if (options.server == null) {
    throw new TypeError('WebTransportModule requires server options.');
  }
  assertPort(options.server.port);

  const limits: WebTransportResourceLimits = {
    server: {
      ...DEFAULT_LIMITS.server,
      ...options.limits?.server,
    },
    ip: {
      ...DEFAULT_LIMITS.ip,
      ...options.limits?.ip,
    },
    session: {
      ...DEFAULT_LIMITS.session,
      ...options.limits?.session,
    },
    stream: {
      ...DEFAULT_LIMITS.stream,
      ...options.limits?.stream,
    },
  };

  validatePositiveLimits(limits);

  const maxConcurrentHandlers =
    options.execution?.maxConcurrentHandlers ?? limits.session.maxConcurrentHandlers;
  const maxPendingHandlers =
    options.execution?.maxPendingHandlers ?? limits.session.maxPendingHandlers;

  assertPositiveSafeInteger(maxConcurrentHandlers, 'execution.maxConcurrentHandlers');
  assertNonNegativeSafeInteger(maxPendingHandlers, 'execution.maxPendingHandlers');

  const queueSize = options.datagrams?.queue?.size ?? 256;
  assertPositiveSafeInteger(queueSize, 'datagrams.queue.size');
  if (queueSize > 0xffff_ffff) {
    throw new RangeError('datagrams.queue.size must not exceed 4294967295');
  }
  const requireOrigin = options.security?.requireOrigin ?? true;
  const allowedOrigins = (options.security?.allowedOrigins ?? []).map((origin, index) =>
    normalizeWebTransportOrigin(origin, `security.allowedOrigins[${index}]`),
  );
  if (requireOrigin && allowedOrigins.length === 0) {
    throw new TypeError(
      'security.allowedOrigins must contain at least one origin when requireOrigin is enabled.',
    );
  }
  const maxHeaderSize = options.security?.maxHeaderSize ?? 16 * 1024;
  const maxDatagramSize = options.security?.maxDatagramSize ?? 64 * 1024;
  const handshakeTimeoutMs = options.security?.handshakeTimeoutMs ?? 5_000;
  const idleTimeoutMs = options.security?.idleTimeoutMs ?? 60_000;
  const drainTimeoutMs = options.shutdown?.drainTimeoutMs ?? 10_000;
  const forceCloseTimeoutMs = options.shutdown?.forceCloseTimeoutMs ?? 15_000;
  assertPositiveSafeInteger(maxHeaderSize, 'security.maxHeaderSize');
  assertPositiveSafeInteger(maxDatagramSize, 'security.maxDatagramSize');
  assertPositiveSafeInteger(handshakeTimeoutMs, 'security.handshakeTimeoutMs');
  assertPositiveSafeInteger(idleTimeoutMs, 'security.idleTimeoutMs');
  assertNonNegativeSafeInteger(drainTimeoutMs, 'shutdown.drainTimeoutMs');
  assertPositiveSafeInteger(forceCloseTimeoutMs, 'shutdown.forceCloseTimeoutMs');
  for (const [name, value] of Object.entries({
    'security.handshakeTimeoutMs': handshakeTimeoutMs,
    'security.idleTimeoutMs': idleTimeoutMs,
    'shutdown.drainTimeoutMs': drainTimeoutMs,
    'shutdown.forceCloseTimeoutMs': forceCloseTimeoutMs,
    'limits.stream.maxLifetimeMs': limits.stream.maxLifetimeMs,
  })) {
    if (value > 2_147_483_647) {
      throw new RangeError(`${name} must not exceed the 2147483647 ms timer limit`);
    }
  }
  const handlerOverflow = options.execution?.overflow ?? 'drop';
  assertPolicy(handlerOverflow, HANDLER_OVERFLOW_POLICIES, 'execution.overflow');
  const datagramOverflow = options.datagrams?.queue?.overflow ?? 'drop-oldest';
  assertPolicy(datagramOverflow, DATAGRAM_OVERFLOW_POLICIES, 'datagrams.queue.overflow');

  return Object.freeze({
    driver: options.driver,
    server: options.server,
    security: Object.freeze({
      allowedOrigins: new Set(allowedOrigins),
      requireOrigin,
      maxHeaderSize,
      maxDatagramSize,
      handshakeTimeoutMs,
      idleTimeoutMs,
      authenticate: options.security?.authenticate,
    }),
    limits: Object.freeze({
      server: Object.freeze(limits.server),
      ip: Object.freeze(limits.ip),
      session: Object.freeze(limits.session),
      stream: Object.freeze(limits.stream),
    }),
    execution: Object.freeze({
      maxConcurrentHandlers,
      maxPendingHandlers,
      overflow: handlerOverflow,
    }),
    datagrams: Object.freeze({
      queue: Object.freeze({
        size: queueSize,
        overflow: datagramOverflow,
      }),
    }),
    routing: Object.freeze({ ...(options.routing ?? {}) }),
    shutdown: Object.freeze({
      graceful: options.shutdown?.graceful ?? true,
      drainTimeoutMs,
      forceCloseTimeoutMs,
    }),
    logger: options.logger ?? (() => undefined),
  });
}

export function normalizeWebTransportOrigin(origin: string, label = 'origin'): string {
  if (origin === 'null') {
    return origin;
  }
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new TypeError(`${label} must be a non-empty serialized Origin.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError(`${label} must be a valid serialized Origin.`);
  }
  if (
    parsed.origin === 'null' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(`${label} must not contain credentials, a path, query, or fragment.`);
  }
  return parsed.origin;
}

function validatePositiveLimits(limits: WebTransportResourceLimits): void {
  assertPositiveSafeInteger(limits.server.maxSessions, 'limits.server.maxSessions');
  assertPositiveSafeInteger(limits.ip.maxSessions, 'limits.ip.maxSessions');
  assertPositiveSafeInteger(limits.ip.sessionsPerSecond, 'limits.ip.sessionsPerSecond');
  assertPositiveSafeInteger(
    limits.session.maxBidirectionalStreams,
    'limits.session.maxBidirectionalStreams',
  );
  assertPositiveSafeInteger(
    limits.session.maxUnidirectionalStreams,
    'limits.session.maxUnidirectionalStreams',
  );
  assertPositiveSafeInteger(
    limits.session.maxDatagramsPerSecond,
    'limits.session.maxDatagramsPerSecond',
  );
  assertPositiveSafeInteger(
    limits.session.maxConcurrentHandlers,
    'limits.session.maxConcurrentHandlers',
  );
  assertNonNegativeSafeInteger(
    limits.session.maxPendingHandlers,
    'limits.session.maxPendingHandlers',
  );
  assertPositiveSafeInteger(limits.stream.maxLifetimeMs, 'limits.stream.maxLifetimeMs');
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertPort(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError('server.port must be an integer between 0 and 65535.');
  }
}

function assertPolicy(value: string, allowed: ReadonlySet<string>, label: string): void {
  if (!allowed.has(value)) {
    throw new TypeError(`${label} is not a supported overflow policy.`);
  }
}
