# nest-webtransport

A driver-based WebTransport foundation for NestJS. The Nest integration depends on a
runtime-neutral core contract, while concrete QUIC implementations live in separate driver
packages.

> Status: foundation scaffold. Public runtime APIs are intentionally not implemented yet.

## Packages

| Package | Responsibility |
| --- | --- |
| `webtransport-core` | Runtime-neutral session, stream, datagram, and driver contracts |
| `nest-webtransport` | NestJS module, decorators, discovery, and handler routing |
| `webtransport-driver-rwebtransport` | `rwebtransport` adapter for QUIC and HTTP/3 |
| `nest-webtransport-testing` | Mock drivers and sessions for tests without a QUIC server |

The dependency direction is fixed:

```text
NestJS -> nest-webtransport -> webtransport-core
                                      ^
                                      |
              webtransport-driver-rwebtransport -> rwebtransport
```

## Toolchain

- Bun 1.3.12 or newer for dependency management and repository scripts
- Node.js 24.x or 26.x as the supported runtime for the native `rwebtransport` driver
- TypeScript 5.9 in strict NodeNext ESM mode
- Biome for formatting and linting
- Vitest for tests

Using Bun in this repository does not make the published packages Bun-only. Runtime source must
stay on standard JavaScript and Web APIs, and CI validates the workspace on both supported Node
majors.

## Start

```bash
bun install
bun run check
```

Architecture boundaries and the first milestone are documented in
[`docs/architecture.md`](docs/architecture.md).
