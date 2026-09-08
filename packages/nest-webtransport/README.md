# nest-webtransport

NestJS 12 integration for WebTransport: gateways, session/datagram/stream decorators, admission,
bounded scheduling, Nest guards/pipes/interceptors/filters and graceful shutdown.

```sh
npm install nest-webtransport @nestjs/common @nestjs/core reflect-metadata rxjs
```

`nest-webtransport` includes the native `rwebtransport` driver. Import both the Nest runtime and
`RWebTransportDriver` from this package; the driver package is installed transitively.

Requires ESM and Node.js 24.x or 26.x. Register decorated gateway classes as Nest providers and
configure `WebTransportModule.forRoot({driver, server, security})` or `forRootAsync(...)`.
Set an explicit Origin allowlist in both the module and native driver. Dynamic authentication runs
immediately after the established session is surfaced, not before HTTP/3 CONNECT acceptance.

`@OnSession()` initializes a session. `@OnDatagram()` receives a `Uint8Array` through `@Payload()`;
`@OnBidirectionalStream()` and `@OnUnidirectionalStream()` receive their stream through `@Stream()`.
Use `@Session()` for the connection and `@WebTransportContext()` for its principal, metadata and
abort signal. Propagate that signal to cancellable I/O. Named handlers need a routing resolver;
raw handlers require no envelope or codec.

For kinds with decorator handlers, the framework owns the incoming collection reader. The handler
owns the delivered stream's body. Do not acquire another reader on a framework-owned collection.

Full examples and API guidance:

- [Gateway setup](https://github.com/luvxxxu/nest-webtransport#gateway-example)
- [Architecture and ownership](https://github.com/luvxxxu/nest-webtransport/blob/main/docs/architecture.md)
- [Security model](https://github.com/luvxxxu/nest-webtransport/blob/main/docs/security.md)
- [Virtual testing](https://github.com/luvxxxu/nest-webtransport/blob/main/docs/testing.md)

MIT license.


v1 adds server-wide work, incoming-stream and queued-datagram-byte limits under `limits.server`.
The default session ceiling is 1,000; workload qualification is required before increasing it.
Inspect `WebTransportHealthService.getRuntimeStats()` for application-level rejections/drops and
work occupancy, alongside `getDriverStats()` for transport counters. Runtime logs default to
100 records/second; configure `observability.maxLogsPerSecond` and an optional private `onError` callback.
For manual or outgoing I/O, refresh idle activity with `context.touch?.()` after successful progress,
or set `security.idleTimeoutMs: 0` and implement application-owned idle cleanup.
