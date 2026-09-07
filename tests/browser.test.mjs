import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { createTransportFixture, waitFor } from './transport-fixture.mjs';

test('Chromium: certificate pinning, authentication, datagrams and both stream directions', {
  timeout: 45_000,
}, async () => {
  const http = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>WebTransport release verification</title>');
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const fixture = await createTransportFixture({ origin });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const result = await page.evaluate(
      async ({ url, hash }) => {
        const options = {
          serverCertificateHashes: [{ algorithm: 'sha-256', value: Uint8Array.from(hash) }],
        };
        const client = new WebTransport(url, options);
        await client.ready;
        const payload = new Uint8Array([1, 0, 255, 42]);
        const read = async (readable) => {
          const reader = readable.getReader();
          const bytes = [];
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) return bytes;
              bytes.push(...value);
            }
          } finally {
            reader.releaseLock();
          }
        };
        const writer = client.datagrams.writable.getWriter();
        const reader = client.datagrams.readable.getReader();
        await writer.write(payload);
        const datagram = Array.from((await reader.read()).value);
        writer.releaseLock();
        reader.releaseLock();
        const bidi = await client.createBidirectionalStream();
        const received = read(bidi.readable);
        const send = bidi.writable.getWriter();
        await send.write(payload);
        await send.close();
        const bidirectional = await received;
        const uni = await client.createUnidirectionalStream();
        const uniWriter = uni.getWriter();
        await uniWriter.write(payload);
        await uniWriter.close();
        const incoming = client.incomingUnidirectionalStreams.getReader();
        const unidirectional = await read((await incoming.read()).value);
        incoming.releaseLock();
        client.close();
        await client.closed;
        const invalid = new WebTransport(url.replace('test-only', 'invalid'), options);
        await invalid.ready;
        const denied = await invalid.closed;
        const badHash = new WebTransport(url, {
          serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(32) }],
        });
        void badHash.closed.catch(() => {});
        let certificateRejected = false;
        try {
          await badHash.ready;
        } catch {
          certificateRejected = true;
        }
        return {
          datagram,
          bidirectional,
          unidirectional,
          denied: denied.closeCode,
          certificateRejected,
        };
      },
      { url: fixture.url, hash: fixture.hash },
    );
    assert.deepEqual(result.datagram, [1, 0, 255, 42]);
    assert.deepEqual(result.bidirectional, result.datagram);
    assert.deepEqual(result.unidirectional, result.datagram);
    assert.notEqual(result.denied, 0);
    assert.equal(result.certificateRejected, true);
    await waitFor(() => fixture.driver.getStats().sessions.active === 0);
    assert.equal(fixture.driver.getStats().streams.active, 0);
  } finally {
    await browser.close();
    await fixture.close();
    await new Promise((resolve) => http.close(resolve));
  }
});
