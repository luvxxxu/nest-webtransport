# Basic native example

This example boots a Nest application context and serves WebTransport at `/basic` through the
native `rwebtransport` driver. It uses raw, unnamed handlers:

- datagrams are echoed to the client;
- bidirectional stream bytes are piped back to the client;
- unidirectional streams are consumed and their final byte count is logged.

The gateway receives incoming values through `@Payload()` and `@Stream()`. It does not compete with
the Nest runtime for session-level collection readers.

## Configure

Use Node.js 24.x or 26.x. Bun installs dependencies and runs repository scripts; the `start` script
launches the application itself with Node.

Copy `.env.example` to `.env` and replace every placeholder:

```dotenv
WEBTRANSPORT_HOST=0.0.0.0
WEBTRANSPORT_PORT=4433
WEBTRANSPORT_TLS_CERT_PATH=/absolute/path/to/webtransport.crt
WEBTRANSPORT_TLS_KEY_PATH=/absolute/path/to/webtransport.key
WEBTRANSPORT_ALLOWED_ORIGINS=https://app.example.com
WEBTRANSPORT_AUTH_TOKEN=replace-with-a-random-token-of-at-least-32-characters
```

`WEBTRANSPORT_ALLOWED_ORIGINS` accepts a comma-separated list of canonical, exact HTTP(S) origins.
Wildcards, paths, query strings, fragments, credentials, and trailing slashes are rejected. The same
list is applied twice: by `rwebtransport` as its static pre-CONNECT check and by the Nest runtime as
its portable post-surface check.

The bearer token check occurs immediately after the native driver surfaces an established session.
`rwebtransport` 0.2.2 does not expose a dynamic pre-CONNECT authentication hook, so a failed token
check closes that session rather than denying its HTTP/3 CONNECT request.

## Run

From the repository root:

```bash
bun install
bun run --cwd examples/basic typecheck
bun run --cwd examples/basic start
```

A client must connect to `https://<host>:<port>/basic` with an exact allowed Origin and an
`Authorization: Bearer <WEBTRANSPORT_AUTH_TOKEN>` header. This compact example does not include a
browser client, certificate generation, HTTP health endpoints, or deployment manifests.
