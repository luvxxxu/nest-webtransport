import { WebTransportError, type WebTransportErrorOptions } from './base.error.js';

export class WebTransportStreamError extends WebTransportError {
  constructor(message: string, options: WebTransportErrorOptions) {
    super(message, {
      ...options,
      recoverable: options.recoverable ?? true,
      scope: options.scope ?? 'STREAM',
    });
  }
}

export class StreamResetError extends WebTransportStreamError {}

export class StreamClosedError extends WebTransportStreamError {}
