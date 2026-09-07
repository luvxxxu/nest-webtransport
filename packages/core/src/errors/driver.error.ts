import { WebTransportError, type WebTransportErrorOptions } from './base.error.js';

export class WebTransportDriverError extends WebTransportError {
  constructor(message: string, options: WebTransportErrorOptions) {
    super(message, {
      ...options,
      scope: options.scope ?? 'SERVER',
    });
  }
}
