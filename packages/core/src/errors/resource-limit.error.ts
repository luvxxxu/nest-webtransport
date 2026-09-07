import { WebTransportError, type WebTransportErrorOptions } from './base.error.js';

export class WebTransportResourceLimitError extends WebTransportError {
  constructor(message: string, options: WebTransportErrorOptions) {
    super(message, {
      ...options,
      recoverable: options.recoverable ?? true,
      scope: options.scope ?? 'HANDLER',
    });
  }
}
