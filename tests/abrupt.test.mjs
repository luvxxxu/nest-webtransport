import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { createTransportFixture, waitFor } from './transport-fixture.mjs';

test('killed client: native idle timeout must not become an unhandled rejection', {
  timeout: 50_000,
}, async () => {
  const fixture = await createTransportFixture({ security: { idleTimeoutMs: 120_000 } });
  let client;
  try {
    client = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const {WebTransport} = await import(${JSON.stringify(new URL('../packages/driver-rwebtransport/vendor/rwebtransport.mjs', import.meta.url).href)});
      const client = new WebTransport(${JSON.stringify(fixture.url)}, {origin: ${JSON.stringify(fixture.origin)}, serverCertificateHashes: [{algorithm: 'sha-256', value: Uint8Array.from(${JSON.stringify(fixture.hash)})}]});
      await client.ready;
      console.log('ready');
      await client.closed;
    `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(client.stdout, 'data');
    await waitFor(() => fixture.sessions.size === 1);
    const exited = once(client, 'exit');
    client.kill('SIGKILL');
    await exited;
    await waitFor(() => fixture.driver.getStats().sessions.active === 0, 40_000);
    assert.equal(fixture.health.ready, true);
    assert.equal(fixture.driver.getStats().streams.active, 0);
  } finally {
    client?.kill('SIGKILL');
    await fixture.close();
  }
});
