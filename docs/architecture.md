# Architecture

`nest-webtransport` is a transport abstraction framework, not a direct NestJS wrapper around one
QUIC implementation.

## Dependency boundary

```text
NestJS
  -> nest-webtransport
    -> webtransport-core <- concrete driver
                              -> rwebtransport
                                -> HTTP/3 -> QUIC -> UDP
```

The core package owns session, stream, datagram, error, and driver contracts. It uses WHATWG
`ReadableStream` and `WritableStream` plus `Uint8Array`; it must not translate them to Node streams
or `Buffer`.

The Nest package may depend on the core package, but it must never import `rwebtransport`. Concrete
drivers adapt an implementation to the core contracts. The testing package provides test doubles
for the same contracts.

## First milestone

The first implementation milestone is intentionally limited to:

1. start a QUIC server through a `WebTransportDriver`;
2. accept a WebTransport session;
3. discover a Nest gateway;
4. invoke `@OnSession()`;
5. route datagrams;
6. route bidirectional and unidirectional streams.

Guards, pipes, interceptors, exception filters, codecs, rooms, broadcasting, clustering, Redis, and
OpenTelemetry remain outside this milestone.
