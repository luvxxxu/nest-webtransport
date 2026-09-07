import type { ModuleMetadata } from '@nestjs/common';
import type {
  DatagramOverflowPolicy,
  HandlerOverflowPolicy,
  SessionContext,
  WebTransportBidirectionalStream,
  WebTransportDriver,
  WebTransportReceiveStream,
  WebTransportResourceLimits,
  WebTransportServerOptions,
  WebTransportSession,
} from 'webtransport-core';

export type MaybePromise<T> = T | Promise<T>;

export interface WebTransportSecurityOptions {
  readonly allowedOrigins?: readonly string[];
  readonly requireOrigin?: boolean;
  readonly maxHeaderSize?: number;
  readonly maxDatagramSize?: number;
  readonly handshakeTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly authenticate?: WebTransportSessionAuthenticator;
}

export type WebTransportSessionAuthenticator = (
  session: WebTransportSession,
  context: SessionContext,
) => MaybePromise<unknown | false>;

export interface WebTransportExecutionModuleOptions {
  readonly maxConcurrentHandlers?: number;
  readonly maxPendingHandlers?: number;
  readonly overflow?: HandlerOverflowPolicy;
}

export interface WebTransportDatagramModuleOptions {
  readonly queue?: {
    readonly size?: number;
    readonly overflow?: DatagramOverflowPolicy;
  };
}

export interface WebTransportShutdownOptions {
  readonly graceful?: boolean;
  readonly drainTimeoutMs?: number;
  readonly forceCloseTimeoutMs?: number;
}

export interface WebTransportRouteResolution<TValue> {
  readonly route?: string;
  readonly payload?: unknown;
  readonly value?: TValue;
}

export type WebTransportDatagramRouteResolver = (
  datagram: Uint8Array,
  session: WebTransportSession,
  context: SessionContext,
) => MaybePromise<WebTransportRouteResolution<Uint8Array>>;

export type WebTransportBidirectionalStreamRouteResolver = (
  stream: WebTransportBidirectionalStream,
  session: WebTransportSession,
  context: SessionContext,
) => MaybePromise<WebTransportRouteResolution<WebTransportBidirectionalStream>>;

export type WebTransportUnidirectionalStreamRouteResolver = (
  stream: WebTransportReceiveStream,
  session: WebTransportSession,
  context: SessionContext,
) => MaybePromise<WebTransportRouteResolution<WebTransportReceiveStream>>;

export interface WebTransportRoutingOptions {
  readonly datagram?: WebTransportDatagramRouteResolver;
  readonly bidirectionalStream?: WebTransportBidirectionalStreamRouteResolver;
  readonly unidirectionalStream?: WebTransportUnidirectionalStreamRouteResolver;
}

export interface WebTransportLogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly timestamp: number;
  readonly sessionId?: string;
  readonly streamId?: string;
  readonly code?: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export type WebTransportLogger = (record: WebTransportLogRecord) => void;

export interface WebTransportResourceLimitOverrides {
  readonly server?: Partial<WebTransportResourceLimits['server']>;
  readonly ip?: Partial<WebTransportResourceLimits['ip']>;
  readonly session?: Partial<WebTransportResourceLimits['session']>;
  readonly stream?: Partial<WebTransportResourceLimits['stream']>;
}

export interface WebTransportModuleOptions {
  readonly driver: WebTransportDriver;
  readonly server: WebTransportServerOptions;
  readonly security?: WebTransportSecurityOptions;
  readonly limits?: WebTransportResourceLimitOverrides;
  readonly execution?: WebTransportExecutionModuleOptions;
  readonly datagrams?: WebTransportDatagramModuleOptions;
  readonly routing?: WebTransportRoutingOptions;
  readonly shutdown?: WebTransportShutdownOptions;
  readonly logger?: WebTransportLogger;
}

export interface WebTransportModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly inject?: readonly unknown[];
  readonly useFactory: (
    ...dependencies: readonly unknown[]
  ) => MaybePromise<WebTransportModuleOptions>;
}
