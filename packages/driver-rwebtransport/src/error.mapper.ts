import { WebTransportError as NativeWebTransportError } from 'rwebtransport';
import {
  WebTransportError as CoreWebTransportError,
  SessionClosedError,
  StreamClosedError,
  StreamResetError,
  WebTransportDriverError,
  type WebTransportErrorScope,
  WebTransportSessionError,
  WebTransportStreamError,
  WebTransportTimeoutError,
} from 'webtransport-core';

export type RWebTransportErrorTarget = 'driver' | 'session' | 'stream';

export interface RWebTransportErrorMappingOptions {
  readonly target: RWebTransportErrorTarget;
  readonly operation?: string;
  readonly code?: string;
}

const DEFAULT_CODES: Readonly<Record<RWebTransportErrorTarget, string>> = Object.freeze({
  driver: 'RWEBTRANSPORT_DRIVER_ERROR',
  session: 'RWEBTRANSPORT_SESSION_ERROR',
  stream: 'RWEBTRANSPORT_STREAM_ERROR',
});

const DEFAULT_MESSAGES: Readonly<Record<RWebTransportErrorTarget, string>> = Object.freeze({
  driver: 'rwebtransport driver operation failed',
  session: 'rwebtransport session operation failed',
  stream: 'rwebtransport stream operation failed',
});

function errorMessage(error: unknown, options: RWebTransportErrorMappingOptions): string {
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : DEFAULT_MESSAGES[options.target];

  return options.operation === undefined ? detail : `${options.operation}: ${detail}`;
}

function targetScope(target: RWebTransportErrorTarget): WebTransportErrorScope {
  switch (target) {
    case 'driver':
      return 'SERVER';
    case 'session':
      return 'SESSION';
    case 'stream':
      return 'STREAM';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'TimeoutError'
    : error instanceof Error && error.name === 'TimeoutError';
}

export function mapRWebTransportError(
  error: unknown,
  options: RWebTransportErrorMappingOptions,
): CoreWebTransportError {
  if (error instanceof CoreWebTransportError) {
    return error;
  }

  const message = errorMessage(error, options);
  const code = options.code ?? DEFAULT_CODES[options.target];
  const scope = targetScope(options.target);

  if (isTimeoutError(error)) {
    return new WebTransportTimeoutError(message, {
      code: options.code ?? 'RWEBTRANSPORT_TIMEOUT',
      cause: error,
      scope,
    });
  }

  if (isAbortError(error)) {
    if (options.target === 'stream') {
      return new StreamClosedError(message, {
        code: options.code ?? 'RWEBTRANSPORT_STREAM_ABORTED',
        cause: error,
      });
    }

    if (options.target === 'session') {
      return new SessionClosedError(message, {
        code: options.code ?? 'RWEBTRANSPORT_SESSION_ABORTED',
        cause: error,
      });
    }
  }

  if (options.target === 'driver') {
    return new WebTransportDriverError(message, {
      code,
      cause: error,
      recoverable: false,
    });
  }

  if (options.target === 'stream') {
    if (error instanceof NativeWebTransportError && error.streamErrorCode !== null) {
      return new StreamResetError(message, {
        code: options.code ?? 'RWEBTRANSPORT_STREAM_RESET',
        cause: error,
      });
    }

    return new WebTransportStreamError(message, {
      code,
      cause: error,
    });
  }

  if (error instanceof NativeWebTransportError && error.source === 'stream') {
    return new WebTransportStreamError(message, {
      code: options.code ?? 'RWEBTRANSPORT_STREAM_ERROR',
      cause: error,
    });
  }

  return new WebTransportSessionError(message, {
    code,
    cause: error,
  });
}

export function createNativeStreamError(
  code = 0,
  message = 'stream reset by application',
): NativeWebTransportError {
  return new NativeWebTransportError(message, {
    source: 'stream',
    streamErrorCode: code >>> 0,
  });
}
