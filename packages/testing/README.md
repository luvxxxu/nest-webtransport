# nest-webtransport-testing

Deterministic test doubles for WebTransport applications. The package depends only on
`webtransport-core`; it does not start a QUIC server and does not depend on NestJS.

```ts
import type { WebTransportSession } from 'webtransport-core';
import { TestClient, VirtualWebTransportDriver } from 'nest-webtransport-testing';

const driver = new VirtualWebTransportDriver();
let resolveServerSession!: (session: WebTransportSession) => void;
const nextServerSession = new Promise<WebTransportSession>((resolve) => {
  resolveServerSession = resolve;
});
driver.onSession((session) => {
  resolveServerSession(session);
});

await driver.start({ port: 0 });

const client = new TestClient(driver);
const session = await client.connect('/chat', { authorization: 'Bearer test' });
const serverSession = await nextServerSession;
await session.sendDatagram(new Uint8Array([1, 2, 3]));
const reader = serverSession.datagrams.readable.getReader();
const received = await reader.read();
reader.releaseLock();

expect(received.value).toEqual(new Uint8Array([1, 2, 3]));
await session.close();
```

Streams and datagrams use bounded Web Streams. Queue sizes and datagram overflow behavior are
configurable on `VirtualWebTransportDriver`, and closing or aborting either endpoint terminates both
sides deterministically once the returned promise settles.
