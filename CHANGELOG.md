# Changelog

## 1.0.0-rc.1

- Fix request-scoped Nest global enhancers, module-owned provider resolution and fail-open enhancer fallback.
- Bound aggregate server work, active incoming streams, retained datagram bytes and log volume.
- Keep reservations until real work settles; stop late resolver/enhancer completion from invoking closed sessions.
- Add manual I/O activity refresh, runtime policy metrics and private error diagnostics; fix driver liveness mismatch.
- Preserve active streams during incoming collection cancellation and propagate failed native writes/closes.
- Bound connection stats sampling and correct virtual transport direction/abort behavior.
- Make the production example bootable with bounded Redis failure handling, JWT session expiry and race-safe presence cleanup.
- Repair container build inputs and strengthen real bootstrap, deployment and release checks.
- Redact OTel exception details by default; expose bounded runtime rejection/drop reasons separately from driver metrics.
- Reduce default session ceilings to 1,000. See docs/releasing.md for pre-v1 migration and qualification gates.

## 0.1.0

Initial release of the core, NestJS integration, rwebtransport driver, testing utilities,
and optional OpenTelemetry integration.

- Raw datagram, bidirectional and unidirectional stream handlers with optional application routing.
- Nest discovery, inherited handlers, session-scoped dependency injection, guards, pipes,
  interceptors and exception filters.
- Origin/authentication admission, bounded work queues, connection/stream/rate limits,
  timeouts, graceful drain and readiness reporting.
- Authentication work remains counted against capacity after timeout or disconnect until it settles.
- Native stream termination propagates to consumers and releases reader/writer locks.
- Native callback/session capacity and bounded shutdown with retry after timeout.
- Pinned upstream compatibility bundle fixes process termination on abnormal session close and
  caps incoming session/stream queues before Nest consumes them.
- Unexpected native server termination clears driver readiness.
- Tracing subscribes within the span context and omits URL query/fragment credentials.
- `nest-webtransport` re-exports the native driver so the standard setup needs only one framework
  package in the application install command.
- MIT license, source maps with corresponding sources, and isolated package installation checks.
- Automated native, Chromium, overload, abrupt-disconnect and sustained-load release gates.
