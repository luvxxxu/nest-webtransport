# Architecture

`nest-webtransport` is a transport framework with a replaceable driver boundary. The Nest runtime
does not wrap a concrete QUIC library directly, and the core contracts do not know about NestJS.

## Dependency boundary

```text
Nest application
        │
        ▼
nest-webtransport
  discovery · routing · execution · lifecycle
        │
        ├──────────────▶ webtransport-core ◀──────── custom driver contract
        │
        └──────────────▶ webtransport-driver-rwebtransport
                                      │
                                      ▼
                    rwebtransport · HTTP/3 · QUIC · UDP

nest-webtransport-testing ──▶ webtransport-core
```

The dependency rules are mechanical:

1. `webtransport-core` imports neither NestJS nor `rwebtransport`.
2. `nest-webtransport` imports core and re-exports the native driver as its default installation
   path; applications may inject any driver that implements the core contract.
3. Only `webtransport-driver-rwebtransport` imports `rwebtransport`.
4. The testing package imports core and remains usable without NestJS or native QUIC.

Core public contracts use Web Platform values: `Uint8Array`, `ReadableStream`, `WritableStream`,
`Headers`, `AbortSignal`, and `DOMException`. Node streams, `Buffer`, and `EventEmitter` are not part
of the public transport API.

## Package responsibilities

### Core

`webtransport-core` defines:

- `WebTransportDriver`, capabilities, server options, stop options, and stats
- session state, session context, close options, and optional TLS keying-material export
- bidirectional, send-only, receive-only, and datagram contracts
- scoped errors for handler, stream, session, server, and fatal failures
- server lifecycle transitions and liveness/readiness snapshots
- bounded queues, concurrency limiting, fixed-window rate limiting, and resource-limit types
- the opt-in codec interface plus `rawWebTransportCodec`

Core contains no network implementation. Its utilities are also used to make framework-owned
queues explicit and bounded.

### Nest integration

`nest-webtransport` owns the dynamic module, metadata decorators, bootstrap discovery,
compiled handler registry, execution pipeline, runtime pumps, resource policy, shutdown, structured
logging, and health reporting. Internal registry and dispatcher classes are not public exports.

### Native driver

`webtransport-driver-rwebtransport` maps `rwebtransport` 0.2.2 server sessions to core
contracts. It supplies framework session IDs, state and abort signals, `bigint` stream IDs, error
mapping, counters, connection-stat snapshots, keying-material export, and graceful drain calls.

### Testing

`nest-webtransport-testing` provides the same driver/session/stream shape in memory. Its
paired endpoints use bounded Web Streams and deterministic close/abort behavior, allowing most
framework tests to run without TLS, UDP, or a native addon.

## Bootstrap and session admission

```text
Nest module initialization
        │
        ├─ discover providers with @WebTransportGateway
        ├─ scan method and parameter metadata once
        └─ compile GatewayRegistry
                │
application bootstrap
        │
        ├─ subscribe to driver sessions
        ├─ start driver
        └─ state = RUNNING
                │
driver surfaces a session
        │
        ├─ lifecycle and gateway-path check
        ├─ global/header/origin validation
        ├─ per-IP admission and rate limit
        ├─ create SessionContext
        ├─ authenticate()
        ├─ run @OnSession handlers
        └─ start pumps only for registered handler kinds
```

Gateway decorators only record metadata. A gateway must still be present in the Nest providers
graph so `DiscoveryService` can find its instantiated class.

Admission and `@OnSession()` share the configured handshake timeout. A session handler should
initialize state and return; it must not wait for a future datagram or incoming stream because the
runtime starts those pumps after admission succeeds.

## Routing is protocol-neutral

The transport supplies a gateway path, raw datagrams, and streams. It does not supply application
event names.

The default dispatch path is therefore unnamed:

```ts
@OnDatagram()
handleDatagram(@Payload() bytes: Uint8Array) {}

@OnBidirectionalStream()
handleStream(@Stream() stream: WebTransportBidirectionalStream) {}
```

Without a resolver, the runtime sets the payload to the raw datagram or stream and looks up only
the unnamed handler. Named decorators become active when an application-provided resolver returns
a route:

```text
raw value
   │
   ▼
routing.datagram / bidirectionalStream / unidirectionalStream
   │
   ├─ route   -> named registry key
   ├─ value   -> @Stream or underlying datagram value
   └─ payload -> @Payload
```

An unnamed handler is a fallback and is included with a matching named handler. This lets an
application add protocol-specific routes without losing a catch-all observer. The framework does
not prescribe JSON, a leading route byte, MessagePack, CBOR, Protobuf, or any other envelope.

A named decorator still counts as a handler of its kind, so it causes the runtime to own and pump
that incoming collection. Without a resolver, however, no route name can match it. An unmatched
datagram has no invocation target; an unmatched bidirectional or unidirectional stream is reset or
stopped immediately with the framework's no-route code.

A stream resolver that consumes bytes to discover a route must return a replacement stream/value
that preserves the remaining body. Reading a stream is destructive and locks its readable side;
route framing is consequently an application-protocol responsibility.

## Readable ownership and backpressure

WHATWG `ReadableStream` has one active reader. Reader ownership is selected independently for each
incoming kind on each gateway path:

```text
at least one @OnDatagram handler
  -> runtime owns session.datagrams.readable
  -> @Payload()

at least one @OnBidirectionalStream handler
  -> runtime owns session.incomingBidirectionalStreams
  -> @Stream() / @Payload()

at least one @OnUnidirectionalStream handler
  -> runtime owns session.incomingUnidirectionalStreams
  -> @Stream() / @Payload()
```

Once a handler of a kind exists—named or unnamed—gateway code must not acquire a reader for that
collection. If a path has no handler of that kind, the runtime does not start its pump or acquire its
reader; application code may then implement a fully manual protocol from `@OnSession()`. Once the
runtime passes an individual stream to a handler, the handler owns that stream body's `readable` and
may pipe or read it normally.

Reliable-stream pressure remains in the Web Stream chain:

```text
application reads slowly
  -> ReadableStream demand falls
  -> driver pauses native reads
  -> QUIC flow control slows the peer
```

Datagrams cannot provide reliable backpressure. They enter a bounded queue and use one of
`drop-oldest`, `drop-newest`, `reject`, or `close-session`. The default is a 256-item queue with
`drop-oldest` overflow.

## Execution pipeline and bounds

Each compiled handler uses the familiar Nest order:

```text
ExecutionContext
  -> guards
  -> interceptors before
  -> global/class/method/parameter pipes
  -> handler
  -> interceptors after
  -> exception filters on failure
```

`WebTransportExecutionContext.getType()` returns `webtransport`. Guards and interceptors can call
`switchToWebTransport(context)` to obtain the session, stream, datagram, resolved payload, and
`SessionContext` without modifying Nest core.

The runtime never creates one unbounded Promise per packet. A bounded scheduler caps running and
pending handlers. Stream pumps wait for scheduler capacity before accepting another stream;
datagrams use their own bounded queue before scheduling. Overflow can drop/reject work or close the
session according to configuration.

Default limits are:

| Boundary | Default |
| --- | ---: |
| Global active sessions (including retained unfinished work) | 1,000 |
| Global concurrent work, including authentication | 256 |
| Additional global queued work | 1,024 |
| Global active managed incoming streams | 2,048 |
| Global retained datagram bytes | 16 MiB |
| Active sessions per IP | 100 |
| Session attempts per IP per second | 10 |
| Bidirectional streams per session | 100 |
| Unidirectional streams per session | 100 |
| Datagrams per session per second | 1,000 |
| Concurrent handlers per session | 64 |
| Pending handlers per session | 128 |
| Stream lifetime | 300 seconds |
| Datagram queue | 256 |

Datagram bytes remain charged while a packet is queued or a handler/resolver is running. Aggregate work
reservations cover admission and both local and global queues. Non-cooperative disconnected work keeps
its reservation until it settles. Global work overflow uses `execution.overflow`; the global byte
ceiling drops the arriving datagram (a fitting `drop-oldest` replacement is still allowed).

These are framework defaults, not a promise that the selected driver or host supports the same
ceiling. A lower native or deployment limit wins.

## Failure isolation

Core errors carry `code`, `cause`, `recoverable`, and `scope`. The runtime handles their scope at the
smallest boundary it can:

| Scope | Runtime action |
| --- | --- |
| `HANDLER` | End the failed invocation |
| `STREAM` | Reset or stop that stream |
| `SESSION` | Close that session |
| `SERVER` | Stop the runtime |
| `FATAL` | Stop the runtime |

Unknown application errors are logged and isolated to the current handler. Background pumps attach
their own rejection handling so a stream or session failure does not become an unhandled process
rejection.

## Lifecycle, shutdown, and health

```text
STARTING -> RUNNING -> DRAINING -> STOPPING -> STOPPED
```

During graceful shutdown the Nest runtime stops accepting sessions, waits for scheduled handlers up
to `drainTimeoutMs`, closes active sessions, and stops the driver within `forceCloseTimeoutMs`. The
native driver also sends drain signals and waits for its sessions until its stop timeout before
forcing closure.

`WebTransportHealthService` exposes two distinct answers:

- `alive`: the process/runtime lifecycle is alive.
- `ready`: the runtime is `RUNNING` and accepting new sessions.

`DRAINING` is alive but not ready, matching the expected Kubernetes probe semantics.

## Security boundary

The runtime validates origin, aggregate header size, application authentication, global/per-IP
session limits, datagram size/rate, handler capacity, stream count/lifetime, and idle time. These
checks fail closed by closing the affected session or stream.

There is an important native timing boundary. `rwebtransport` 0.2.2 has no dynamic pre-CONNECT
authentication callback. Its only handshake-time application admission mechanism is a static
`allowedOrigins` list. Portable Nest `security.authenticate`, header checks, and resource-limit
checks run as soon as the native driver surfaces the established session; rejection at that stage is
an immediate session close, not an HTTP/3 CONNECT denial. Configure the handshake list on
`RWebTransportDriver` itself and keep it aligned with the separate Nest Origin policy. See
[security.md](security.md).

## Observability

The implemented baseline consists of:

- structured runtime records (`event`, timestamp, session/stream identifiers, safe error code)
- aggregate driver session, stream, datagram, and byte counters
- best-effort per-connection native stats
- health snapshots for liveness and readiness

The runtime does not log authorization headers, cookies, raw tokens, or payloads. The optional
`nest-webtransport-otel` is an optional leaf package. It observes the public driver stats and
registers a WebTransport-only Nest interceptor for handler duration, errors, and spans. The core
and driver contracts do not import OpenTelemetry.

## Runtime and release boundary

Bun 1.3.12 manages dependencies and repository scripts. Production execution of the native driver
uses Node.js 24.x or 26.x, matching the `rwebtransport` 0.2.2 binary/runtime matrix; this is not a
Bun-native server.

The v1 release-candidate gate includes unit/virtual integration, actual native client/server QUIC with
certificate pinning, Chromium E2E, overload and stream-flood rejection, a killed-client native
idle-timeout regression, sustained load with resource/memory checks, and clean npm tarball
installation. The pinned driver includes a reproducibly patched upstream JavaScript bundle for
session rejection cleanup and incoming queue bounds; native QUIC/TLS code is unchanged.

See [releasing](releasing.md) and the [release report](release-report.md) for commands and measured
results. Tests on one host do not establish a full platform matrix. Release CI runs the native and
browser gates on Linux x64 and macOS arm64 with Node 24 and 26; the existing unit/build CI also
covers Linux arm64 and Windows x64.

Before advertising a `1.0.0` API or a particular production deployment, additionally qualify:

- the exact target OS/architecture and deployment's Docker/Kubernetes configuration;
- network loss, latency, jitter, reordering, MTU and NAT behavior under the expected workload;
- a 24–72 hour soak and file-descriptor/native memory behavior at the target scale;
- application-specific authentication, outbound work bounds and SemVer/API commitments.


## v1 operation changes

`SessionContext.touch()` refreshes the idle deadline for successful manually consumed/outgoing I/O.
The framework idle timer can be disabled explicitly with `security.idleTimeoutMs: 0`. Decorator-managed
streams suspend idle expiration while active, but retain their independent lifetime limit. Manual and
outgoing streams need application-owned concurrency, drain, and lifetime management.

`WebTransportHealthService.getRuntimeStats()` reports runtime admission and drop reasons separately
from native transport counters. Runtime logs default to at most 100 records per second, with a
suppression counter; `observability.maxLogsPerSecond` configures both this ceiling and the maximum
number of records with unfinished asynchronous callbacks. Rejected callback Promises are isolated. An optional
`observability.onError(error, record)` callback receives private diagnostics under the same log budget.
Keep callbacks nonblocking and redact error details before exporting them. OTel discovers these
runtime metrics automatically when its Nest module is present alongside the runtime.

Health is unhealthy when a running runtime's driver leaves RUNNING, including a stuck STOPPING state.
Normal runtime DRAINING remains live and unready. Drivers can expose the optional `session.drain()`
notification; the runtime calls it before stopping intake. Cancelled incoming collections refuse new streams
without closing sessions that still have active streams to finish.
