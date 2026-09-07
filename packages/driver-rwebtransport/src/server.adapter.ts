import {
  type WebTransportServerOptions as CoreServerOptions,
  type WebTransportCredential,
  WebTransportDriverError,
} from 'webtransport-core';
import {
  WebTransportServer as NativeServer,
  type WebTransportServerOptions as NativeServerOptions,
  type WebTransportServerSession as NativeSession,
} from '../vendor/rwebtransport.mjs';

import { mapRWebTransportError } from './error.mapper.js';

export type RWebTransportServerFactory = (options: NativeServerOptions) => NativeServer;

export interface RWebTransportServerHandlers {
  session(session: NativeSession): void | Promise<void>;
  error(error: unknown): void;
}

export interface RWebTransportServerAdapterOptions {
  readonly allowedOrigins?: readonly string[];
  readonly reusePort?: boolean;
  readonly responseHeaders?: Readonly<Record<string, string>>;
}

function credentialPath(credential: WebTransportCredential, name: string): string {
  if (credential.kind !== 'path') {
    throw new WebTransportDriverError(
      `rwebtransport requires ${name} to be provided as a filesystem path`,
      {
        code: 'RWEBTRANSPORT_TLS_PATH_REQUIRED',
        recoverable: false,
      },
    );
  }
  if (credential.path.trim().length === 0) {
    throw new WebTransportDriverError(`${name} path must not be empty`, {
      code: 'RWEBTRANSPORT_TLS_PATH_EMPTY',
      recoverable: false,
    });
  }
  return credential.path;
}

function nativeOptions(
  options: CoreServerOptions,
  adapterOptions: RWebTransportServerAdapterOptions,
): NativeServerOptions {
  if (options.tls === undefined) {
    throw new WebTransportDriverError('rwebtransport requires TLS certificate and key paths', {
      code: 'RWEBTRANSPORT_TLS_REQUIRED',
      recoverable: false,
    });
  }
  if (options.tls.passphrase !== undefined) {
    throw new WebTransportDriverError('rwebtransport does not support encrypted private keys', {
      code: 'RWEBTRANSPORT_TLS_PASSPHRASE_UNSUPPORTED',
      recoverable: false,
    });
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new WebTransportDriverError('server port must be an integer between 0 and 65535', {
      code: 'RWEBTRANSPORT_INVALID_PORT',
      recoverable: false,
    });
  }

  return {
    port: options.port,
    cert: credentialPath(options.tls.certificate, 'certificate'),
    key: credentialPath(options.tls.privateKey, 'private key'),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.applicationProtocols === undefined
      ? {}
      : { supportedProtocols: [...options.applicationProtocols] }),
    ...(adapterOptions.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: [...adapterOptions.allowedOrigins] }),
    ...(adapterOptions.reusePort === undefined ? {} : { reusePort: adapterOptions.reusePort }),
    ...(adapterOptions.responseHeaders === undefined
      ? {}
      : { responseHeaders: { ...adapterOptions.responseHeaders } }),
  };
}

function abortError(): DOMException {
  return new DOMException('Server start was aborted', 'AbortError');
}

export class RWebTransportServerAdapter {
  private server: NativeServer | undefined;
  private reader: ReadableStreamDefaultReader<NativeSession> | undefined;
  private pumpPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopping = false;
  private removeAbortListener: () => void = () => {};

  constructor(
    private readonly options: RWebTransportServerAdapterOptions = {},
    private readonly factory: RWebTransportServerFactory = (options) => new NativeServer(options),
  ) {}

  get port(): number {
    return this.server?.port ?? 0;
  }

  start(options: CoreServerOptions, handlers: RWebTransportServerHandlers): Promise<void> {
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.startPromise = this.performStart(options, handlers);
    void this.startPromise.catch(() => {});
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    this.stopPromise = this.performStop();
    void this.stopPromise.catch(() => {});
    return this.stopPromise;
  }

  private async performStart(
    options: CoreServerOptions,
    handlers: RWebTransportServerHandlers,
  ): Promise<void> {
    if (options.signal?.aborted === true) {
      throw mapRWebTransportError(options.signal.reason ?? abortError(), {
        target: 'driver',
        operation: 'start server',
        code: 'RWEBTRANSPORT_START_ABORTED',
      });
    }

    try {
      this.server = this.factory(nativeOptions(options, this.options));
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'driver',
        operation: 'create server',
        code: 'RWEBTRANSPORT_SERVER_CREATE_FAILED',
      });
    }

    const server = this.server;
    this.pumpPromise = this.pumpSessions(server, handlers);
    void this.pumpPromise.catch(() => {});

    let rejectForAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectForAbort = reject;
    });
    const handleAbort = (): void => {
      const error = options.signal?.reason ?? abortError();
      rejectForAbort?.(error);
      void this.stop();
    };
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', handleAbort, { once: true });
      this.removeAbortListener = () => options.signal?.removeEventListener('abort', handleAbort);
    }

    try {
      const closedBeforeReady = server.closed.then(() => {
        throw new WebTransportDriverError('rwebtransport server closed before becoming ready', {
          code: 'RWEBTRANSPORT_SERVER_CLOSED_DURING_START',
          recoverable: false,
        });
      });
      await (options.signal === undefined
        ? Promise.race([server.ready, closedBeforeReady])
        : Promise.race([server.ready, closedBeforeReady, aborted]));
      void server.closed.then(
        () => {
          if (!this.stopping)
            this.reportError(
              handlers,
              new WebTransportDriverError('Native server closed unexpectedly', {
                code: 'RWEBTRANSPORT_SERVER_CLOSED',
                recoverable: false,
              }),
            );
        },
        (error: unknown) => {
          if (!this.stopping)
            this.reportError(
              handlers,
              mapRWebTransportError(error, {
                target: 'driver',
                operation: 'native server closed',
              }),
            );
        },
      );
    } catch (error) {
      await this.stop().catch(() => {});
      throw mapRWebTransportError(error, {
        target: 'driver',
        operation: 'start server',
        code: 'RWEBTRANSPORT_SERVER_START_FAILED',
      });
    }
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    this.removeAbortListener();
    const server = this.server;
    if (server === undefined) {
      return;
    }

    try {
      server.close();
      await server.closed;
    } catch (error) {
      throw mapRWebTransportError(error, {
        target: 'driver',
        operation: 'stop server',
        code: 'RWEBTRANSPORT_SERVER_STOP_FAILED',
      });
    } finally {
      try {
        await this.reader?.cancel();
      } catch {
        // The native incomingSessions stream may already be closed.
      }
      await this.pumpPromise?.catch(() => {});
      this.reader = undefined;
      this.server = undefined;
    }
  }

  private async pumpSessions(
    server: NativeServer,
    handlers: RWebTransportServerHandlers,
  ): Promise<void> {
    const reader = server.incomingSessions.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          return;
        }

        try {
          await handlers.session(result.value);
        } catch (error) {
          try {
            result.value.close({ closeCode: 1, reason: 'session dispatch failed' });
          } catch {
            // Preserve the original dispatch failure.
          }
          this.reportError(
            handlers,
            mapRWebTransportError(error, {
              target: 'session',
              operation: 'dispatch accepted session',
            }),
          );
        }
      }
    } catch (error) {
      if (!this.stopping) {
        this.reportError(
          handlers,
          mapRWebTransportError(error, {
            target: 'driver',
            operation: 'accept sessions',
            code: 'RWEBTRANSPORT_SESSION_PUMP_FAILED',
          }),
        );
      }
    } finally {
      if (this.reader === reader) {
        this.reader = undefined;
      }
      try {
        reader.releaseLock();
      } catch {
        // A concurrent stop can release or cancel the reader first.
      }
    }
  }

  private reportError(handlers: RWebTransportServerHandlers, error: unknown): void {
    try {
      handlers.error(error);
    } catch {
      // Error reporting is an isolation boundary and must not terminate the session pump.
    }
  }
}
