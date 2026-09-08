import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('cancels the shipped browser reader when an echo response exceeds 1 MiB', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function readAll(reader)');
  expect(start).toBeGreaterThan(-1);
  // Load the actual browser helpers without running the page's DOM setup.
  const readAll = runInNewContext(`${source.slice(start)}\nreadAll`, { Uint8Array, Error }) as (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) => Promise<Uint8Array>;
  const cancel = vi.fn();
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel,
  }).getReader();
  await expect(readAll(reader)).rejects.toThrow('Demo response exceeds 1 MiB');
  expect(cancel).toHaveBeenCalledTimes(1);
  reader.releaseLock();
});
