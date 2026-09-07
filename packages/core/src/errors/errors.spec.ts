import { describe, expect, it } from 'vitest';

import { WebTransportDriverError } from './driver.error.js';
import { StreamResetError } from './stream.error.js';

describe('WebTransport errors', () => {
  it('preserves the low-level cause without exposing its concrete type', () => {
    const cause = new Error('native failure');
    const error = new WebTransportDriverError('driver failed', {
      code: 'ERR_DRIVER',
      cause,
    });

    expect(error).toMatchObject({
      code: 'ERR_DRIVER',
      recoverable: false,
      scope: 'SERVER',
      cause,
    });
  });

  it('defaults stream failures to recoverable stream scope', () => {
    const error = new StreamResetError('peer reset the stream', {
      code: 'ERR_STREAM_RESET',
    });

    expect(error.recoverable).toBe(true);
    expect(error.scope).toBe('STREAM');
  });
});
