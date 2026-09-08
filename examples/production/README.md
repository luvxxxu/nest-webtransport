# Production example

This example combines the framework's production-facing pieces without hiding the deployment
boundaries:

- exact Origin checks at both the native-driver and Nest admission layers
- bounded handler, datagram, session, stream, and rate limits
- HS256 JWT authentication with issuer, audience, expiry, and not-before checks
- Redis-backed session presence with an expiry
- OpenTelemetry driver instruments and handler spans
- `/livez`, `/readyz`, and Prometheus-text `/metrics` endpoints on a separate TCP port
- drain-first shutdown and Kubernetes probes/resources

Copy `.env.example` to `.env`, replace every credential and endpoint, then run:

```bash
bun install
bun run build
bun run --cwd examples/production build
node --env-file=examples/production/.env examples/production/dist/main.js
```

The WebTransport listener is UDP/4433 by default. The operations listener is TCP/3000. A
production QUIC-capable load balancer must preserve UDP affinity for the lifetime of a connection;
Redis does not move a live QUIC session between replicas.

The OpenTelemetry package emits through `@opentelemetry/api`. Install and initialize the SDK and
exporters required by your environment before importing `AppModule`. The `/metrics` endpoint is a
dependency-free Prometheus snapshot of driver and runtime counters and gauges.

The Kubernetes file contains placeholder image, origin, TLS Secret, and application Secret names.
It is an example to adapt, not a claim that those resources exist in a cluster.

`AppModule.register(loadProductionConfig())` creates the application configuration at bootstrap.
The test suite boots the real Nest module with a virtual transport and a mocked Redis dependency,
then checks authenticated traffic, presence cleanup, HTTP probes, and runtime metrics.

JWTs are accepted through the `Authorization: Bearer` header and must use HS256 with the configured
issuer and audience. Generate a random secret (`openssl rand -hex 32`); empty and known placeholder
secrets fail startup. Active sessions close when their JWT expires, so clients must obtain a new
token and reconnect. Immediate token revocation and account logout require an application-specific
revocation mechanism. Browsers cannot set an arbitrary WebTransport Authorization header: use the
short-lived, one-use ticket exchange shown in `examples/web-demo` when adding a browser client.
Do not put a reusable JWT in a URL.

Clients send a datagram beginning with byte `1` every 30 seconds to refresh presence. Keys expire
120 seconds after the last update. A disconnect during an in-flight SET schedules cleanup after
that write; cleanup is idempotent, and Redis TTL is the fallback if Redis is unavailable. Redis
presence is advisory rather than a durable online-user registry.

Redis must be configured explicitly through `REDIS_URL`. Offline queuing is disabled, the command
queue is capped at 256, socket connection attempts have a 1-second timeout, and reconnect attempts
use bounded backoff (at most five retries). Startup has a 5-second total budget; individual commands
and shutdown draining each have a 1-second budget. Session cancellation releases callers promptly.
A stalled command destroys the Redis connection to bound retained work. Exhausted retries or a
command deadline make `/livez` fail so the process supervisor can restart the instance; transient
reconnects make only `/readyz` fail. Use `rediss://` when Redis traffic crosses an untrusted network.
These policies follow [node-redis production guidance](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)
and [client configuration](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md),
with behavior regression-tested against the locked node-redis version.

The example caps the server at 1,000 sessions, 512 active incoming streams, 128 concurrent handlers,
512 queued handlers, and 8 MiB of queued datagram payloads. Each session has at most 8 concurrent
handlers, 16 queued handlers, and 16 queued datagrams. These are starting limits, not a tested
capacity promise; measure CPU, memory, latency and loss with your handlers before raising them.
Runtime rejection/drop counters and queue gauges are exported separately from driver counters.
JSON transport logging drops new records while stdout is backpressured; the next record reports
the suppressed count instead of growing an unbounded log queue.

The operations listener defaults to loopback. Keep it private: the Kubernetes example opts into
`0.0.0.0` for probes and exposes operations through a separate ClusterIP service. Adapt your cluster
network policy to restrict metrics to monitoring workloads. The pod runs without root or added
capabilities, mounts TLS read-only, and reserves 40 seconds for the 5-second pre-stop delay plus
transport draining and cleanup.

Build the image from the repository root:

```bash
docker build --file examples/production/Dockerfile --tag nest-webtransport-production:local .
```

The image uses Node 26 for both building and running. Bun installs dependencies and runs build
scripts; the runtime has production dependencies only. The Docker build context excludes local
environment files, TLS keys/certificates, caches and host-generated dependencies. CI builds the
image from a clean checkout and checks runtime imports. Actual Redis outage/recovery, Kubernetes
rolling updates, UDP load balancers, certificate rotation and longer load tests still need to run
in the target deployment environment.
