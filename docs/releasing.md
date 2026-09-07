# Releasing

The five packages are versioned together. The initial release is `0.1.0`; pre-1.0 minor releases
may change API contracts. This repository prepares artifacts but never publishes automatically.

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
4. Publish those tarballs in dependency order: `webtransport-core`, `nest-webtransport`,
   `webtransport-driver-rwebtransport`, `nest-webtransport-testing`, `nest-webtransport-otel`.
5. Install the released versions in a clean application and run the smoke checks again.

Use a release candidate dist-tag while verifying registry publication. Registry ownership,
credentials and successful publication are separate from local artifact validation.
