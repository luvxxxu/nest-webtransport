# nest-webtransport-testing

영문 원문: [README.md](README.md)

WebTransport application을 위한 결정적인 test double입니다. 이 package는
`webtransport-core`에만 의존하며 QUIC server를 시작하지 않고 NestJS에도 의존하지 않습니다.

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

Stream과 datagram은 제한된 Web Stream을 사용합니다. Queue size와 datagram overflow 동작은
`VirtualWebTransportDriver`에서 구성할 수 있으며, 어느 endpoint를 닫거나 abort해도 반환된
Promise가 settle된 뒤 양쪽을 결정적으로 종료합니다.
