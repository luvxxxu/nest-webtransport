import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';

import { createBoundedLogger } from './bounded-logger.js';

it('drops log records while stdout is backpressured and reports the suppressed count', async () => {
  const output = new PassThrough({ highWaterMark: 1 });
  const logger = createBoundedLogger(output);
  const record = { event: 'overload', level: 'warn' as const, timestamp: Date.now() };
  logger(record);
  const buffered = output.writableLength;
  for (let index = 0; index < 100; index++) logger(record);
  expect(output.writableLength).toBe(buffered);
  let text = '';
  output.on('data', (chunk) => {
    text += chunk.toString();
  });
  const drained = once(output, 'drain');
  output.resume();
  await drained;
  logger(record);
  await setImmediate();
  expect(text).toContain('"loggerSuppressed":100');
  output.destroy();
});
