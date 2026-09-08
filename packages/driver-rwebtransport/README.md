# webtransport-driver-rwebtransport

The native QUIC and HTTP/3 adapter backed by `rwebtransport`. Its supported runtime follows the
upstream Node.js 24.x and 26.x binary matrix.

When installing with Bun, the repository explicitly trusts the upstream `rwebtransport`
postinstall hook. Consumers whose Bun security policy blocks that hook must review it and run
`bun pm trust rwebtransport` before using the native driver.

## Compatibility hardening

The package pins `rwebtransport` to 0.2.2 and includes its Apache-2.0 JavaScript bundle with audited
fixes for abnormal session cleanup and unbounded incoming object queues. Native binaries still
come from the original dependency. See `vendor/README.md`, `vendor/LICENSE` and `vendor/NOTICE`.

`RWebTransportDriver` accepts `maxSessions` (default 1,000) and `maxPendingSessionCallbacks`
(default 1,024). The upstream-facing queues additionally cap pending incoming sessions at 1,024
and pending streams at 256 per direction/session. Queue overflow closes the offending session.
These limits apply after the native handshake; they are not a pre-CONNECT admission firewall.

The `port` getter reports the bound UDP port after `start()`, including when configured with
`port: 0`. `stop({timeoutMs})` bounds shutdown; failures retain `STOPPING` until a successful retry.

`getStats()` returns counters immediately and asynchronously refreshes cached connection details.
Native connection snapshots are shared across callers, refreshed at most once per
`connectionStatsIntervalMs` (default 1,000 ms), with at most 32 requests in flight. The first
snapshot may have no connection details until the refresh completes. Closed sessions disappear
immediately. This avoids a full native request fan-out on every health check or metrics scrape.

`onError(error)` optionally receives asynchronous native server failures for a private diagnostic
sink. Its exceptions and rejected promises are isolated from shutdown. Do not expose unsanitized
native errors to public clients or metrics labels.
