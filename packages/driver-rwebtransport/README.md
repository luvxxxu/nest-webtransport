# webtransport-driver-rwebtransport

The native QUIC and HTTP/3 adapter backed by `rwebtransport`. Its supported runtime follows the
upstream Node.js 24.x and 26.x binary matrix.

When installing with Bun, the repository explicitly trusts the upstream `rwebtransport`
postinstall hook. Consumers whose Bun security policy blocks that hook must review it and run
`bun pm trust rwebtransport` before using the native driver.
