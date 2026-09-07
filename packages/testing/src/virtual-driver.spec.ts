import { describe, expect, it } from 'vitest';
import {
  SessionRejectedError,
  WebTransportServerState,
  type WebTransportSession,
  WebTransportSessionState,
} from 'webtransport-core';

import { TestClient } from './test-client.js';
import { VirtualWebTransportDriver } from './virtual-driver.js';

async function receiveOne<T>(stream: ReadableStream<T>): Promise<T | undefined> {
  const reader = stream.getReader();
  try {
    const result = await reader.read();
    return result.done ? undefined : result.value;
  } finally {
    reader.releaseLock();
  }
}

async function writeOne(stream: WritableStream<Uint8Array>, value: Uint8Array): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(value);
  } finally {
    writer.releaseLock();
  }
}

async function closeWritable(stream: WritableStream<Uint8Array>): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

describe('VirtualWebTransportDriver', () => {
  it('connects deterministically and exposes request metadata to the server', async () => {
    const driver = new VirtualWebTransportDriver({ now: () => 123 });
    const accepted: WebTransportSession[] = [];
    const unsubscribe = driver.onSession((session) => {
      accepted.push(session);
    });
    await driver.start({ port: 0 });

    const client = await new TestClient(driver).connect('/chat', {
      authorization: 'Bearer test-token',
      'x-test': 'present',
    });

    expect(client.id).toBe('virtual-session-1');
    expect(client.path).toBe('/chat');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.path).toBe('/chat');
    expect(accepted[0]?.headers.get('authorization')).toBe('Bearer test-token');
    expect(accepted[0]?.headers.get('x-test')).toBe('present');
    expect(accepted[0]?.remoteAddress).toBe('127.0.0.1');
    expect(accepted[0]?.remotePort).toBe(40_000);

    const mutableCopy = accepted[0]?.headers as Headers;
    mutableCopy.set('x-test', 'changed');
    expect(accepted[0]?.headers.get('x-test')).toBe('present');
    expect(driver.getStats()).toEqual({
      capturedAt: 123,
      state: WebTransportServerState.RUNNING,
      sessions: { active: 1, total: 1, rejected: 0 },
      streams: { active: 0, total: 0 },
      datagrams: { received: 0, sent: 0, dropped: 0 },
      bytes: { received: 0, sent: 0 },
    });

    unsubscribe();
    await driver.stop();
  });

  it('moves datagrams in both directions and copies their bytes', async () => {
    const driver = new VirtualWebTransportDriver();
    const accepted: WebTransportSession[] = [];
    driver.onSession((session) => {
      accepted.push(session);
    });
    await driver.start({ port: 0 });
    const client = await new TestClient(driver).connect('/datagrams');
    const server = accepted[0];
    expect(server).toBeDefined();
    if (server === undefined) {
      return;
    }

    const clientPayload = new Uint8Array([1, 2, 3]);
    await client.sendDatagram(clientPayload);
    clientPayload[0] = 9;
    expect(await receiveOne(server.datagrams.readable)).toEqual(new Uint8Array([1, 2, 3]));

    const response = new Uint8Array([4, 5]);
    await writeOne(server.datagrams.writable, response);
    response[0] = 8;
    expect(await client.receiveDatagram()).toEqual(new Uint8Array([4, 5]));

    const stats = driver.getStats();
    expect(stats.datagrams).toEqual({ received: 2, sent: 2, dropped: 0 });
    expect(stats.bytes).toEqual({ received: 5, sent: 5 });
    await driver.stop();
  });

  it('creates client-initiated bidirectional and unidirectional streams', async () => {
    const driver = new VirtualWebTransportDriver();
    const accepted: WebTransportSession[] = [];
    driver.onSession((session) => {
      accepted.push(session);
    });
    await driver.start({ port: 0 });
    const client = await new TestClient(driver).connect('/streams');
    const server = accepted[0];
    expect(server).toBeDefined();
    if (server === undefined) {
      return;
    }

    const clientBidi = await client.createBidirectionalStream();
    const serverBidi = await receiveOne(server.incomingBidirectionalStreams);
    expect(serverBidi?.id).toBe(clientBidi.id);
    expect(serverBidi).toBeDefined();
    if (serverBidi === undefined) {
      return;
    }

    await writeOne(clientBidi.writable, new Uint8Array([10, 11]));
    expect(await receiveOne(serverBidi.readable)).toEqual(new Uint8Array([10, 11]));
    await writeOne(serverBidi.writable, new Uint8Array([12]));
    expect(await receiveOne(clientBidi.readable)).toEqual(new Uint8Array([12]));

    const clientUni = await client.createUnidirectionalStream();
    const serverUni = await receiveOne(server.incomingUnidirectionalStreams);
    expect(serverUni?.id).toBe(clientUni.id);
    expect(serverUni).toBeDefined();
    if (serverUni === undefined) {
      return;
    }
    await writeOne(clientUni.writable, new Uint8Array([20, 21, 22]));
    expect(await receiveOne(serverUni.readable)).toEqual(new Uint8Array([20, 21, 22]));

    expect(driver.getStats().streams).toEqual({ active: 2, total: 2 });
    await closeWritable(clientBidi.writable);
    expect(clientBidi.signal.aborted).toBe(false);
    await closeWritable(serverBidi.writable);
    expect(clientBidi.signal.aborted).toBe(true);
    await closeWritable(clientUni.writable);
    expect(clientUni.signal.aborted).toBe(true);
    expect(driver.getStats().streams).toEqual({ active: 0, total: 2 });
    await driver.stop();
  });

  it('lets the client observe server-created outbound streams', async () => {
    const driver = new VirtualWebTransportDriver();
    const accepted: WebTransportSession[] = [];
    driver.onSession((session) => {
      accepted.push(session);
    });
    await driver.start({ port: 0 });
    const client = await new TestClient(driver).connect('/server-push');
    const server = accepted[0];
    expect(server).toBeDefined();
    if (server === undefined) {
      return;
    }

    const serverBidi = await server.createBidirectionalStream();
    const clientBidi = await client.receiveBidirectionalStream();
    expect(clientBidi?.id).toBe(serverBidi.id);
    expect(clientBidi).toBeDefined();
    if (clientBidi === undefined) {
      return;
    }
    await writeOne(serverBidi.writable, new Uint8Array([30]));
    expect(await receiveOne(clientBidi.readable)).toEqual(new Uint8Array([30]));

    const serverUni = await server.createUnidirectionalStream();
    const clientUni = await client.receiveUnidirectionalStream();
    expect(clientUni?.id).toBe(serverUni.id);
    expect(clientUni).toBeDefined();
    if (clientUni === undefined) {
      return;
    }
    await writeOne(serverUni.writable, new Uint8Array([31, 32]));
    expect(await receiveOne(clientUni.readable)).toEqual(new Uint8Array([31, 32]));

    await serverBidi.reset();
    await serverUni.reset();
    await driver.stop();
  });

  it('applies stream backpressure at the configured hard queue boundary', async () => {
    const driver = new VirtualWebTransportDriver({ streamQueueSize: 1 });
    const accepted: WebTransportSession[] = [];
    driver.onSession((session) => {
      accepted.push(session);
    });
    await driver.start({ port: 0 });
    const client = await new TestClient(driver).connect('/backpressure');
    const server = accepted[0];
    expect(server).toBeDefined();
    if (server === undefined) {
      return;
    }

    const clientStream = await client.createBidirectionalStream();
    const serverStream = await receiveOne(server.incomingBidirectionalStreams);
    expect(serverStream).toBeDefined();
    if (serverStream === undefined) {
      return;
    }

    const writer = clientStream.writable.getWriter();
    await writer.write(new Uint8Array([1]));
    let secondSettled = false;
    const secondWrite = writer.write(new Uint8Array([2])).then(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(secondSettled).toBe(false);

    const reader = serverStream.readable.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    await secondWrite;
    expect(secondSettled).toBe(true);
    expect((await reader.read()).value).toEqual(new Uint8Array([2]));
    writer.releaseLock();
    reader.releaseLock();

    await clientStream.reset();
    await driver.stop();
  });

  it('drops the oldest datagram when the bounded queue overflows', async () => {
    const driver = new VirtualWebTransportDriver({
      datagramQueueSize: 2,
      datagramOverflow: 'drop-oldest',
    });
    const accepted: WebTransportSession[] = [];
    driver.onSession((session) => {
      accepted.push(session);
    });
    await driver.start({ port: 0 });
    const client = await new TestClient(driver).connect('/overflow');
    const server = accepted[0];
    expect(server).toBeDefined();
    if (server === undefined) {
      return;
    }

    await client.sendDatagram(new Uint8Array([1]));
    await client.sendDatagram(new Uint8Array([2]));
    await client.sendDatagram(new Uint8Array([3]));

    expect(await receiveOne(server.datagrams.readable)).toEqual(new Uint8Array([2]));
    expect(await receiveOne(server.datagrams.readable)).toEqual(new Uint8Array([3]));
    expect(driver.getStats().datagrams).toEqual({ received: 3, sent: 3, dropped: 1 });
    await driver.stop();
  });

  it('closes and aborts both endpoints deterministically', async () => {
    const driver = new VirtualWebTransportDriver();
    const accepted: WebTransportSession[] = [];
    driver.onSession((session) => {
      accepted.push(session);
    });
    await driver.start({ port: 0 });
    const testClient = new TestClient(driver);
    const client = await testClient.connect('/close');
    const server = accepted[0];
    expect(server).toBeDefined();
    if (server === undefined) {
      return;
    }

    const pendingIncoming = receiveOne(server.incomingBidirectionalStreams);
    await client.close({ closeCode: 42, reason: 'finished' });

    expect(await pendingIncoming).toBeUndefined();
    expect(client.signal.aborted).toBe(true);
    expect(server.signal.aborted).toBe(true);
    expect(client.state).toBe(WebTransportSessionState.CLOSED);
    expect(server.state).toBe(WebTransportSessionState.CLOSED);
    expect(await client.waitForClose()).toEqual({
      closeCode: 42,
      reason: 'finished',
      aborted: false,
    });
    expect(driver.getStats().sessions.active).toBe(0);

    const abortedClient = await testClient.connect('/abort');
    const abortedServer = accepted[1];
    expect(abortedServer).toBeDefined();
    if (abortedServer === undefined) {
      return;
    }
    const reader = abortedServer.datagrams.readable.getReader();
    const pendingDatagram = reader.read();
    const abort = new Error('test abort');
    await abortedClient.abort(abort);
    await expect(pendingDatagram).rejects.toBe(abort);
    expect(abortedClient.signal.reason).toBe(abort);
    expect(abortedServer.signal.reason).toBe(abort);
    reader.releaseLock();

    await driver.stop();
    expect(driver.getStats().state).toBe(WebTransportServerState.STOPPED);
  });

  it('rejects callback failures without leaking an active session', async () => {
    const driver = new VirtualWebTransportDriver();
    driver.onSession(() => {
      throw new Error('gateway failed');
    });
    await driver.start({ port: 0 });

    await expect(new TestClient(driver).connect('/rejected')).rejects.toBeInstanceOf(
      SessionRejectedError,
    );
    expect(driver.getStats().sessions).toEqual({ active: 0, total: 1, rejected: 1 });
    await driver.stop();
  });
});
