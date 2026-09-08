# nest-webtransport

A driver-based WebTransport framework for NestJS. It keeps Nest discovery and execution separate
from the HTTP/3/QUIC implementation, exposes Web Standard streams, and places explicit bounds on
framework-owned work queues.

Version `1.0.0-rc.1` is the v1 release candidate. It provides the core, Nest runtime, native driver, testing utilities and optional
OpenTelemetry integration. Release checks cover real native QUIC and Chromium communication,
admission/overload behavior, abrupt peer termination, sustained load, and clean package installation.
Production hardening and remaining qualification gates are tracked in [the v1 report](docs/v1-readiness.md).
See [release verification](docs/releasing.md) for the required checks and their scope.

## Packages

| Package | Responsibility |
| --- | --- |
| `webtransport-core` | Runtime-neutral driver, session, stream, datagram, lifecycle, limit, and error contracts |
| `nest-webtransport` | Dynamic module, gateway discovery, routing, Nest execution pipeline, limits, shutdown, health, and the native driver |
| `webtransport-driver-rwebtransport` | Node.js adapter for `rwebtransport` 0.2.2 and native HTTP/3/QUIC |
| `nest-webtransport-testing` | Deterministic virtual driver, paired sessions and streams, and an in-memory test client |
| `nest-webtransport-otel` | Optional OpenTelemetry driver metrics, handler metrics, and tracing |

The dependency direction is fixed:

```text
Nest application
  -> nest-webtransport
    -> webtransport-core
    -> webtransport-driver-rwebtransport -> rwebtransport -> HTTP/3 -> QUIC -> UDP

Tests
  -> nest-webtransport-testing
    -> webtransport-core
```

The Nest package re-exports the bundled native driver for a one-package installation, while custom
drivers can still be injected through the same core contract. Only the native driver imports
`rwebtransport`; core imports neither NestJS nor a concrete driver. Public transport contracts use
`Uint8Array`, `ReadableStream`, `WritableStream`, `Headers`, and `AbortSignal`.

## Implemented runtime

- `WebTransportModule.forRoot()` and `forRootAsync()` with injected drivers
- Bootstrap-time gateway discovery and a compiled handler registry
- Session, datagram, bidirectional-stream, and unidirectional-stream handlers
- Nest guards, pipes, interceptors, and exception filters for WebTransport handlers
- Bounded handler scheduling, bounded datagram queues, rate limits, session/stream limits, and
  idle/stream timeouts
- Session-scoped cancellation and handler/stream/session/server error isolation
- Drain-first shutdown and liveness/readiness snapshots through `WebTransportHealthService`
- Structured runtime logs and driver counters without logging headers, tokens, or payloads
- `rwebtransport` session, stream, datagram, error, stats, and keying-material adapters
- A virtual driver and client for integration tests without native QUIC
- Optional OpenTelemetry instruments and handler spans without an OTel dependency in core
- Basic and production examples; the production example includes JWT, Redis, Prometheus output,
  Docker, and Kubernetes manifests

Broker-backed cross-node messaging is not included. Qualify network fault behavior and workload
limits for each deployment; local release tests do not replace infrastructure-specific load testing.

## Installation

```sh
npm install nest-webtransport @nestjs/common @nestjs/core reflect-metadata rxjs
```

Use NestJS 12 with Node.js 24.x or 26.x. Add `nest-webtransport-testing` for virtual tests and
`nest-webtransport-otel` with `@opentelemetry/api` for telemetry. All packages use ESM.

## Gateway example

Handlers are raw and unnamed by default. This is the zero-protocol path: no event envelope or codec
is imposed on the bytes sent over WebTransport.

```ts
import { Module } from '@nestjs/common';
import {
  OnBidirectionalStream,
  OnDatagram,
  OnSession,
  Payload,
  Session,
  Stream,
  WebTransportGateway,
  WebTransportModule,
  RWebTransportDriver,
  type WebTransportBidirectionalStream,
  type WebTransportSession,
} from 'nest-webtransport';

@WebTransportGateway('/realtime')
class RealtimeGateway {
  @OnSession()
  onSession(@Session() session: WebTransportSession): void {
    // Initialize session-local state and return. After admission and session
    // handlers complete, the runtime starts pumps for registered handler kinds.
    console.info('connected', session.id);
  }

  @OnDatagram()
  onDatagram(@Payload() datagram: Uint8Array): void {
    // One Uint8Array is one unreliable datagram.
    console.info('datagram bytes', datagram.byteLength);
  }

  @OnBidirectionalStream()
  async onStream(@Stream() stream: WebTransportBidirectionalStream): Promise<void> {
    // The runtime accepts the stream; the gateway consumes its body.
    await stream.readable.pipeTo(stream.writable);
  }
}

@Module({
  imports: [
    WebTransportModule.forRoot({
      // The driver option is the static, pre-CONNECT Origin check. Keep it
      // aligned with the portable Nest admission policy below.
      driver: new RWebTransportDriver({
        allowedOrigins: ['https://app.example.com'],
      }),
      server: {
        host: '0.0.0.0',
        port: 4433,
        tls: {
          certificate: { kind: 'path', path: '/run/tls/tls.crt' },
          privateKey: { kind: 'path', path: '/run/tls/tls.key' },
        },
      },
      security: {
        requireOrigin: true,
        allowedOrigins: ['https://app.example.com'],
      },
    }),
  ],
  providers: [RealtimeGateway],
})
export class AppModule {}
```

Gateway classes must be registered as Nest providers. `@WebTransportGateway()` records metadata;
it does not add the class to the DI container.

### Named handlers require a resolver

WebTransport does not carry an application event name. A declaration such as
`@OnDatagram('position')` is selected only when a configured resolver returns the same route.

```ts
WebTransportModule.forRoot({
  driver,
  server,
  routing: {
    datagram(datagram) {
      if (datagram[0] === 1) {
        return {
          route: 'position',
          value: datagram,
          payload: datagram.subarray(1),
        };
      }

      return { value: datagram, payload: datagram };
    },
  },
});

@OnDatagram('position')
updatePosition(@Payload() payload: Uint8Array): void {
  // payload excludes the application-defined route byte in this example.
}
```

The framework intentionally does not define that first byte or any other envelope; it belongs to
the application protocol. Unnamed handlers are the fallback and also run alongside a matching
named handler.

## Stream ownership

For a gateway path, the Nest runtime takes ownership of a session-level incoming collection only
when at least one decorator handler of that kind is registered:

- any `@OnDatagram()` handler -> `session.datagrams.readable`
- any `@OnBidirectionalStream()` handler -> `session.incomingBidirectionalStreams`
- any `@OnUnidirectionalStream()` handler -> `session.incomingUnidirectionalStreams`

When a handler of that kind exists—named or unnamed—do not call `getReader()` on its collection in
gateway code. Receive the selected value through `@Payload()` or `@Stream()` instead. If the path
has no handler at all for a kind, the runtime leaves that collection untouched and an `@OnSession()`
workflow may consume it manually. After successful manual or outgoing I/O, call `context.touch?.()`
to refresh the framework idle deadline, or set `security.idleTimeoutMs: 0` and own idle cleanup. Once a stream object reaches a stream handler, its own
`stream.readable` belongs to application code and preserves Web Stream backpressure.

## Runtime requirements

- Bun 1.3.12 is the repository package manager and script runner. Published packages are not
  Bun-runtime packages.
- Node.js 24.x or 26.x is required by the native `rwebtransport` 0.2.2 driver.
- TypeScript is configured for strict NodeNext ESM and Web Platform types.

`rwebtransport` 0.2.2 has no dynamic pre-CONNECT authentication hook. Its static
`allowedOrigins` driver option is the only application admission check available before CONNECT;
Nest header checks, resource limits, and `authenticate()` run as soon as the established session is
surfaced and reject it by closing the session. See the [security model](docs/security.md) for the
configuration boundary.

```bash
bun install
bun run check
```

## Documentation

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Testing without QUIC](docs/testing.md)
- [Release checks and publication](docs/releasing.md)
- [Production example](examples/production/README.md)
- [Browser WebTransport demo](examples/web-demo/README.md)

The security and release boundaries are part of the API contract. Read them before exposing a
server to untrusted traffic.

## License

MIT. The native driver includes an audited Apache-2.0 compatibility bundle for `rwebtransport`
0.2.2; its license and notices are shipped with the package. The dependency supplies the native
binary and retains its upstream third-party notices.
