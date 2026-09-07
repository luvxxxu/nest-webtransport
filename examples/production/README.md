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
bun run --cwd examples/production build
node --env-file=examples/production/.env examples/production/dist/main.js
```

The WebTransport listener is UDP/4433 by default. The operations listener is TCP/3000. A
production QUIC-capable load balancer must preserve UDP affinity for the lifetime of a connection;
Redis does not move a live QUIC session between replicas.

The OpenTelemetry package emits through `@opentelemetry/api`. Install and initialize the SDK and
exporters required by your environment before importing `AppModule`. The `/metrics` endpoint is a
dependency-free Prometheus snapshot of the driver counters and gauges.

The Kubernetes file contains placeholder image, origin, TLS Secret, and application Secret names.
It is an example to adapt, not a claim that those resources exist in a cluster.
