import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebTransport } from '../packages/driver-rwebtransport/vendor/rwebtransport.mjs';
import { createTransportFixture, readAll, waitFor } from './transport-fixture.mjs';

async function connect(fixture, url = fixture.url, origin = fixture.origin) {
  const client = new WebTransport(url, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: Uint8Array.from(fixture.hash) }],
    origin,
  });
  void client.closed.catch(() => {});
  await client.ready;
  return client;
}

test('native QUIC: all channels, stream reset, stats and shutdown', {
  timeout: 20_000,
}, async () => {
  const fixture = await createTransportFixture();
  try {
    const client = await connect(fixture);
    await waitFor(() => fixture.sessions.size === 1);
    const payload = Uint8Array.from([0, 255, 7, 42]);
    const writer = client.datagrams.writable.getWriter();
    const reader = client.datagrams.readable.getReader();
    await writer.write(payload);
    assert.deepEqual(Uint8Array.from((await reader.read()).value), payload);
    writer.releaseLock();
    reader.releaseLock();
    const bidi = await client.createBidirectionalStream();
    const received = readAll(bidi.readable);
    const send = bidi.writable.getWriter();
    await send.write(payload);
    await send.close();
    assert.deepEqual(await received, payload);
    const uni = await client.createUnidirectionalStream();
    const uniWriter = uni.getWriter();
    await uniWriter.write(payload);
    await uniWriter.close();
    const incoming = client.incomingUnidirectionalStreams.getReader();
    assert.deepEqual(await readAll((await incoming.read()).value), payload);
    incoming.releaseLock();
    const reset = await client.createBidirectionalStream();
    await reset.readable.cancel();
    await reset.writable.abort();
    client.close();
    await client.closed;
    await waitFor(() => fixture.driver.getStats().sessions.active === 0);
    assert.equal(fixture.driver.getStats().streams.active, 0);
    assert.equal(fixture.health.ready, true);
  } finally {
    await fixture.close();
  }
  assert.equal(fixture.health.ready, false);
  assert.equal(fixture.driver.getStats().state, 'STOPPED');
});

test('native QUIC: rejects origin, invalid authentication and unknown routes', {
  timeout: 20_000,
}, async () => {
  const fixture = await createTransportFixture();
  try {
    await assert.rejects(connect(fixture, fixture.url, 'https://untrusted.invalid'));
    for (const url of [
      fixture.url.replace('test-only', 'invalid'),
      fixture.url.replace('/echo', '/missing'),
    ]) {
      const client = await connect(fixture, url);
      const closed = await client.closed;
      assert.notEqual(closed.closeCode, 0);
    }
    await waitFor(() => fixture.sessions.size === 0);
  } finally {
    await fixture.close();
  }
});

test('native QUIC: repeated connection churn releases sessions and streams', {
  timeout: 60_000,
}, async () => {
  const fixture = await createTransportFixture();
  try {
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(
        Array.from({ length: 5 }, async () => {
          const client = await connect(fixture);
          const stream = await client.createBidirectionalStream();
          const received = readAll(stream.readable);
          const writer = stream.writable.getWriter();
          await writer.write(new Uint8Array([batch]));
          await writer.close();
          assert.deepEqual(await received, new Uint8Array([batch]));
          client.close();
          await client.closed;
        }),
      );
      await waitFor(() => fixture.driver.getStats().sessions.active === 0);
      assert.equal(fixture.driver.getStats().streams.active, 0);
    }
  } finally {
    await fixture.close();
  }
});

test('native QUIC: stream flood cannot accumulate unbounded incoming objects behind a blocked handler', {
  timeout: 15_000,
}, async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await createTransportFixture({
    execution: { maxPendingHandlers: 0 },
    onUni: () => held,
  });
  let client;
  try {
    client = await connect(fixture);
    let closed = false;
    void client.closed.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      },
    );
    for (let i = 0; i < 1_000 && !closed; i++) {
      try {
        const stream = await client.createUnidirectionalStream();
        const writer = stream.getWriter();
        await writer.write(new Uint8Array([1]));
        await writer.close();
      } catch {
        break;
      }
    }
    await waitFor(() => closed, 2_000);
    assert.equal(fixture.health.ready, true);
  } finally {
    release();
    client?.close();
    await fixture.close();
  }
});

test('native QUIC: new streams during drain do not interrupt an active stream', {
  timeout: 15_000,
}, async () => {
  let started;
  const active = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let completed = false;
  const fixture = await createTransportFixture({
    onUni: async (session, stream) => {
      const payload = await readAll(stream.readable);
      started();
      await held;
      const outgoing = await session.createUnidirectionalStream();
      const writer = outgoing.writable.getWriter();
      await writer.write(payload);
      await writer.close();
      writer.releaseLock();
      completed = true;
    },
  });
  let client;
  let closing;
  try {
    client = await connect(fixture);
    const initial = await client.createUnidirectionalStream();
    const writer = initial.getWriter();
    await writer.write(new Uint8Array([7, 8, 9]));
    await writer.close();
    writer.releaseLock();
    await active;
    const incoming = client.incomingUnidirectionalStreams.getReader();
    const echoed = incoming.read().then(({ value }) => readAll(value));
    closing = fixture.module.close();
    let peerClosed = false;
    void client.closed.then(
      () => {
        peerClosed = true;
      },
      () => {
        peerClosed = true;
      },
    );
    await waitFor(() => fixture.health.lifecycle.state === 'DRAINING');
    await client.draining;
    assert.equal(peerClosed, false);
    assert.equal(completed, false);
    for (let i = 0; i < 3; i++) {
      const late = await client.createUnidirectionalStream();
      const lateWriter = late.getWriter();
      await lateWriter.write(new Uint8Array([1])).catch(() => {});
      await lateWriter.close().catch(() => {});
      lateWriter.releaseLock();
    }
    release();
    assert.deepEqual(await echoed, new Uint8Array([7, 8, 9]));
    assert.equal(completed, true);
    incoming.releaseLock();
    assert.equal((await client.closed).closeCode, 0);
    await closing;
  } finally {
    release();
    client?.close();
    await closing;
    await fixture.close();
  }
});
