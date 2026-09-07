import { WebTransportError, type WebTransportErrorOptions } from './base.error.js';

export class WebTransportSessionError extends WebTransportError {
  constructor(message: string, options: WebTransportErrorOptions) {
    super(message, {
      ...options,
      scope: options.scope ?? 'SESSION',
    });
  }
}

export class SessionClosedError extends WebTransportSessionError {
  constructor(message: string, options: WebTransportErrorOptions) {
    super(message, {
      ...options,
      recoverable: options.recoverable ?? true,
    });
  }
}

export class SessionRejectedError extends WebTransportSessionError {}
