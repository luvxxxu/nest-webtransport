# rwebtransport 0.2.2 compatibility bundle

This is the upstream ESM JavaScript bundle under Apache-2.0, with reproducible lifecycle and queue-bound patches.
The native binary continues to come from the exact `rwebtransport@0.2.2` dependency. This directory
is an exception to the repository's MIT license; see LICENSE and NOTICE here.

The upstream server registers a `closed.promise.finally(...)` cleanup and discards the returned
Promise. A native transport error (including an idle timeout after a client process is killed)
rejects that Promise without a handler, terminating a default Node process. We replace that one
cleanup with a two-branch `then`, preserving cleanup on success and failure without an orphaned
rejection. No global process handler is installed and session errors still reach the adapter.

The loader resolves the original dependency's binary directory, and the bundle imports its public
error class to preserve `instanceof` identity. No Rust, QUIC, TLS or protocol logic is modified.

When an application has already requested a stream FIN, peer session termination no longer calls
`WritableStream`'s error path again. This avoids a Node 24 Web Streams close/error race while the
native writer is settling.

`node scripts/vendor-rwebtransport.mjs` checks both the exact upstream SHA-256 and the generated
output. `--write` regenerates it. Review/remove this compatibility bundle when upgrading upstream;
do not silently apply the patch to another source version.

Upstream incoming `ReadableStream` high-water marks were advisory only: enqueue did not check
capacity. A stalled handler allowed a peer to queue at least 1,000 finished streams behind it.
The compatibility bundle caps each incoming stream collection at 256 objects and the incoming
session collection at 1,024; overflow closes the offending session with code 257. Stream body
flow control stays unchanged. These adapter-level caps supplement the configurable Nest limits
and protect the queue before Nest can consume it.
