import type { WebTransportReceiveStream, WebTransportSendStream } from 'rwebtransport';
import { describe, expect, it } from 'vitest';
import {
  createRWebTransportStreamAbortContext,
  RWebTransportReceiveStreamAdapter,
  RWebTransportSendStreamAdapter,
} from './stream.adapter.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('native stream terminal propagation', () => {
  it('observes peer errors while no write is active and releases the native writer', async () => {
    let controller!: WritableStreamDefaultController;
    const native = new WritableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    Object.defineProperty(native, 'streamId', { value: 4 });
    const stream = new RWebTransportSendStreamAdapter(
      native as WebTransportSendStream,
      createRWebTransportStreamAbortContext(new AbortController().signal),
    );
    controller.error(new Error('peer STOP_SENDING'));
    await tick();
    expect(stream.signal.aborted).toBe(true);
    expect(native.locked).toBe(false);
    const writer = stream.writable.getWriter();
    await expect(writer.closed).rejects.toThrow();
    writer.releaseLock();
  });

  it('propagates parent close to pending reads, idle writes, and their locks', async () => {
    const parent = new AbortController();
    const nativeRead = new ReadableStream<Uint8Array>();
    const nativeWrite = new WritableStream<Uint8Array>();
    Object.defineProperty(nativeRead, 'streamId', { value: 3 });
    Object.defineProperty(nativeWrite, 'streamId', { value: 4 });
    const context = createRWebTransportStreamAbortContext(parent.signal);
    const receive = new RWebTransportReceiveStreamAdapter(
      nativeRead as WebTransportReceiveStream,
      context,
    );
    const send = new RWebTransportSendStreamAdapter(nativeWrite as WebTransportSendStream, context);
    const reader = receive.readable.getReader();
    const reading = expect(reader.read()).rejects.toThrow('session ended');
    parent.abort(new Error('session ended'));
    await reading;
    await tick();
    expect(nativeRead.locked).toBe(false);
    expect(nativeWrite.locked).toBe(false);
    expect(send.signal.aborted).toBe(true);
    reader.releaseLock();
  });

  it('tolerates a parent abort racing with an application writable close', async () => {
    const parent = new AbortController();
    let finishClose!: () => void;
    const native = new WritableStream<Uint8Array>({
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    });
    Object.defineProperty(native, 'streamId', { value: 5 });
    const stream = new RWebTransportSendStreamAdapter(
      native as WebTransportSendStream,
      createRWebTransportStreamAbortContext(parent.signal),
    );
    const writer = stream.writable.getWriter();
    const closing = writer.close().catch(() => undefined);

    await tick();
    parent.abort(new Error('session ended while closing'));
    finishClose();
    await closing;
    await tick();

    expect(native.locked).toBe(false);
    writer.releaseLock();
  });

  it('observes an errored readable even when the bridge already buffered a chunk', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const native = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(new Uint8Array([1]));
      },
    });
    Object.defineProperty(native, 'streamId', { value: 3 });
    const stream = new RWebTransportReceiveStreamAdapter(
      native as WebTransportReceiveStream,
      createRWebTransportStreamAbortContext(new AbortController().signal),
    );
    await tick();
    controller.error(new Error('peer RESET_STREAM'));
    await tick();
    expect(stream.signal.aborted).toBe(true);
    expect(native.locked).toBe(false);
    await expect(stream.readable.getReader().read()).rejects.toThrow();
  });
});
