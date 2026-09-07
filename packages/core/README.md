# webtransport-core

Runtime-neutral WebTransport contracts for drivers and framework integrations. This package does
not depend on NestJS, Node-specific stream types, or a concrete QUIC implementation.

The root export includes:

- driver capabilities, startup options, statistics, and session callbacks;
- session, bidirectional stream, unidirectional stream, and datagram contracts based on Web
  `ReadableStream`, `WritableStream`, `Uint8Array`, `Headers`, and `AbortSignal`;
- scoped errors for handler, stream, session, server, and fatal failures;
- server/session lifecycle states and resource-limit configuration types;
- bounded queue, concurrency, and fixed-window rate-limit primitives;
- a transport-independent codec interface and a zero-copy raw codec.

`BoundedQueue` never grows beyond its configured capacity. On overflow it returns an explicit
decision (`drop-oldest`, `drop-newest`, `reject`, or `close-session`) so the caller owns the policy
effect. `ConcurrencyLimiter` and `FixedWindowRateLimiter` reject excess work without creating a
waiter queue.

Named events and payload framing intentionally do not belong here. A Nest integration or
application-level routing SPI may decode a raw datagram or associate a stream with a route without
making that protocol mandatory for drivers.
