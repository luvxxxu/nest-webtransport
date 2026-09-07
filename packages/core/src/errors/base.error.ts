import type { WebTransportErrorScope } from './error-scope.js';

export interface WebTransportErrorOptions {
  readonly code: string;
  readonly recoverable?: boolean;
  readonly scope?: WebTransportErrorScope;
  readonly cause?: unknown;
}

export class WebTransportError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  readonly scope: WebTransportErrorScope;

  constructor(message: string, options: WebTransportErrorOptions) {
    if ('cause' in options) {
      super(message, { cause: options.cause });
    } else {
      super(message);
    }

    this.name = new.target.name;
    this.code = options.code;
    this.recoverable = options.recoverable ?? false;
    this.scope = options.scope ?? 'FATAL';
  }
}
