# QUIC 없이 테스트하기

영문 원문: [testing.md](testing.md)

`nest-webtransport-testing`은 core driver 및 session 계약을 전부 메모리에서 구현합니다.
Native socket이 필요하지 않은 gateway discovery, routing, pipe/guard/interceptor, limit,
stream flow, shutdown, application protocol 테스트를 위한 패키지입니다.

`webtransport-core`에 의존하며 NestJS에는 의존하지 않습니다. 애플리케이션 테스트가 Nest
testing module을 생성하기로 선택한 경우에만 Nest가 필요합니다.

## Driver 수준 테스트

```ts
import type { WebTransportSession } from 'webtransport-core';
import {
  TestClient,
  VirtualWebTransportDriver,
} from 'nest-webtransport-testing';

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
const session = await client.connect('/chat', {
  origin: 'https://app.example.test',
  authorization: 'Bearer test-only-token',
});
const serverSession = await nextServerSession;

const incoming = serverSession.datagrams.readable.getReader();
await session.sendDatagram(new Uint8Array([1, 2, 3]));
const received = await incoming.read();
incoming.releaseLock();

expect(received.value).toEqual(new Uint8Array([1, 2, 3]));

await session.close({ closeCode: 0, reason: 'test complete' });
await driver.stop();
```

`connect(path, headers)`는 등록된 driver callback이 반환된 뒤 resolve됩니다. Driver만
테스트하는 경우 `onSession` callback에서 client traffic을 기다리지 마세요. 해당 traffic은
`connect()`가 resolve된 뒤에만 보낼 수 있습니다. Session을 저장하거나 detached task를
시작한 뒤 반환하세요.

가상 연결은 모든 byte payload를 복사합니다. Write 후 호출자가 가진 `Uint8Array`를 변경해도
peer가 관찰하는 값은 바뀌지 않습니다.

## Nest 통합 테스트

가상 driver는 완전한 Nest runtime을 부트할 수 있습니다. `moduleRef.init()`은 애플리케이션
bootstrap hook을 실행하고 driver를 시작하므로 필수입니다.

```ts
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  OnDatagram,
  Payload,
  WebTransportGateway,
  WebTransportModule,
} from 'nest-webtransport';
import {
  TestClient,
  VirtualWebTransportDriver,
} from 'nest-webtransport-testing';

@WebTransportGateway('/events')
class EventsGateway {
  private resolveDatagram!: (value: Uint8Array) => void;

  readonly nextDatagram = new Promise<Uint8Array>((resolve) => {
    this.resolveDatagram = resolve;
  });

  @OnDatagram()
  receive(@Payload() datagram: Uint8Array): void {
    this.resolveDatagram(datagram);
  }
}

const driver = new VirtualWebTransportDriver();

@Module({
  imports: [
    WebTransportModule.forRoot({
      driver,
      server: { port: 0 },
      security: {
        requireOrigin: true,
        allowedOrigins: ['https://app.example.test'],
      },
    }),
  ],
  providers: [EventsGateway],
})
class TestAppModule {}

const moduleRef = await Test.createTestingModule({
  imports: [TestAppModule],
}).compile();
await moduleRef.init();

const gateway = moduleRef.get(EventsGateway);
const client = new TestClient(driver);
const session = await client.connect('/events', {
  origin: 'https://app.example.test',
});

await session.sendDatagram(new Uint8Array([7, 8, 9]));
await expect(gateway.nextDatagram).resolves.toEqual(new Uint8Array([7, 8, 9]));

await session.close();
await moduleRef.close();
```

이 경로는 실제 gateway discovery, metadata compilation, admission, scheduling, Nest execution
pipeline을 실행합니다. 같은 패턴으로 guard, pipe, interceptor, filter, route resolver,
session principal을 테스트하세요.

## 양방향 stream

Client가 생성한 stream은 server session의 incoming collection에 나타납니다.

```ts
const incomingBidi = serverSession.incomingBidirectionalStreams.getReader();
const clientStream = await clientSession.createBidirectionalStream();
const { value: serverStream } = await incomingBidi.read();
incomingBidi.releaseLock();

const writer = clientStream.writable.getWriter();
await writer.write(new Uint8Array([1]));
writer.releaseLock();

const reader = serverStream.readable.getReader();
expect((await reader.read()).value).toEqual(new Uint8Array([1]));
reader.releaseLock();
```

Server가 생성한 stream은 `TestClientSession` convenience method로 노출됩니다.

```ts
const serverSend = await serverSession.createUnidirectionalStream();
const clientReceive = await clientSession.receiveUnidirectionalStream();

const writer = serverSend.writable.getWriter();
await writer.write(new Uint8Array([2, 3]));
await writer.close();

const reader = clientReceive?.readable.getReader();
expect((await reader?.read())?.value).toEqual(new Uint8Array([2, 3]));
reader?.releaseLock();
```

사용할 수 있는 client helper는 다음과 같습니다.

- `sendDatagram()` 및 `receiveDatagram()`
- `createBidirectionalStream()` 및 `createUnidirectionalStream()`
- `receiveBidirectionalStream()` 및 `receiveUnidirectionalStream()`
- `close()`, `abort()`, `waitForClose()`

Nest test에서 gateway path에 해당 종류의 decorator handler가 하나라도 있으면 server
collection을 직접 읽지 마세요. 런타임이 reader를 소유하고 `@Payload()`와 `@Stream()`으로
값을 전달합니다. 해당 종류의 handler가 없으면 런타임이 collection을 건드리지 않으므로
`@OnSession()` 구현이 수동으로 소비할 수 있습니다. 위의 직접 읽기는 driver 수준 예제입니다.

## 상한 및 overflow 테스트

가상 애플리케이션 소유 queue에는 명시적인 크기가 있습니다.

```ts
const driver = new VirtualWebTransportDriver({
  maxSessions: 4,
  incomingStreamQueueSize: 2,
  streamQueueSize: 2,
  streamMaxChunkSize: 16 * 1024,
  datagramQueueSize: 3,
  maxDatagramSize: 1_200,
  datagramOverflow: 'drop-oldest',
});
```

`streamQueueSize`는 메모리 안에서 각 byte direction에 buffer로 둘 chunk 수를 제어합니다.
경계가 가득 차면 write가 대기하고 peer가 읽을 때 재개됩니다. `streamMaxChunkSize`는 하나의
chunk가 memory bound를 우회하지 못하게 합니다.

Datagram policy는 `drop-oldest`, `drop-newest`, `reject`, `close-session`입니다. Queue 크기가
2이고 `drop-oldest`이면 peer가 읽기 전에 1, 2, 3을 보내면 2, 3이 생성되고 driver의 dropped
counter가 증가합니다.

`driver.getStats()`를 사용하여 active/total/rejected session, active/total stream, datagram
count, byte count, lifecycle state를 단언하세요. 안정적인 `capturedAt` 값이 필요하면
`now: () => fixedTime`을 주입합니다.

## Close와 abort semantics

어느 endpoint를 닫아도 연결된 session이 닫히고, 양쪽 session signal이 abort되며, active
stream이 종료되고, `waitForClose()`가 resolve되며, driver의 active-session count가 해제됩니다.
Graceful close는 pending incoming-collection read를 `done: true`로 끝냅니다.

`abort(reason)`은 제공된 reason을 양쪽 session signal에 보존하고 pending read에서 오류를
발생시킵니다. 따라서 timer 없이 disconnect와 failure를 결정적으로 단언할 수 있습니다.

```ts
const pending = clientSession.receiveDatagram();
const failure = new Error('simulated disconnect');

await clientSession.abort(failure);
await expect(pending).rejects.toBe(failure);
expect(clientSession.signal.reason).toBe(failure);
```

## 가상 driver가 증명하지 않는 것

가상 전송은 framework와 application 동작을 증명하지만 native network path는 검증하지 않습니다.
다음은 실행하지 않습니다.

- QUIC handshake, TLS validation, certificate hash, HTTP/3 CONNECT response
- UDP loss, jitter, reordering, MTU discovery, congestion control, NAT 동작
- native memory, file descriptor, socket cleanup, addon compatibility
- browser WebTransport 동작

Virtual integration test는 빠른 검사 묶음으로 유지하세요. `bun run release:check`는 native
QUIC, Chromium, killed-client 회귀, load/soak, 독립 package installation도 실행합니다.
사전 조건과 테스트 경계는 [릴리스 절차](releasing.ko.md)를 참고하세요.

저장소 검사:

```bash
bun run lint
bun run typecheck
bun run test
bun run pack:check
```
