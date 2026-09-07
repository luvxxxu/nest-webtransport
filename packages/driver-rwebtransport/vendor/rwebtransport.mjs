// Generated from rwebtransport 0.2.2, SHA-256 21883683820cb299a9a4fb288b3ece4e7ffe2d93f04b430b6c04b5c9ea556e08.
// Copyright 2026 Dacely Cloud. Apache-2.0; see LICENSE and NOTICE in this directory.
// Modified by nest-webtransport contributors: handle rejected session cleanup;
// bound incoming stream collections; resolve the dependency's binaries; preserve error identity.
// Regenerate with: node scripts/vendor-rwebtransport.mjs --write
// src/loader.ts
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
var require2 = createRequire(import.meta.url);
var moduleDir = dirname(fileURLToPath(import.meta.url));
var PACKAGE_ROOT = dirname(dirname(require2.resolve("rwebtransport")));
function assertSupportedRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24 && major !== 26) {
    throw new Error(
      `rwebtransport supports Node 24 and Node 26 only; this is Node ${process.versions.node}.`
    );
  }
}
function prebuiltPath() {
  return join(
    PACKAGE_ROOT,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "rwebtransport.node"
  );
}
var cached;
function loadNative() {
  if (cached) return cached;
  assertSupportedRuntime();
  const prebuilt = prebuiltPath();
  if (existsSync(prebuilt)) {
    cached = require2(prebuilt);
    return cached;
  }
  const builder = join(PACKAGE_ROOT, "scripts", "build.js");
  if (!existsSync(builder)) {
    throw new Error(
      `rwebtransport: no prebuilt binary at ${prebuilt} and no build script to compile one. Reinstall the package or build it manually (npm run build:rust).`
    );
  }
  process.stderr.write(
    "rwebtransport: no prebuilt binary for this platform; compiling the native addon (this happens once)...\n"
  );
  execFileSync(process.execPath, [builder], { cwd: PACKAGE_ROOT, stdio: "inherit" });
  if (!existsSync(prebuilt)) {
    throw new Error(`rwebtransport: build completed but ${prebuilt} was not produced.`);
  }
  cached = require2(prebuilt);
  return cached;
}

// Share the public error identity with the upstream package.
import { WebTransportError } from "rwebtransport";

// src/native.ts
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
var SessionCore = class {
  /**
   * The command transport, undefined until {@link SessionCore.attach} runs.
   * While undefined, outbound commands are dropped or rejected.
   */
  transport;
  /** Monotonic source of request ids handed to the transport. */
  nextRequestId = 1;
  /** Pending {@link SessionCore.openStream} requests, keyed by request id. */
  opens = /* @__PURE__ */ new Map();
  /** Pending {@link SessionCore.write} requests, keyed by request id. */
  writes = /* @__PURE__ */ new Map();
  /** Pending {@link SessionCore.sendDatagram} requests, keyed by request id. */
  datagramAcks = /* @__PURE__ */ new Map();
  /** Pending getStats() requests, keyed by request id. */
  statsRequests = /* @__PURE__ */ new Map();
  /** Pending exportKeyingMaterial() requests, keyed by request id. */
  keyingMaterialRequests = /* @__PURE__ */ new Map();
  /** Active receive sinks, keyed by stream id. */
  receives = /* @__PURE__ */ new Map();
  /** Active send sinks, keyed by stream id. */
  sends = /* @__PURE__ */ new Map();
  /** Handler for peer-initiated streams, if one has been set. */
  incoming;
  /** Sink for inbound datagrams, if one has been set. */
  datagramSink;
  /** Count of inbound datagrams dropped because the readable queue was full. */
  droppedIncomingDatagrams = 0;
  /** True once the session has reached its terminal (closed) state. */
  closedState = false;
  /** True once the session has been established (`ready`/`serverReady`). */
  readyState = false;
  /** True when the session reached its terminal state through an error. */
  failedState = false;
  /** The most recent stats reported by the native layer, cached for {@link SessionCore.getStats}. */
  lastStats;
  /** The negotiated subprotocol, cached from the ready event (`''` if none). */
  cachedProtocol = "";
  /** The CONNECT response headers, cached from the client ready event. */
  cachedResponseHeaders = [];
  /**
   * Resolves when the session is established, rejects if it fails before then.
   * Backs the public `WebTransport.ready` promise.
   */
  ready = deferred();
  /**
   * Resolves with close info on a clean shutdown, rejects on an error or on a
   * close that happens before the session is ready. Backs `WebTransport.closed`.
   */
  closed = deferred();
  /**
   * Resolves when the peer sends a DRAIN_WEBTRANSPORT_SESSION capsule (it
   * intends to close soon but the session stays usable). Backs
   * `WebTransport.draining`. Never rejects.
   */
  draining = deferred();
  /**
   * Attach no-op catch handlers to {@link SessionCore.ready} and
   * {@link SessionCore.closed} so that a session whose promises the user never
   * observes does not trigger Node's unhandled-rejection warning.
   */
  constructor() {
    void this.closed.promise.catch(() => {
    });
    void this.ready.promise.catch(() => {
    });
  }
  /**
   * Attach the transport once the underlying native handle exists.
   *
   * @param transport - The command sink for this session (client or server side).
   */
  attach(transport) {
    this.transport = transport;
  }
  /**
   * Fail a session that could not be set up at all (e.g. client connect threw).
   *
   * @param message - Human-readable description of the setup failure.
   * @remarks
   * The failure is delivered on a microtask so the caller has a chance to
   * attach `.ready`/`.closed` handlers before they reject.
   */
  failSetup(message) {
    queueMicrotask(
      () => this.finish(null, new WebTransportError(message, { source: "session" }))
    );
  }
  /**
   * @returns The next request id, post-incrementing the internal counter.
   */
  nextId() {
    return this.nextRequestId++;
  }
  /**
   * Open an outbound stream and await its assigned id.
   *
   * @param bidi - True for a bidirectional stream, false for unidirectional.
   * @returns A promise for the new stream's id.
   * @remarks
   * Rejects immediately (without touching the transport) if the session is not
   * usable (unattached or closed).
   */
  openStream(bidi) {
    if (!this.usable()) return Promise.reject(this.deadError());
    const requestId = this.nextId();
    const d = deferred();
    this.opens.set(requestId, d);
    this.transport.openStream(bidi, requestId);
    return d.promise;
  }
  /**
   * Write a chunk to a stream; resolves once the bytes are flushed into quiche
   * (the write backpressure signal).
   *
   * @param streamId - The target stream id.
   * @param chunk - The bytes to send.
   * @returns A promise that resolves when the write is acknowledged.
   * @remarks
   * Rejects immediately if the session is not usable.
   */
  write(streamId, chunk) {
    if (!this.usable()) return Promise.reject(this.deadError());
    const requestId = this.nextId();
    const d = deferred();
    this.writes.set(requestId, d);
    this.transport.write(streamId, chunk, requestId);
    return d.promise;
  }
  /**
   * Finish (half-close) the send side of a stream. No-op if not attached.
   *
   * @param streamId - The stream to finish.
   */
  finStream(streamId) {
    this.transport?.fin(streamId);
  }
  /**
   * Reset the send side of a stream. No-op if not attached.
   *
   * @param streamId - The stream to reset.
   * @param code - The application error code; coerced to an unsigned 32-bit value.
   */
  resetStream(streamId, code) {
    this.transport?.reset(streamId, code >>> 0);
  }
  /**
   * Ask the peer to stop sending on a stream. No-op if not attached.
   *
   * @param streamId - The stream whose inbound half should be stopped.
   * @param code - The application error code; coerced to an unsigned 32-bit value.
   */
  stopSending(streamId, code) {
    this.transport?.stopSending(streamId, code >>> 0);
  }
  /**
   * Toggle read backpressure on a stream. No-op if not attached.
   *
   * @param streamId - The receive stream.
   * @param paused - True to pause native draining (flow-control the peer), false to resume.
   */
  setPaused(streamId, paused) {
    this.transport?.setPaused(streamId, paused);
  }
  /**
   * Send a datagram.
   *
   * @param chunk - The datagram payload.
   * @returns A promise resolving to whether the datagram was actually sent;
   *   resolves to false (rather than rejecting) when the session is not usable.
   */
  sendDatagram(chunk) {
    if (!this.usable()) return Promise.resolve(false);
    const requestId = this.nextId();
    const d = deferred();
    this.datagramAcks.set(requestId, d);
    this.transport.sendDatagram(chunk, requestId);
    return d.promise;
  }
  /**
   * @returns The maximum datagram payload size in bytes, or 0 if not attached.
   */
  maxDatagramSize() {
    return this.transport ? this.transport.maxDatagramSize() : 0;
  }
  /**
   * Gracefully close the session. No-op if already closed or not attached.
   *
   * @param code - The WebTransport close code; coerced to an unsigned 32-bit value.
   * @param reason - The close reason, UTF-8 encoded before it is sent.
   */
  close(code, reason) {
    if (this.closedState || !this.transport) return;
    this.transport.closeSession(code >>> 0, new TextEncoder().encode(reason));
  }
  /** Tell the peer this session is draining (send a DRAIN capsule). */
  drain() {
    this.transport?.drain();
  }
  /**
   * Snapshot the connection's stats. Resolves with a
   * {@link WebTransportConnectionStats} once the driver reports back. After a
   * clean close it resolves with the last stats seen while live; it rejects
   * only when the session was never attached or terminated through an error.
   */
  getStats() {
    if (!this.usable()) {
      if (!this.failedState && this.lastStats !== void 0) {
        return Promise.resolve(this.lastStats);
      }
      return Promise.reject(this.deadError());
    }
    const requestId = this.nextId();
    const d = deferred();
    this.statsRequests.set(requestId, d);
    this.transport.getStats(requestId);
    return d.promise;
  }
  /**
   * Export TLS keying material (RFC 5705). Resolves with `length` bytes derived
   * from `label` and `context` once the driver reports back; rejects if the
   * session is not usable or the TLS export fails.
   */
  exportKeyingMaterial(label, context, length) {
    if (!this.usable()) return Promise.reject(this.deadError());
    const requestId = this.nextId();
    const d = deferred();
    this.keyingMaterialRequests.set(requestId, d);
    this.transport.exportKeyingMaterial(requestId, label, context, length);
    return d.promise;
  }
  /** Tear down the native resources for this session. No-op if not attached. */
  shutdown() {
    this.transport?.shutdown();
  }
  /**
   * Whether outbound operations can still be issued (attached, not closed).
   *
   * @returns True when a transport is attached and the session is not closed.
   */
  usable() {
    return this.transport !== void 0 && !this.closedState;
  }
  /**
   * @returns The error used to reject operations attempted on a dead session.
   */
  deadError() {
    return new WebTransportError("session is closed", { source: "session" });
  }
  /**
   * Register a sink to receive a stream's inbound data/fin/reset events.
   *
   * @param streamId - The stream to observe.
   * @param sink - The receiver of that stream's inbound events.
   */
  registerReceive(streamId, sink) {
    this.receives.set(streamId, sink);
  }
  /**
   * Stop delivering inbound events for a stream.
   *
   * @param streamId - The stream to forget.
   */
  unregisterReceive(streamId) {
    this.receives.delete(streamId);
  }
  /**
   * Register a sink to receive a stream's STOP_SENDING notifications.
   *
   * @param streamId - The stream to observe.
   * @param sink - The receiver of that stream's send-side control events.
   */
  registerSend(streamId, sink) {
    this.sends.set(streamId, sink);
  }
  /**
   * Stop delivering send-side control events for a stream.
   *
   * @param streamId - The stream to forget.
   */
  unregisterSend(streamId) {
    this.sends.delete(streamId);
  }
  /**
   * Set the handler invoked when the peer opens a stream. Replaces any prior handler.
   *
   * @param handler - The consumer of peer-initiated streams.
   */
  setIncomingHandler(handler) {
    this.incoming = handler;
  }
  /**
   * Set the sink invoked for each inbound datagram. Replaces any prior sink.
   *
   * @param sink - The consumer of inbound datagram payloads.
   */
  setDatagramSink(sink) {
    this.datagramSink = sink;
  }
  /**
   * Record that one inbound datagram was dropped because the readable queue
   * was full. Surfaced through getStats() as `datagrams.droppedIncoming`.
   */
  recordDroppedIncomingDatagram() {
    this.droppedIncomingDatagrams++;
  }
  /**
   * Route one native event to the appropriate promise, sink, or handler.
   *
   * @param ev - The event delivered by the native addon.
   * @remarks
   * This is the single entry point the native `onEvent` callback funnels into.
   * `ready`/`serverReady` mark the session established and resolve `ready`;
   * `closed`/`error` drive {@link SessionCore.finish}; the `stream*` events look
   * up the matching sink (silently ignored if none is registered); and the
   * `*Ack`/`streamOpened` events settle and then remove the pending deferred
   * for their `requestId`.
   */
  dispatch(ev) {
    switch (ev.type) {
      case "ready" /* Ready */: {
        this.readyState = true;
        this.cachedProtocol = ev.protocol ?? "";
        this.cachedResponseHeaders = ev.responseHeaders;
        this.ready.resolve();
        break;
      }
      case "serverReady" /* ServerReady */: {
        this.readyState = true;
        this.cachedProtocol = ev.protocol ?? "";
        this.ready.resolve();
        break;
      }
      case "draining" /* Draining */: {
        this.draining.resolve();
        break;
      }
      case "closed" /* Closed */: {
        const reason = new TextDecoder().decode(ev.reason);
        this.finish({ closeCode: ev.code, reason }, void 0);
        break;
      }
      case "error" /* Error */: {
        const err = new WebTransportError(ev.message, { source: "session" });
        this.finish(null, err);
        break;
      }
      case "datagram" /* Datagram */: {
        this.datagramSink?.(ev.data);
        break;
      }
      case "stream" /* Stream */: {
        if (ev.bidi) this.incoming?.onBidi(ev.streamId);
        else this.incoming?.onUni(ev.streamId);
        break;
      }
      case "streamData" /* StreamData */: {
        this.receives.get(ev.streamId)?.onData(ev.data);
        break;
      }
      case "streamFin" /* StreamFin */: {
        this.receives.get(ev.streamId)?.onFin();
        break;
      }
      case "streamReset" /* StreamReset */: {
        this.receives.get(ev.streamId)?.onReset(ev.code);
        break;
      }
      case "streamStopSending" /* StreamStopSending */: {
        this.sends.get(ev.streamId)?.onStopSending(ev.code);
        break;
      }
      case "streamOpened" /* StreamOpened */: {
        this.opens.get(ev.requestId)?.resolve(ev.streamId);
        this.opens.delete(ev.requestId);
        break;
      }
      case "writeAck" /* WriteAck */: {
        this.writes.get(ev.requestId)?.resolve();
        this.writes.delete(ev.requestId);
        break;
      }
      case "datagramAck" /* DatagramAck */: {
        this.datagramAcks.get(ev.requestId)?.resolve(ev.sent);
        this.datagramAcks.delete(ev.requestId);
        break;
      }
      case "stats" /* Stats */: {
        const stats = {
          bytesSent: ev.bytesSent,
          bytesReceived: ev.bytesReceived,
          packetsSent: ev.packetsSent,
          packetsReceived: ev.packetsReceived,
          packetsLost: ev.packetsLost,
          smoothedRtt: ev.smoothedRtt,
          rttVariation: ev.rttVariation,
          minRtt: ev.minRtt,
          datagrams: {
            expiredOutgoing: 0,
            droppedIncoming: this.droppedIncomingDatagrams,
            lostOutgoing: 0,
            expiredIncoming: 0
          }
        };
        this.lastStats = stats;
        this.statsRequests.get(ev.requestId)?.resolve(stats);
        this.statsRequests.delete(ev.requestId);
        break;
      }
      case "keyingMaterial" /* KeyingMaterial */: {
        const d = this.keyingMaterialRequests.get(ev.requestId);
        if (d) {
          if (ev.ok && ev.data) {
            d.resolve(ev.data);
          } else {
            d.reject(
              new WebTransportError("keying material export failed", {
                source: "session"
              })
            );
          }
          this.keyingMaterialRequests.delete(ev.requestId);
        }
        break;
      }
    }
  }
  /**
   * Terminal transition: resolve/reject everything and tear down.
   *
   * @param info - Close info for a clean close, or null when closing on error.
   * @param error - The error that ended the session, or undefined for a clean close.
   * @remarks
   * Idempotent: returns immediately if the session already closed. Settles the
   * lifecycle promises according to state: if the session never became ready,
   * both `ready` and `closed` reject (a pre-ready close is a failed connect); if
   * it was ready and `error` is set, only `closed` rejects; otherwise `closed`
   * resolves with `info` (defaulting to code 0 / empty reason). It then rejects
   * every pending open and write, resolves every pending datagram ack to false,
   * signals a reset (code 0) to all receive sinks and STOP_SENDING (code 0) to
   * all send sinks, clears the bookkeeping maps, and finally shuts down the
   * transport.
   */
  finish(info, error) {
    if (this.closedState) return;
    this.closedState = true;
    if (error) this.failedState = true;
    this.draining.resolve();
    if (!this.readyState) {
      const err2 = error ?? new WebTransportError("session closed before it was established", {
        source: "session"
      });
      this.ready.reject(err2);
      this.closed.reject(err2);
    } else if (error) {
      this.closed.reject(error);
    } else {
      this.closed.resolve(info ?? { closeCode: 0, reason: "" });
    }
    const err = error ?? new WebTransportError("session closed", { source: "session" });
    for (const d of this.opens.values()) d.reject(err);
    for (const d of this.writes.values()) d.reject(err);
    for (const d of this.datagramAcks.values()) d.resolve(false);
    for (const d of this.statsRequests.values()) d.reject(err);
    for (const d of this.keyingMaterialRequests.values()) d.reject(err);
    for (const sink of this.receives.values()) sink.onSessionClose(err);
    for (const sink of this.sends.values()) sink.onSessionClose(err);
    this.opens.clear();
    this.writes.clear();
    this.datagramAcks.clear();
    this.statsRequests.clear();
    this.keyingMaterialRequests.clear();
    this.receives.clear();
    this.sends.clear();
    this.transport?.shutdown();
  }
  /** @returns Whether the session has reached its terminal closed state. */
  get isClosed() {
    return this.closedState;
  }
  /** @returns Whether the session has been established (ready). */
  get isReady() {
    return this.readyState;
  }
  /** @returns The negotiated subprotocol, or `''` if none was negotiated. */
  get protocol() {
    return this.cachedProtocol;
  }
  /** @returns The CONNECT response headers as ordered `[name, value]` pairs. */
  get responseHeaders() {
    return this.cachedResponseHeaders;
  }
};
var ClientTransport = class {
  /**
   * @param native - The loaded native addon.
   * @param handle - The client session handle these commands target.
   */
  constructor(native, handle) {
    this.native = native;
    this.handle = handle;
  }
  native;
  handle;
  /**
   * @param bidi - True for bidirectional, false for unidirectional.
   * @param requestId - Id correlating the eventual `streamOpened` event.
   */
  openStream(bidi, requestId) {
    this.native.openStream(this.handle, bidi, requestId);
  }
  /**
   * @param streamId - The target stream id.
   * @param bytes - The payload.
   * @param requestId - Id correlating the eventual `writeAck` event.
   */
  write(streamId, bytes, requestId) {
    this.native.writeStream(this.handle, streamId, bytes, requestId);
  }
  /** @param streamId - The stream to finish. */
  fin(streamId) {
    this.native.finStream(this.handle, streamId);
  }
  /**
   * @param streamId - The stream to reset.
   * @param code - The application error code.
   */
  reset(streamId, code) {
    this.native.resetStream(this.handle, streamId, code);
  }
  /**
   * @param streamId - The stream whose inbound half should be stopped.
   * @param code - The application error code.
   */
  stopSending(streamId, code) {
    this.native.stopSending(this.handle, streamId, code);
  }
  /**
   * @param streamId - The receive stream.
   * @param paused - True to pause draining, false to resume.
   */
  setPaused(streamId, paused) {
    this.native.setPaused(this.handle, streamId, paused);
  }
  /**
   * @param bytes - The datagram payload.
   * @param requestId - Id correlating the eventual `datagramAck` event.
   */
  sendDatagram(bytes, requestId) {
    this.native.sendDatagram(this.handle, bytes, requestId);
  }
  /** @returns The maximum datagram payload size, in bytes. */
  maxDatagramSize() {
    return this.native.maxDatagramSize(this.handle);
  }
  /**
   * @param code - The WebTransport close code.
   * @param reason - The UTF-8 encoded close reason.
   */
  closeSession(code, reason) {
    this.native.closeSession(this.handle, code, reason);
  }
  /** Send a DRAIN_WEBTRANSPORT_SESSION capsule to the peer. */
  drain() {
    this.native.drain(this.handle);
  }
  /** Request connection stats; the result arrives as a `stats` event. */
  getStats(requestId) {
    this.native.getStats(this.handle, requestId);
  }
  /** Export TLS keying material; the result arrives as a `keyingMaterial` event. */
  exportKeyingMaterial(requestId, label, context, length) {
    this.native.exportKeyingMaterial(this.handle, requestId, label, context, length);
  }
  /** Tear down the session's native driver thread. */
  shutdown() {
    this.native.shutdown(this.handle);
  }
};
function createClientSession(config) {
  const native = loadNative();
  const core = new SessionCore();
  try {
    const handle = native.connect(
      config.url,
      config.hashes,
      config.insecure,
      config.origin,
      config.headerNames,
      config.headerValues,
      config.protocols,
      (ev) => core.dispatch(ev)
    );
    core.attach(new ClientTransport(native, handle));
  } catch (e) {
    core.failSetup(e instanceof Error ? e.message : String(e));
  }
  return core;
}
var ServerTransport = class {
  /**
   * @param native - The loaded native addon.
   * @param handle - The server handle these commands target.
   * @param session - The id of the session these commands act on.
   */
  constructor(native, handle, session) {
    this.native = native;
    this.handle = handle;
    this.session = session;
  }
  native;
  handle;
  session;
  /**
   * @param bidi - True for bidirectional, false for unidirectional.
   * @param requestId - Id correlating the eventual `streamOpened` event.
   */
  openStream(bidi, requestId) {
    this.native.serverOpenStream(this.handle, this.session, bidi, requestId);
  }
  /**
   * @param streamId - The target stream id.
   * @param bytes - The payload.
   * @param requestId - Id correlating the eventual `writeAck` event.
   */
  write(streamId, bytes, requestId) {
    this.native.serverWrite(this.handle, this.session, streamId, bytes, requestId);
  }
  /** @param streamId - The stream to finish. */
  fin(streamId) {
    this.native.serverFin(this.handle, this.session, streamId);
  }
  /**
   * @param streamId - The stream to reset.
   * @param code - The application error code.
   */
  reset(streamId, code) {
    this.native.serverReset(this.handle, this.session, streamId, code);
  }
  /**
   * @param streamId - The stream whose inbound half should be stopped.
   * @param code - The application error code.
   */
  stopSending(streamId, code) {
    this.native.serverStopSending(this.handle, this.session, streamId, code);
  }
  /**
   * @param streamId - The receive stream.
   * @param paused - True to pause draining, false to resume.
   */
  setPaused(streamId, paused) {
    this.native.serverSetPaused(this.handle, this.session, streamId, paused);
  }
  /**
   * @param bytes - The datagram payload.
   * @param requestId - Id correlating the eventual `datagramAck` event.
   */
  sendDatagram(bytes, requestId) {
    this.native.serverSendDatagram(this.handle, this.session, bytes, requestId);
  }
  /** @returns The maximum datagram payload size, in bytes. */
  maxDatagramSize() {
    return this.native.serverMaxDatagramSize(this.handle);
  }
  /**
   * @param code - The WebTransport close code.
   * @param reason - The UTF-8 encoded close reason.
   */
  closeSession(code, reason) {
    this.native.serverCloseSession(this.handle, this.session, code, reason);
  }
  /** Send a DRAIN_WEBTRANSPORT_SESSION capsule to this session's peer. */
  drain() {
    this.native.serverDrain(this.handle, this.session);
  }
  /** Request this session's connection stats; the result arrives as a `stats` event. */
  getStats(requestId) {
    this.native.serverGetStats(this.handle, this.session, requestId);
  }
  /** Export TLS keying material; the result arrives as a `keyingMaterial` event. */
  exportKeyingMaterial(requestId, label, context, length) {
    this.native.serverExportKeyingMaterial(
      this.handle,
      this.session,
      requestId,
      label,
      context,
      length
    );
  }
  /**
   * No-op: the server driver owns the session lifecycle, so there is nothing to
   * tear down per session on the JS side.
   */
  shutdown() {
  }
};

// src/datagrams.ts
var WebTransportDatagramDuplexStream = class {
  /**
   * The underlying session used to send datagrams, register the inbound sink,
   * query the maximum datagram size, and observe session closure.
   *
   * @internal
   */
  session;
  /**
   * Stream of inbound datagrams. Each chunk is one received datagram payload.
   * Backed by a {@link CountQueuingStrategy} whose high water mark is the
   * value of {@link incomingHighWaterMark} captured when this instance was
   * constructed. The stream is closed automatically when the session ends.
   */
  readable;
  /**
   * Stream for sending outbound datagrams. Writing a chunk forwards it to
   * {@link SessionCore.sendDatagram}, whose boolean result (whether the
   * datagram was actually transmitted rather than dropped) is discarded, so
   * that `write()` resolves once the native transport reports back on the
   * send attempt. Backed by a {@link CountQueuingStrategy} whose high water
   * mark is the value of {@link outgoingHighWaterMark} captured when this
   * instance was constructed.
   */
  writable;
  /**
   * High water mark (in datagrams) for the inbound `readable` queue. Read
   * back through {@link incomingHighWaterMark}. Only the value present at
   * construction time is applied to the actual {@link readable} strategy;
   * later changes update the reported number but do not resize the live
   * queue.
   *
   * @defaultValue 64
   * @internal
   */
  incomingHwm = 64;
  /**
   * High water mark (in datagrams) for the outbound `writable` queue. Read
   * back through {@link outgoingHighWaterMark}. Only the value present at
   * construction time is applied to the actual {@link writable} strategy;
   * later changes update the reported number but do not resize the live
   * queue.
   *
   * @defaultValue 64
   * @internal
   */
  outgoingHwm = 64;
  /**
   * Max age (ms) an inbound datagram is retained before being dropped, or
   * `null` for no limit.
   *
   * @remarks
   * Present to match the WHATWG interface. This class stores the value but
   * does not currently enforce it: inbound loss here is driven only by the
   * `readable` queue being full, not by datagram age.
   *
   * @defaultValue null
   */
  incomingMaxAge = null;
  /**
   * Max age (ms) an outbound datagram waits to be sent before being dropped,
   * or `null` for no limit.
   *
   * @remarks
   * Present to match the WHATWG interface. This class stores the value but
   * does not currently enforce it; outbound loss is governed by the
   * `writable` queue backpressure and the native QUIC layer.
   *
   * @defaultValue null
   */
  outgoingMaxAge = null;
  /**
   * Build the datagram duplex stream over a session.
   *
   * @param session - The session that carries the datagrams. Its
   * {@link SessionCore.setDatagramSink} is used to receive inbound datagrams,
   * {@link SessionCore.sendDatagram} to send them, and its
   * {@link SessionCore.closed} promise to know when to close the inbound
   * stream.
   *
   * @remarks
   * Wiring performed here, in order:
   *
   * 1. Creates {@link readable} and captures its controller from `start`.
   * 2. Installs a datagram sink that enqueues each received datagram only
   *    while the controller's `desiredSize` is positive (treating an unknown
   *    `desiredSize` of `null` as `1`, i.e. room available); datagrams that
   *    arrive when the queue is full are dropped.
   * 3. Subscribes to the session's `closed` promise so the inbound stream is
   *    closed on both clean close and error, preventing a pending `read()`
   *    from hanging forever. A double-close is swallowed.
   * 4. Creates {@link writable} whose `write` forwards each chunk to
   *    `session.sendDatagram` and maps the boolean ack to `undefined`.
   */
  constructor(session) {
    this.session = session;
    let rController;
    this.readable = new ReadableStream(
      {
        start(c) {
          rController = c;
        }
      },
      new CountQueuingStrategy({ highWaterMark: this.incomingHwm })
    );
    session.setDatagramSink((data) => {
      if ((rController.desiredSize ?? 1) > 0) {
        rController.enqueue(data);
      } else {
        session.recordDroppedIncomingDatagram();
      }
    });
    void session.closed.promise.then(
      () => {
        try {
          rController.close();
        } catch {
        }
      },
      () => {
        try {
          rController.close();
        } catch {
        }
      }
    );
    this.writable = new WritableStream(
      {
        write: (chunk) => session.sendDatagram(chunk).then(() => void 0)
      },
      new CountQueuingStrategy({ highWaterMark: this.outgoingHwm })
    );
  }
  /**
   * The largest datagram payload that currently fits in a single packet.
   *
   * @returns The maximum datagram payload size in bytes as reported by the
   * native transport, or `0` when the session has no transport attached yet.
   * The value can change over the life of the session as the path MTU is
   * discovered.
   */
  get maxDatagramSize() {
    return this.session.maxDatagramSize();
  }
  /**
   * The high water mark (in datagrams) reported for the inbound `readable`
   * queue.
   *
   * @returns The most recently set incoming high water mark.
   */
  get incomingHighWaterMark() {
    return this.incomingHwm;
  }
  /**
   * Set the reported inbound high water mark.
   *
   * @param value - Desired high water mark; coerced to an integer with
   * `value | 0` and clamped to a minimum of `1`.
   *
   * @remarks
   * This updates only the number returned by {@link incomingHighWaterMark}.
   * The live {@link readable} queue keeps the strategy fixed at construction
   * time, so changing this after construction does not resize it.
   */
  set incomingHighWaterMark(value) {
    this.incomingHwm = Math.max(1, value | 0);
  }
  /**
   * The high water mark (in datagrams) reported for the outbound `writable`
   * queue.
   *
   * @returns The most recently set outgoing high water mark.
   */
  get outgoingHighWaterMark() {
    return this.outgoingHwm;
  }
  /**
   * Set the reported outbound high water mark.
   *
   * @param value - Desired high water mark; coerced to an integer with
   * `value | 0` and clamped to a minimum of `1`.
   *
   * @remarks
   * This updates only the number returned by {@link outgoingHighWaterMark}.
   * The live {@link writable} queue keeps the strategy fixed at construction
   * time, so changing this after construction does not resize it.
   */
  set outgoingHighWaterMark(value) {
    this.outgoingHwm = Math.max(1, value | 0);
  }
};

// src/streams.ts
function errorCode(reason) {
  if (reason instanceof WebTransportError && reason.streamErrorCode != null) {
    return reason.streamErrorCode >>> 0;
  }
  return 0;
}
var WebTransportReceiveStream = class extends ReadableStream {
  /**
   * The QUIC stream id of the underlying stream. Stable for the lifetime of the
   * stream and shared with the paired {@link WebTransportSendStream} when this is
   * one half of a {@link WebTransportBidirectionalStream}.
   */
  streamId;
  /**
   * Wire a `ReadableStream` up to a native receive stream.
   *
   * @param session - The session core that dispatches native events and issues
   *   flow-control and teardown commands for this stream.
   * @param streamId - The QUIC stream id to receive from.
   * @remarks Installs the `ReadableStream` underlying source and registers a
   *   {@link ReceiveSink} on `session` for `streamId`:
   *
   *   - `pull` unpauses the native stream via `setPaused(streamId, false)`, so
   *     quiche resumes draining inbound bytes when the consumer wants more.
   *   - `cancel(reason)` sends `STOP_SENDING` to the peer with the code from
   *     {@link errorCode} and then unregisters the receive sink.
   *   - The sink's `onData` enqueues each chunk and, once the controller's
   *     `desiredSize` falls to zero or below (a nullish `desiredSize` is treated as
   *     `1`, so it does not pause), pauses the native stream to flow-control the
   *     peer.
   *   - The sink's `onFin` closes the controller (swallowing the error if it was
   *     already closed or errored) and unregisters.
   *   - The sink's `onReset(code)` errors the controller with a `'stream'`-sourced
   *     {@link WebTransportError} ('stream reset by peer') carrying the peer's code,
   *     then unregisters.
   *
   *   A {@link CountQueuingStrategy} with a high-water mark of 32 chunks bounds the
   *   JS-side queue and thereby the pause threshold.
   */
  constructor(session, streamId) {
    let controller;
    super(
      {
        start(c) {
          controller = c;
        },
        pull() {
          session.setPaused(streamId, false);
        },
        cancel(reason) {
          session.stopSending(streamId, errorCode(reason));
          session.unregisterReceive(streamId);
        }
      },
      new CountQueuingStrategy({ highWaterMark: 32 })
    );
    session.registerReceive(streamId, {
      onData(chunk) {
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 1) <= 0) {
          session.setPaused(streamId, true);
        }
      },
      onFin() {
        try {
          controller.close();
        } catch {
        }
        session.unregisterReceive(streamId);
      },
      onReset(code) {
        controller.error(
          new WebTransportError("stream reset by peer", {
            source: "stream",
            streamErrorCode: code
          })
        );
        session.unregisterReceive(streamId);
      },
      onSessionClose(error) {
        try {
          controller.error(error);
        } catch {
        }
        session.unregisterReceive(streamId);
      }
    });
    this.streamId = streamId;
  }
};
var WebTransportSendGroup = class {
};
var WebTransportSendStream = class extends WritableStream {
  /**
   * The QUIC stream id of the underlying stream. Stable for the lifetime of the
   * stream and shared with the paired {@link WebTransportReceiveStream} when this is
   * one half of a {@link WebTransportBidirectionalStream}.
   */
  streamId;
  /**
   * The {@link WebTransportSendGroup} this stream belongs to, or `null`.
   * Mutable per the W3C API; grouping is a best-effort scheduling hint.
   */
  sendGroup;
  /**
   * Relative send priority within the send group. Higher values are nominally
   * sent first. Mutable per the W3C API; the effect on the wire is best-effort.
   */
  sendOrder;
  /**
   * Wire a `WritableStream` up to a native send stream.
   *
   * @param session - The session core that dispatches native events and issues
   *   write, FIN, reset, and teardown commands for this stream.
   * @param streamId - The QUIC stream id to send on.
   * @remarks Installs the `WritableStream` underlying sink and registers a
   *   {@link SendSink} on `session` for `streamId`:
   *
   *   - `write(chunk)` forwards to `session.write` and returns its promise, which
   *     settles only once the bytes are accepted into quiche's send buffer; awaiting
   *     that promise is what applies end-to-end backpressure.
   *   - `close` sends a FIN via `finStream` and unregisters the send sink.
   *   - `abort(reason)` resets the stream via `resetStream` with the code from
   *     {@link errorCode} and unregisters the send sink.
   *   - The sink's `onStopSending(code)` errors the controller with a
   *     `'stream'`-sourced {@link WebTransportError} ('peer sent STOP_SENDING')
   *     carrying the peer's code (swallowing the error if the stream was already
   *     errored or closed) and unregisters.
   *
   *   A {@link ByteLengthQueuingStrategy} with a high-water mark of 1 MiB
   *   (`1024 * 1024` bytes) bounds the JS-side write queue.
   */
  constructor(session, streamId, options = {}) {
    let controller;
    super(
      {
        start(c) {
          controller = c;
        },
        write(chunk) {
          return session.write(streamId, chunk);
        },
        close() {
          session.finStream(streamId);
          session.unregisterSend(streamId);
        },
        abort(reason) {
          session.resetStream(streamId, errorCode(reason));
          session.unregisterSend(streamId);
        }
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 })
    );
    session.registerSend(streamId, {
      onStopSending(code) {
        try {
          controller.error(
            new WebTransportError("peer sent STOP_SENDING", {
              source: "stream",
              streamErrorCode: code
            })
          );
        } catch {
        }
        session.unregisterSend(streamId);
      },
      onSessionClose(error) {
        try {
          controller.error(error);
        } catch {
        }
        session.unregisterSend(streamId);
      }
    });
    this.streamId = streamId;
    this.sendGroup = options.sendGroup ?? null;
    this.sendOrder = options.sendOrder ?? 0;
  }
};
var WebTransportBidirectionalStream = class {
  /** The readable half, delivering bytes the peer sends on this stream. */
  readable;
  /** The writable half, sending bytes to the peer on this stream. */
  writable;
  /**
   * Construct both halves over the same QUIC stream.
   *
   * @param session - The session core backing both halves.
   * @param streamId - The QUIC stream id shared by the readable and writable halves.
   */
  constructor(session, streamId, options = {}) {
    this.readable = new WebTransportReceiveStream(session, streamId);
    this.writable = new WebTransportSendStream(session, streamId, options);
  }
};

// src/webtransport.ts
function toBytes(src) {
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}
function buildConfig(url, options) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new WebTransportError(`invalid WebTransport URL: ${url}`, { source: "session" });
  }
  const hashes = [];
  for (const hash of options.serverCertificateHashes ?? []) {
    const algorithm = hash.algorithm.toLowerCase();
    if (algorithm !== "sha-256") {
      throw new WebTransportError(
        `unsupported certificate hash algorithm: ${hash.algorithm} (only sha-256)`,
        { source: "session" }
      );
    }
    const bytes = toBytes(hash.value);
    if (bytes.byteLength !== 32) {
      throw new WebTransportError("sha-256 certificate hash must be 32 bytes", {
        source: "session"
      });
    }
    hashes.push(bytes);
  }
  const headerNames = [];
  const headerValues = [];
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headerNames.push(name);
    headerValues.push(value);
  }
  return {
    url,
    hashes,
    insecure: options.insecure ?? false,
    origin: options.origin ?? null,
    headerNames,
    headerValues,
    protocols: options.protocols ?? []
  };
}
var WebTransportSession = class {
  /**
   * The event dispatcher and command surface backing this session. Shared with
   * the datagram and stream wrappers so they can issue native commands and
   * register their inbound sinks. Protected so the server-side subclass can
   * reach it while it stays hidden from public API consumers.
   * @internal
   */
  core;
  /**
   * The session's datagram transport: a {@link WebTransportDatagramDuplexStream}
   * whose `readable` yields inbound datagrams and `writable` sends them.
   * Datagrams are unreliable and unordered; ones that do not fit the queue are
   * dropped rather than buffered.
   */
  datagrams;
  /**
   * A `ReadableStream` that yields a {@link WebTransportBidirectionalStream} for
   * every bidirectional stream the peer opens. Fed by the core's incoming
   * handler; it closes when the session closes cleanly and errors if the
   * session terminates abnormally.
   */
  incomingBidirectionalStreams;
  /**
   * A `ReadableStream` that yields a receive-only
   * {@link WebTransportReceiveStream} for every unidirectional stream the peer
   * opens. Fed by the core's incoming handler; it closes on clean session close
   * and errors on abnormal termination.
   */
  incomingUnidirectionalStreams;
  /**
   * Guards {@link WebTransportSession.close} so that repeated calls are no-ops
   * and the native close is issued at most once.
   * @internal
   */
  closeCalled = false;
  /**
   * Wire up the session surface around an existing {@link SessionCore}.
   *
   * @param core - The event dispatcher and command core for this session. For
   * the client this is a freshly connected client session; for the server it is
   * a session-scoped core created by the server driver.
   * @remarks Creates the {@link WebTransportSession.datagrams} duplex, then
   * constructs the two incoming-stream `ReadableStream`s and captures their
   * controllers via the `start` callback. Registers an incoming handler on
   * `core` so each peer-opened bidi/uni stream is wrapped and enqueued;
   * `enqueue` is wrapped in try/catch because it throws once the consumer has
   * cancelled the reader, and that error must not escape native event dispatch.
   * Finally it observes `core.closed`: on clean close both controllers are
   * closed via {@link safeClose}, and on rejection both are errored with the
   * failure reason via {@link safeError}.
   */
  constructor(core) {
    this.core = core;
    this.datagrams = new WebTransportDatagramDuplexStream(core);
    let bidiController;
    let uniController;
    this.incomingBidirectionalStreams = new ReadableStream({
      start: (c) => {
        bidiController = c;
      }
    }, new CountQueuingStrategy({ highWaterMark: 256 }));
    this.incomingUnidirectionalStreams = new ReadableStream({
      start: (c) => {
        uniController = c;
      }
    }, new CountQueuingStrategy({ highWaterMark: 256 }));
    core.setIncomingHandler({
      onBidi: (id) => {
        if ((bidiController.desiredSize ?? 0) <= 0) {
          this.close({ closeCode: 257, reason: "incoming stream capacity exceeded" });
          return;
        }
        try {
          bidiController.enqueue(new WebTransportBidirectionalStream(core, id));
        } catch {
        }
      },
      onUni: (id) => {
        if ((uniController.desiredSize ?? 0) <= 0) {
          this.close({ closeCode: 257, reason: "incoming stream capacity exceeded" });
          return;
        }
        try {
          uniController.enqueue(new WebTransportReceiveStream(core, id));
        } catch {
        }
      }
    });
    core.closed.promise.then(
      () => {
        safeClose(bidiController);
        safeClose(uniController);
      },
      (err) => {
        safeError(bidiController, err);
        safeError(uniController, err);
      }
    );
  }
  /**
   * A promise that resolves once the session handshake completes and the
   * session is established, and rejects if the session fails or closes before
   * it becomes ready.
   * @returns The core's `ready` promise.
   */
  get ready() {
    return this.core.ready.promise;
  }
  /**
   * A promise that resolves with the {@link WebTransportCloseInfo} (close code
   * and reason) when the session ends cleanly, and rejects with a
   * {@link WebTransportError} on abnormal termination or if the session never
   * became ready.
   * @returns The core's `closed` promise.
   */
  get closed() {
    return this.core.closed.promise;
  }
  /**
   * A promise that resolves when the peer signals it is draining the session
   * (a `DRAIN_WEBTRANSPORT_SESSION` capsule): it intends to close soon, so you
   * should stop opening new streams, but the session and its existing streams
   * stay usable until {@link closed}. Never rejects.
   * @returns The core's `draining` promise.
   */
  get draining() {
    return this.core.draining.promise;
  }
  /**
   * The reliability modes this session supports. `'pending'` until the session
   * is established, then `'supports-unreliable'` because this transport always
   * offers both reliable streams and unreliable datagrams.
   */
  get reliability() {
    return this.core.isReady ? "supports-unreliable" : "pending";
  }
  /**
   * The negotiated WebTransport subprotocol, or the empty string when none was
   * negotiated (or before the session is established). Matches the W3C
   * `WebTransport.protocol` attribute.
   */
  get protocol() {
    return this.core.protocol;
  }
  /**
   * Open a new outbound bidirectional stream.
   *
   * @returns A promise resolving to a {@link WebTransportBidirectionalStream}
   * (paired readable and writable halves) once the native side reports the new
   * stream id.
   * @throws WebTransportError (the returned promise rejects) if the session is
   * already closed or was never attached.
   */
  async createBidirectionalStream(options = {}) {
    const id = await this.core.openStream(true);
    return new WebTransportBidirectionalStream(this.core, id, options);
  }
  /**
   * Open a new outbound unidirectional (send-only) stream.
   *
   * @returns A promise resolving to a {@link WebTransportSendStream} once the
   * native side reports the new stream id.
   * @throws WebTransportError (the returned promise rejects) if the session is
   * already closed or was never attached.
   */
  async createUnidirectionalStream(options = {}) {
    const id = await this.core.openStream(false);
    return new WebTransportSendStream(this.core, id, options);
  }
  /**
   * Create a {@link WebTransportSendGroup} for scheduling several streams'
   * sends relative to one another via each stream's `sendOrder`.
   */
  createSendGroup() {
    return new WebTransportSendGroup();
  }
  /**
   * Close the session gracefully, notifying the peer with an application code
   * and reason.
   *
   * @param closeInfo - Close options. `closeInfo.closeCode` defaults to `0` and
   * `closeInfo.reason` defaults to `''`; both are forwarded to the native
   * close.
   * @defaultValue `closeInfo` defaults to `{}` (close code `0`, empty reason).
   * @remarks Idempotent: guarded by {@link WebTransportSession.closeCalled} so
   * only the first call takes effect and later calls are no-ops. Delegates to
   * the core, which issues the native `closeSession` (a graceful
   * CLOSE_WEBTRANSPORT_SESSION capsule plus FIN, then QUIC close) only while the
   * session is still attached and not already closed.
   */
  close(closeInfo = {}) {
    if (this.closeCalled) return;
    this.closeCalled = true;
    this.core.close(closeInfo.closeCode ?? 0, closeInfo.reason ?? "");
  }
  /**
   * Tell the peer this session is draining by sending a
   * `DRAIN_WEBTRANSPORT_SESSION` capsule: a graceful signal that you intend to
   * stop using it soon, while the session and its streams stay open until
   * {@link close}. The peer observes this through its {@link draining} promise.
   * A Node extension beyond the W3C API, useful for a server shedding load.
   */
  drain() {
    this.core.drain();
  }
  /**
   * Snapshot connection statistics (bytes and packets transferred, RTT, and
   * datagram counters).
   * @returns A promise resolving to {@link WebTransportConnectionStats}.
   * @throws WebTransportError (the promise rejects) if the session is closed.
   */
  getStats() {
    return this.core.getStats();
  }
  /**
   * Export keying material from the session's TLS connection (RFC 5705),
   * matching the W3C `exportKeyingMaterial`. Both endpoints derive identical
   * bytes for the same `label`, `context`, and `outputLength`, and nothing
   * outside the TLS session can reproduce them, which makes the result
   * suitable for channel binding.
   *
   * @param label - The exporter label, a {@link BinarySource}.
   * @param context - The exporter context, a {@link BinarySource}; pass an
   *   empty buffer for no application context.
   * @param outputLength - Number of bytes of keying material to produce.
   * @returns A promise resolving to a `Uint8Array` of `outputLength` bytes.
   * @throws WebTransportError (the promise rejects) if the session is closed or
   *   the TLS export fails (for example, before the handshake completes).
   */
  exportKeyingMaterial(label, context, outputLength) {
    return this.core.exportKeyingMaterial(toBytes(label), toBytes(context), outputLength);
  }
};
var WebTransport = class extends WebTransportSession {
  /**
   * Create and begin connecting a WebTransport client session.
   *
   * @param url - The session URL; must be an `https://` URL.
   * @param options - Session options: certificate pinning, extra headers,
   * origin, and the Node-specific `insecure` flag.
   * @defaultValue `options` defaults to `{}`.
   * @throws WebTransportError synchronously if {@link buildConfig} rejects the
   * URL or a certificate hash. Asynchronous setup failures (DNS, bind,
   * handshake) instead reject {@link WebTransportSession.ready | ready} and
   * {@link WebTransportSession.closed | closed}.
   * @remarks Validates and normalizes inputs via {@link buildConfig}, then
   * calls {@link createClientSession} to spawn the native driver thread and
   * passes the resulting {@link SessionCore} to the base constructor.
   */
  constructor(url, options = {}) {
    super(createClientSession(buildConfig(url, options)));
  }
  /**
   * The headers from the server's Extended CONNECT `2xx` response, as a
   * `Headers` object (empty until the session is established). Matches the W3C
   * `WebTransport.responseHeaders` attribute.
   */
  get responseHeaders() {
    return new Headers(this.core.responseHeaders);
  }
};
function safeClose(controller) {
  try {
    controller.close();
  } catch {
  }
}
function safeError(controller, reason) {
  try {
    controller.error(reason);
  } catch {
  }
}

// src/server.ts
function deferred2() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
var WebTransportServerSession = class extends WebTransportSession {
  /** The `:authority` of the client's CONNECT request. */
  authority;
  /** The `:path` of the client's CONNECT request. */
  path;
  /** The `origin` header, if the client sent one, otherwise `null`. */
  origin;
  /** Any additional (non-pseudo) request headers, keyed by header name. */
  headers;
  /** The subprotocols the client offered in `wt-available-protocols`. */
  requestedProtocols;
  /**
   * The client's remote IP address, as reported by the transport when the
   * session was established. The same for every stream and datagram on this
   * session, since they all share the one QUIC connection.
   */
  remoteAddress;
  /** The client's remote UDP port at session establishment. */
  remotePort;
  /**
   * Wrap an established session core together with the CONNECT metadata that
   * opened it. Called by {@link WebTransportServer} when a new session becomes
   * ready; not intended for direct construction by users.
   *
   * @param core - The dispatcher/command core backing this session, already
   *   attached to a {@link ServerTransport}.
   * @param request - The CONNECT metadata (authority, path, origin, headers)
   *   plus the client's remote address, copied onto this session's public fields.
   */
  constructor(core, request) {
    super(core);
    this.authority = request.authority;
    this.path = request.path;
    this.origin = request.origin;
    this.headers = request.headers;
    this.requestedProtocols = request.requestedProtocols;
    this.remoteAddress = request.remoteAddress;
    this.remotePort = request.remotePort;
  }
};
var WebTransportServer = class {
  /** The loaded native addon, source of the `server*` command functions. */
  native;
  /** Opaque native server handle returned by `serverListen`. */
  handle;
  /** Live sessions keyed by their native session id, for event routing. */
  sessions = /* @__PURE__ */ new Map();
  /** Settled when the native side reports `listening`; backs {@link ready}. */
  readyD = deferred2();
  /**
   * Settled when the server stops (`serverClosed`) or fatally fails
   * (`serverError`); backs {@link closed}.
   */
  closedD = deferred2();
  /** Controller for {@link incomingSessions}; captured in its `start`. */
  incomingController;
  /** The UDP port actually bound, learned from the `listening` event. */
  boundPort = 0;
  /** Guards {@link close} so shutdown is issued at most once. */
  closeCalled = false;
  /**
   * The sessions clients open, delivered as they are established. Each pull
   * yields a {@link WebTransportServerSession}. The stream is closed when the
   * server stops or errors.
   */
  incomingSessions;
  /**
   * Load the native addon and start listening immediately.
   *
   * Sets up {@link incomingSessions} (capturing its controller), attaches
   * no-op catch handlers to the internal ready/closed promises so they never
   * surface as unhandled rejections, then calls the native `serverListen` with
   * the given certificate, key, host, port and reuse-port flag, wiring every
   * native event to {@link onEvent}.
   *
   * @param options - Bind address, port, certificate/key paths and reuse-port
   *   flag. `host` defaults to `'0.0.0.0'` and `reusePort` defaults to `false`.
   * @see {@link ready} to await binding and {@link WebTransportServerOptions}.
   */
  constructor(options) {
    this.native = loadNative();
    void this.readyD.promise.catch(() => {
    });
    void this.closedD.promise.catch(() => {
    });
    this.incomingSessions = new ReadableStream({
      start: (c) => {
        this.incomingController = c;
      }
    }, new CountQueuingStrategy({ highWaterMark: 1024 }));
    const responseHeaderNames = [];
    const responseHeaderValues = [];
    for (const [name, value] of Object.entries(options.responseHeaders ?? {})) {
      responseHeaderNames.push(name);
      responseHeaderValues.push(value);
    }
    this.handle = this.native.serverListen(
      options.cert,
      options.key,
      options.host ?? "0.0.0.0",
      options.port,
      options.reusePort ?? false,
      options.supportedProtocols ?? [],
      options.allowedOrigins ?? null,
      responseHeaderNames,
      responseHeaderValues,
      (ev) => this.onEvent(ev)
    );
  }
  /**
   * Resolves once the server is listening (the native `listening` event has
   * arrived); rejects if the server fails before it binds.
   */
  get ready() {
    return this.readyD.promise;
  }
  /**
   * Resolves when the server has stopped cleanly (`serverClosed`), rejects on
   * a fatal server error (`serverError`).
   */
  get closed() {
    return this.closedD.promise;
  }
  /** The UDP port the server is bound to (valid after {@link ready}). */
  get port() {
    return this.boundPort;
  }
  /**
   * Stop the server and all its sessions. Idempotent: repeated calls after the
   * first are ignored. Triggers the native `serverShutdown`, which eventually
   * drives a `serverClosed` event that settles {@link closed} and finishes any
   * remaining sessions.
   */
  close() {
    if (this.closeCalled) return;
    this.closeCalled = true;
    this.native.serverShutdown(this.handle);
  }
  /**
   * Handle one native server event. Server-level events (`listening`,
   * `serverError`, `serverClosed`) settle the server's ready/closed promises
   * and, on stop or error, finish all sessions and close
   * {@link incomingSessions}. Session-scoped events carry a `session` id: a
   * `serverReady` creates and registers a new {@link SessionCore} (attached to
   * a {@link ServerTransport}), wraps it in a {@link WebTransportServerSession}
   * and enqueues it; every session-scoped event is then dispatched to the
   * matching core.
   *
   * @param ev - The event delivered by the native `serverListen` callback.
   * @remarks Enqueue into {@link incomingSessions} is guarded: if the consumer
   *   has stopped reading, the thrown error is swallowed so it cannot escape
   *   the native event dispatch. On `serverError`, the `WebTransportError` is
   *   created with `source: 'session'`.
   */
  onEvent(ev) {
    switch (ev.type) {
      case "listening" /* Listening */: {
        this.boundPort = ev.port;
        this.readyD.resolve();
        return;
      }
      case "serverError" /* ServerError */: {
        const err = new WebTransportError(ev.message, { source: "session" });
        this.readyD.reject(err);
        this.closedD.reject(err);
        this.finishAllSessions();
        safeCloseController(this.incomingController);
        return;
      }
      case "serverClosed" /* ServerClosed */: {
        this.closedD.resolve();
        this.finishAllSessions();
        safeCloseController(this.incomingController);
        return;
      }
    }
    const sessionId = ev.session;
    if (ev.type === "serverReady" /* ServerReady */) {
      if ((this.incomingController.desiredSize ?? 0) <= 0) {
        this.native.serverCloseSession(this.handle, sessionId, 257, new TextEncoder().encode("incoming session capacity exceeded"));
        return;
      }
      const core = new SessionCore();
      core.attach(new ServerTransport(this.native, this.handle, sessionId));
      this.sessions.set(sessionId, core);
      void core.closed.promise.then(() => this.sessions.delete(sessionId), () => this.sessions.delete(sessionId));
      const session = new WebTransportServerSession(core, {
        authority: ev.authority,
        path: ev.path,
        origin: ev.origin,
        headers: ev.headers,
        requestedProtocols: ev.requestedProtocols,
        protocol: ev.protocol,
        remoteAddress: ev.remoteAddress,
        remotePort: ev.remotePort
      });
      try {
        this.incomingController.enqueue(session);
      } catch {
      }
    }
    this.sessions.get(sessionId)?.dispatch(ev);
  }
  /**
   * Settle every live session when the server stops, so their `ready`/`closed`
   * promises never hang and the session map does not leak.
   *
   * @remarks Dispatches a synthetic clean `closed` event (code `0`, empty
   *   reason, `remote: false`) to each session core, then clears the map. The
   *   per-core `closed.finally` handler registered in {@link onEvent} would
   *   also remove entries, but the map is cleared here unconditionally.
   */
  finishAllSessions() {
    for (const core of this.sessions.values()) {
      core.dispatch({
        type: "closed" /* Closed */,
        code: 0,
        reason: new Uint8Array(),
        remote: false
      });
    }
    this.sessions.clear();
  }
};
function safeCloseController(controller) {
  try {
    controller.close();
  } catch {
  }
}
export {
  WebTransport,
  WebTransportBidirectionalStream,
  WebTransportDatagramDuplexStream,
  WebTransportError,
  WebTransportReceiveStream,
  WebTransportSendGroup,
  WebTransportSendStream,
  WebTransportServer,
  WebTransportServerSession,
  WebTransportSession
};
//! Locates and loads the rwebtransport native addon.
//!
//! Resolution order:
//!   1. A prebuilt binary at `prebuilds/<platform>-<arch>/rwebtransport.node`.
//!   2. If none is found, compile the Rust crate on the fly via `scripts/build.js`
//!      (requires a Rust toolchain + cmake + C/C++ compiler) and load the result.
//! Only Node 24 and Node 26 are supported.
//! The `WebTransportError` type, matching the W3C interface.
//! Typed view of the native addon and the event dispatcher that turns its
//! low-level, callback-based ABI into promises and per-stream sinks.
//! `WebTransportDatagramDuplexStream`: unreliable, unordered datagrams.
//! WebTransport stream classes, implemented as WHATWG Readable/Writable streams
//! with end-to-end backpressure onto the native QUIC flow-control window.
//! The `WebTransport` class: the W3C entry point.
//! The `WebTransportServer` accepts WebTransport sessions from clients. Each
//! established session is a {@link WebTransportServerSession}, which shares the
//! full stream/datagram surface with the client `WebTransport`.
//! rwebtransport: a fully-compatible WebTransport client and server for Node.js.
//! ```ts
//! import { WebTransport } from 'rwebtransport';
//! const wt = new WebTransport('https://example.com:4433/echo');
//! await wt.ready;
//! ```
