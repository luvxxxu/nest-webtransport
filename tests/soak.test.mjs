import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createTransportFixture, readAll, waitFor } from './transport-fixture.mjs';

const { WebTransport } = createRequire(
  new URL('../packages/driver-rwebtransport/package.json', import.meta.url),
)('rwebtransport');
const duration = Number(process.env.WEBTRANSPORT_SOAK_MS ?? 60_000);
assert.ok(Number.isSafeInteger(duration) && duration >= 1_000 && duration <= 3_600_000);

test('native load/soak: bounded resources through sustained traffic and abrupt disconnects', {
  timeout: duration + 30_000,
}, async () => {
  const fixture = await createTransportFixture();
  const payload = new Uint8Array(64 * 1024).fill(42);
  let rounds = 0;
  let baseline;
  const start = Date.now();
  let lastReport = start;
  try {
    do {
      await Promise.all(
        Array.from({ length: 10 }, async (_, index) => {
          const client = new WebTransport(fixture.url, {
            serverCertificateHashes: [
              { algorithm: 'sha-256', value: Uint8Array.from(fixture.hash) },
            ],
            origin: fixture.origin,
          });
          void client.closed.catch(() => {});
          try {
            await client.ready;
            const stream = await client.createBidirectionalStream();
            const received = readAll(stream.readable);
            void received.catch(() => {});
            const writer = stream.writable.getWriter();
            if (index === 0) {
              await writer.write(new Uint8Array([1]));
              client.close();
              await received.catch(() => {});
            } else {
              await writer.write(payload);
              await writer.close();
              assert.deepEqual(await received, payload);
            }
          } finally {
            client.close();
            await client.closed.catch(() => {});
          }
        }),
      );
      rounds++;
      await waitFor(
        () =>
          fixture.driver.getStats().sessions.active === 0 &&
          fixture.driver.getStats().streams.active === 0,
      );
      assert.equal(fixture.sessions.size, 0);
      assert.equal(fixture.health.ready, true);
      if (rounds === 5) {
        global.gc?.();
        baseline = process.memoryUsage();
      }
      if (Date.now() - lastReport >= 30_000) {
        console.log(
          JSON.stringify({
            elapsedMs: Date.now() - start,
            connections: rounds * 10,
            active: fixture.driver.getStats().sessions.active,
          }),
        );
        lastReport = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() - start < duration);
    global.gc?.();
    const final = process.memoryUsage();
    if (baseline && global.gc) {
      assert.ok(
        final.heapUsed - baseline.heapUsed < 20 * 1024 * 1024,
        'Retained JS heap grew by 20 MiB',
      );
      assert.ok(final.rss - baseline.rss < 128 * 1024 * 1024, 'Process RSS grew by 128 MiB');
    }
    console.log(
      JSON.stringify({
        durationMs: Date.now() - start,
        connections: rounds * 10,
        streams: fixture.driver.getStats().streams.total,
        heapGrowth: baseline ? final.heapUsed - baseline.heapUsed : null,
        rssGrowth: baseline ? final.rss - baseline.rss : null,
      }),
    );
  } finally {
    await fixture.close();
  }
});
