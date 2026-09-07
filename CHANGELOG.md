# Changelog

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
