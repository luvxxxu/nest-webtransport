# Security model

WebTransport combines an HTTP/3 CONNECT request with a long-lived QUIC session. Admission policy
therefore has two distinct timing boundaries: checks the native server can perform while processing
CONNECT, and checks the Nest runtime performs immediately after a driver surfaces a session.

## Admission timing

| Check | Earliest available boundary with `rwebtransport` 0.2.2 |
| --- | --- |
| TLS certificate and private key | QUIC/TLS handshake |
| Static origin allowlist | Before CONNECT acceptance, through native `allowedOrigins` support |
| Dynamic token, cookie, or database authentication | Immediately after the established session is surfaced |
| Aggregate header-size check | Immediately after the session is surfaced |
| Global and per-IP application limits | Immediately after the session is surfaced |
| Datagram, stream, handler, and idle limits | During the accepted session |

`rwebtransport` 0.2.2 does not expose a dynamic pre-CONNECT authorization callback. A failed Nest
authenticator or resource check closes the newly surfaced session; it cannot turn that decision into
an HTTP/3 CONNECT denial. If a deployment requires dynamic authorization before CONNECT succeeds,
it needs a future driver capability or a QUIC-aware admission layer in front of this process.

The native static `allowedOrigins` facility is the only application admission check available
before CONNECT in this driver version. `RWebTransportDriver` exposes it as a constructor option.
Nest `security.allowedOrigins` is checked separately after the session is surfaced; the module does
not copy that portable option into an already constructed driver.

## Safe module configuration

```ts
import { RWebTransportDriver, WebTransportModule } from 'nest-webtransport';

const webTransport = WebTransportModule.forRoot({
  // rwebtransport applies this static list before CONNECT is accepted.
  driver: new RWebTransportDriver({
    allowedOrigins: ['https://app.example.com'],
  }),
  server: {
    host: '0.0.0.0',
    port: 4433,
    tls: {
      certificate: { kind: 'path', path: '/run/secrets/webtransport.crt' },
      privateKey: { kind: 'path', path: '/run/secrets/webtransport.key' },
    },
  },
  security: {
    allowedOrigins: ['https://app.example.com'],
    requireOrigin: true,
    maxHeaderSize: 16 * 1024,
    maxDatagramSize: 1_200,
    handshakeTimeoutMs: 5_000,
    idleTimeoutMs: 60_000,
    authenticate(session, context) {
      const authorization = session.headers.get('authorization');
      if (authorization !== 'Bearer expected-test-value') {
        return false;
      }

      return { subject: 'user-123', scopes: ['realtime'] };
    },
  },
  limits: {
    server: { maxSessions: 10_000 },
    ip: { maxSessions: 50, sessionsPerSecond: 5 },
    session: {
      maxBidirectionalStreams: 64,
      maxUnidirectionalStreams: 64,
      maxDatagramsPerSecond: 500,
      maxConcurrentHandlers: 32,
      maxPendingHandlers: 64,
    },
    stream: { maxLifetimeMs: 120_000 },
  },
  execution: {
    maxConcurrentHandlers: 32,
    maxPendingHandlers: 64,
    overflow: 'close-session',
  },
  datagrams: {
    queue: { size: 128, overflow: 'drop-oldest' },
  },
  shutdown: {
    graceful: true,
    drainTimeoutMs: 10_000,
    forceCloseTimeoutMs: 15_000,
  },
});
```

The value returned by `authenticate()` becomes `SessionContext.principal`. Returning `false`,
throwing, or exceeding the admission timeout rejects the session. Returning `undefined` admits the
session without setting a principal.

Do not compare production bearer tokens as shown in the compact example. Use a verifier that
validates signature, issuer, audience, time claims, and revocation policy as appropriate for the
application. Never place credentials in route names, close reasons, or log fields.

## Origin behavior

`requireOrigin` defaults to `true`, and the module requires a non-empty `security.allowedOrigins`
list while it is enabled. To support a client that legitimately omits Origin, set
`requireOrigin: false` deliberately; a non-empty allowlist still rejects a present Origin that does
not match.

The native pre-CONNECT list is configured separately as
`new RWebTransportDriver({ allowedOrigins })`. Keep that list aligned with the Nest policy. The
driver setting is static for the lifetime of the native server; the Nest setting remains the
portable post-surface check.

Origins are compared after serialized URL-origin normalization. Configure explicit origins and include
only the schemes, hosts, and ports the application owns. Do not reflect arbitrary Origin values in
response headers.

Non-browser clients may omit Origin. Admit them only through an explicit policy decision, for
example a separate listener or `requireOrigin: false` combined with strong session authentication.

## TLS credentials

The core contract can represent path, PEM, or byte credentials, but the current
`webtransport-driver-rwebtransport` adapter accepts only filesystem paths. It rejects:

- a missing TLS configuration;
- inline PEM or byte credentials;
- empty certificate/key paths;
- encrypted private keys with a passphrase.

Mount certificate material read-only, restrict file permissions to the service account, and rotate
it through a controlled restart until live certificate reload is implemented. The native driver
requires Node.js 24.x or 26.x.

## Limits and overload behavior

All framework-owned queues are bounded. The security effect of each overflow policy is different:

- `drop-oldest`: favors the newest datagram state and is suitable for position/telemetry updates.
- `drop-newest`: protects already queued work.
- `reject`: rejects the current work item.
- `close-session`: removes a peer that continues sending beyond capacity.

Handler scheduling supports `drop`, `reject`, and `close-session`. Reliable streams wait for
scheduler capacity before another stream is accepted from the session collection; their body
backpressure remains in the underlying Web Stream. Datagram rate and size failures are dropped and
logged because datagrams are unreliable by definition.

Framework ceilings do not replace operating-system, QUIC-library, container, or load-balancer
limits. Size file-descriptor, UDP-buffer, memory, and connection limits together, then validate them
under load.

## Guards and handler authorization

Session authentication establishes identity once. Handler-specific authorization can use normal
Nest guards and the WebTransport context:

```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { switchToWebTransport } from 'nest-webtransport';

@Injectable()
export class RealtimeScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const transport = switchToWebTransport(context);
    const principal = transport.getSessionContext().principal as
      | { scopes?: readonly string[] }
      | undefined;

    return principal?.scopes?.includes('realtime') === true;
  }
}
```

Pipes validate the selected `@Payload()`, interceptors wrap handler execution, and exception filters
can handle failures. A scoped core error determines whether the runtime ends only the invocation,
resets a stream, closes a session, or stops the server.

## Logging and secret handling

The runtime's structured records contain event names, timestamps, session/stream identifiers, safe
error codes, and an error class name. It does not add authorization headers, cookies, raw tokens, or
payload bytes. A custom logger must preserve that boundary; do not serialize the session or context
object wholesale.

Session close reasons cross the network. Keep them short and non-sensitive. Use internal error codes
and correlated server logs for detail.

## Deployment checklist

- Terminate QUIC/TLS only at a component that explicitly supports WebTransport over HTTP/3.
- Expose and balance UDP deliberately; a generic TCP/HTTP reverse proxy is not sufficient.
- Set an exact Origin allowlist and verify where it is enforced.
- Authenticate every session and keep `@OnSession()` bounded by the admission timeout.
- Tune global, per-IP, stream, datagram, and handler limits for the actual host.
- Keep readiness false during drain while liveness remains true.
- Exercise certificate errors, missing Origin, invalid tokens, floods, abrupt disconnects, and
  shutdown in a real native environment.
- Do not claim production readiness until browser, chaos, load, leak, and soak gates pass.

## Cancellation and retained work

A timeout or disconnect aborts `SessionContext.signal`. Authenticators and handlers should propagate
that signal to cancellable I/O. JavaScript cannot forcibly cancel an arbitrary Promise: unfinished
admission and handler work continues to occupy global/per-IP capacity until it actually settles.
This deliberately rejects additional work rather than allowing a reconnect loop to accumulate
background operations. An authenticator that never settles can exhaust its allocated capacity;
use downstream I/O deadlines as well as the admission timeout.

The native driver separately caps established sessions (`maxSessions`, default 50,000) and pending
session callbacks (`maxPendingSessionCallbacks`, default 1,024), including callbacks whose peers
have already left. Align these ceilings with Nest's limits. Driver `stop({timeoutMs})` bounds the
whole stop operation; a native shutdown timeout rejects and leaves state at `STOPPING`, permitting
a retry once native closure settles. Runtime health reports failed liveness if a previously
running driver has stopped unexpectedly.

Timers must fit Node's 2,147,483,647 ms range; larger values are rejected instead of becoming a
1 ms timeout. OpenTelemetry path attributes omit query strings and fragments to avoid exposing
URL credentials or producing one metric series per ticket.

The pinned native dependency's server Promise cleanup has a known rejection propagation defect.
The shipped compatibility bundle handles both fulfillment and rejection locally. A killed-client
regression test waits for the actual native idle timeout; no global unhandled-rejection handler is
installed. See the driver's `vendor/README.md` for the reproducible patch and license details.

Upstream-facing incoming queues are independently capped at 1,024 sessions and 256 streams per
session/direction. A peer that overflows a queue is closed with code 257; stream bodies retain Web
Stream backpressure. These caps protect work waiting before the Nest scheduler can consume it.
Framework stream limits cover decorator-managed incoming streams. Application-created outgoing
streams and manually consumed collections also require application-level concurrency and lifetime
management; the module cannot infer when an arbitrary background workflow has finished.
