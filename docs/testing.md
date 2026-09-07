# Testing without QUIC

`nest-webtransport-testing` implements the core driver and session contracts entirely in
memory. It is intended for gateway discovery, routing, pipes/guards/interceptors, limits, stream
flow, shutdown, and application-protocol tests that do not need a native socket.

It depends on `webtransport-core`, not NestJS. Nest is needed only when the application test
chooses to create a Nest testing module.

## Driver-level test

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

`connect(path, headers)` resolves after registered driver callbacks return. In a driver-only test,
do not make an `onSession` callback wait for client traffic that can be sent only after `connect()`
resolves. Capture the session or start a detached task and return.

The virtual connection copies each byte payload. Mutating the caller's `Uint8Array` after a write
does not mutate the value observed by the peer.

## Nest integration test

The virtual driver can boot the complete Nest runtime. `moduleRef.init()` is required because it
runs application bootstrap hooks and starts the driver.

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

This path exercises actual gateway discovery, metadata compilation, admission, scheduling, and the
Nest execution pipeline. Use the same pattern to test guards, pipes, interceptors, filters, route
resolvers, and session principals.

## Streams in both directions

Client-created streams appear on the server session's incoming collection:

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

Server-created streams are exposed through `TestClientSession` convenience methods:

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

Available client helpers are:

- `sendDatagram()` and `receiveDatagram()`
- `createBidirectionalStream()` and `createUnidirectionalStream()`
- `receiveBidirectionalStream()` and `receiveUnidirectionalStream()`
- `close()`, `abort()`, and `waitForClose()`

In a Nest test, do not read a server collection yourself when the gateway path has any decorator
handler of that kind. The runtime owns that reader and delivers values to `@Payload()` and
`@Stream()`. If the path has no handler for that kind, the runtime leaves the collection untouched,
so an `@OnSession()` implementation may consume it manually. The direct reads above are
driver-level examples.

## Bounds and overflow tests

Every virtual application-owned queue has an explicit size:

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

`streamQueueSize` controls the number of chunks buffered by each in-memory byte direction. A write
waits when that boundary is full and resumes when the peer reads. `streamMaxChunkSize` prevents a
single chunk from bypassing the memory bound.

Datagram policies are `drop-oldest`, `drop-newest`, `reject`, and `close-session`. With a queue size
of two and `drop-oldest`, sending values `1`, `2`, then `3` before the peer reads produces `2`, `3`
and increments the driver's dropped counter.

Use `driver.getStats()` to assert active/total/rejected sessions, active/total streams, datagram
counts, byte counts, and lifecycle state. Inject `now: () => fixedTime` when a stable `capturedAt`
value is useful.

## Close and abort semantics

Closing either endpoint closes the paired session, aborts both session signals, terminates active
streams, resolves `waitForClose()`, and releases the driver's active-session count. A graceful close
ends pending incoming-collection reads with `done: true`.

`abort(reason)` preserves the supplied reason on both session signals and errors pending reads. This
makes disconnect and failure assertions deterministic without timers:

```ts
const pending = clientSession.receiveDatagram();
const failure = new Error('simulated disconnect');

await clientSession.abort(failure);
await expect(pending).rejects.toBe(failure);
expect(clientSession.signal.reason).toBe(failure);
```

## What the virtual driver does not prove

The virtual transport proves framework and application behavior, not the native network path. It
does not exercise:

- QUIC handshake, TLS validation, certificate hashes, or HTTP/3 CONNECT responses;
- UDP loss, jitter, reordering, MTU discovery, congestion control, or NAT behavior;
- native memory, file descriptors, socket cleanup, or addon compatibility;
- browser WebTransport behavior.

Keep virtual integration tests as the fast suite. `bun run release:check` also runs native QUIC,
Chromium, a killed-client regression, load/soak and isolated package installation checks. See
[releasing](releasing.md) for prerequisites and test boundaries.

Repository checks:

```bash
bun run lint
bun run typecheck
bun run test
bun run pack:check
```
