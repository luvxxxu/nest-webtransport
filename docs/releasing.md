# Releasing

The five packages are versioned together at `1.0.0-rc.1`. This is a v1 candidate; promote to `1.0.0`
only after the remaining target-environment gates in [v1 readiness](v1-readiness.md) pass. The candidate
introduces aggregate limits and changes conservative defaults; review the migration notes below.
This repository prepares artifacts but never publishes automatically.

## Required checks

Use Node.js 24.x or 26.x, Bun 1.3.12, and OpenSSL. Other Node majors are unsupported for the native
package. The Nest packages follow this same tested Node matrix; the standalone core/testing
packages need Node 20.11 or newer.

```sh
bun ci
bunx playwright install --with-deps chromium
bun run release:check
bun audit
```

`release:check` performs lint, source/test/example typechecks, unit and virtual integration tests,
package validation, real native QUIC integration, Chromium integration, sustained load, and a clean
npm installation of all five tarballs outside the workspace. Installation verification checks
public imports, Nest bootstrap/shutdown, TypeScript declarations without `skipLibCheck`, licenses,
and rewritten workspace dependency versions. No npm publication takes place.

Native tests use freshly generated, short-lived ECDSA certificates pinned by SHA-256. They do not
disable TLS verification. Test listeners bind only to loopback and select unused ports.

The abrupt-disconnect gate kills a separate native client process and waits for the actual
30-second QUIC idle timeout, asserting that the server survives and reclaims the session.

The soak gate defaults to 60 seconds with ten concurrent clients per round, 64 KiB stream echoes,
and disconnects during active streams. Each round checks that sessions and streams return to zero.
After warmup, retained JS heap must grow by less than 20 MiB and RSS by less than 128 MiB. Use a
longer run for a deployment qualification:

```sh
WEBTRANSPORT_SOAK_MS=1800000 bun run test:soak
```

Passing these checks verifies the bounded scenarios, not every workload, network or deployment.
Size admission, stream, handler and infrastructure limits for the application. Verify the release
workflow on each target OS/architecture before advertising it as tested.

## Publication

1. Review the release report, changelog, MIT license and security documentation.
2. Confirm package names are owned by the intended npm account and the matching release workflow
   is green for the exact commit being published.
3. Pack with Bun (which resolves `workspace:*`) and inspect the five tarballs.
4. Publish those tarballs in dependency order: `webtransport-core`,
   `webtransport-driver-rwebtransport`, `nest-webtransport`, `nest-webtransport-testing`,
   `nest-webtransport-otel`.
5. Install the released versions in a clean application and run the smoke checks again.

Use a release candidate dist-tag while verifying registry publication. Registry ownership,
credentials and successful publication are separate from local artifact validation.


## Migrating from 0.1.0

- Default runtime/native session ceilings are reduced to 1,000. Set explicit validated ceilings for
  larger workloads. `limits.server` now includes `maxConcurrentHandlers`, `maxPendingHandlers`,
  `maxStreams` and `maxQueuedDatagramBytes`. A fully constructed core `WebTransportServerLimits`
  object must supply these fields; module overrides remain partial.
- Global execution capacity includes admission and retained disconnected work. Budget exhaustion
  rejects admission and uses the configured handler overflow policy for events.
- `getRuntimeStats()` and `webtransport.runtime.*` metrics distinguish policy drops/rejections from
  driver counters. Alert on both. Logs are rate limited by default.
- For manual/outgoing I/O use `SessionContext.touch()`, or own idle cleanup with `idleTimeoutMs: 0`.
- Failed native writes/closes now reject instead of reporting success. Handle transport failures.
- Default OTel exception details are redacted. Enable raw details only with exporter redaction.
- Production JWT sessions expire with their token. Redis offline buffering is disabled and stalled
  commands or exhausted reconnects fail liveness. Configure an orchestrator restart policy.
- Request-scoped Nest globals retain their real provider token and owning module; registered
  provider failures propagate instead of falling back to a new unconfigured enhancer.

Review consumer applications against the candidate before making a stable SemVer commitment.
