import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const driver = join(root, 'packages/driver-rwebtransport');
const require = createRequire(join(driver, 'package.json'));
const upstreamRoot = dirname(dirname(require.resolve('rwebtransport')));
const source = await readFile(join(upstreamRoot, 'dist/index.mjs'), 'utf8');
const digest = createHash('sha256').update(source).digest('hex');
assert.equal(
  digest,
  '21883683820cb299a9a4fb288b3ece4e7ffe2d93f04b430b6c04b5c9ea556e08',
  'Upstream rwebtransport source changed: review the compatibility patch before rebuilding',
);
const unsafeCleanup = 'void core.closed.promise.finally(() => this.sessions.delete(sessionId));';
assert.equal(source.split(unsafeCleanup).length, 2, 'Expected exactly one server cleanup site');
const patched = source
  .replace(
    'var PACKAGE_ROOT = join(moduleDir, "..");',
    'var PACKAGE_ROOT = dirname(dirname(require2.resolve("rwebtransport")));',
  )
  .replace(
    /\/\/ src\/errors.ts[\s\S]*?(?=\/\/ src\/native.ts)/,
    '// Share the public error identity with the upstream package.\nimport { WebTransportError } from "rwebtransport";\n\n',
  )
  .replace(
    unsafeCleanup,
    'void core.closed.promise.then(() => this.sessions.delete(sessionId), () => this.sessions.delete(sessionId));',
  )
  .replace(
    '  constructor(session, streamId, options = {}) {\n    let controller;\n',
    '  constructor(session, streamId, options = {}) {\n    let controller;\n    let closeRequested = false;\n',
  )
  .replace(
    '        close() {\n          session.finStream(streamId);',
    '        close() {\n          closeRequested = true;\n          session.finStream(streamId);',
  )
  .replace(
    '        abort(reason) {\n          session.resetStream(streamId, errorCode(reason));',
    '        abort(reason) {\n          closeRequested = true;\n          session.resetStream(streamId, errorCode(reason));',
  )
  .replace(
    '      onStopSending(code) {\n        try {\n          controller.error(',
    '      onStopSending(code) {\n        if (closeRequested) {\n          session.unregisterSend(streamId);\n          return;\n        }\n        try {\n          controller.error(',
  )
  .replace(
    '      onSessionClose(error) {\n        try {\n          controller.error(error);\n        } catch {\n        }\n        session.unregisterSend(streamId);\n      }\n    });\n    this.streamId = streamId;',
    '      onSessionClose(error) {\n        if (closeRequested) {\n          session.unregisterSend(streamId);\n          return;\n        }\n        try {\n          controller.error(error);\n        } catch {\n        }\n        session.unregisterSend(streamId);\n      }\n    });\n    this.streamId = streamId;',
  )
  .replace(
    /this.incomingBidirectionalStreams = new ReadableStream\(\{[\s\S]*?\n {4}\}\);/,
    (match) =>
      match.replace('    });', '    }, new CountQueuingStrategy({ highWaterMark: 256 }));'),
  )
  .replace(
    /this.incomingUnidirectionalStreams = new ReadableStream\(\{[\s\S]*?\n {4}\}\);/,
    (match) =>
      match.replace('    });', '    }, new CountQueuingStrategy({ highWaterMark: 256 }));'),
  )
  .replace(
    'onBidi: (id) => {',
    `onBidi: (id) => {
        if ((bidiController.desiredSize ?? 0) <= 0) {
          this.close({ closeCode: 257, reason: "incoming stream capacity exceeded" });
          return;
        }`,
  )
  .replace(
    'onUni: (id) => {',
    `onUni: (id) => {
        if ((uniController.desiredSize ?? 0) <= 0) {
          this.close({ closeCode: 257, reason: "incoming stream capacity exceeded" });
          return;
        }`,
  )
  .replace(/this.incomingSessions = new ReadableStream\(\{[\s\S]*?\n {4}\}\);/, (match) =>
    match.replace('    });', '    }, new CountQueuingStrategy({ highWaterMark: 1024 }));'),
  )
  .replace(
    'if (ev.type === "serverReady" /* ServerReady */) {',
    `if (ev.type === "serverReady" /* ServerReady */) {
      if ((this.incomingController.desiredSize ?? 0) <= 0) {
        this.native.serverCloseSession(this.handle, sessionId, 257, new TextEncoder().encode("incoming session capacity exceeded"));
        return;
      }`,
  )
  .replace(/^\/\/# sourceMappingURL=.*$/m, '');
const output = `// Generated from rwebtransport 0.2.2, SHA-256 ${digest}.
// Copyright 2026 Dacely Cloud. Apache-2.0; see LICENSE and NOTICE in this directory.
// Modified by nest-webtransport contributors: handle rejected session cleanup;
// bound incoming stream collections; resolve the dependency's binaries; preserve error identity.
// Regenerate with: node scripts/vendor-rwebtransport.mjs --write
${patched}`;
const target = join(driver, 'vendor/rwebtransport.mjs');
if (process.argv.includes('--write')) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, output);
  await writeFile(join(dirname(target), 'NOTICE'), await readFile(join(upstreamRoot, 'NOTICE')));
  await writeFile(join(dirname(target), 'rwebtransport.d.mts'), "export * from 'rwebtransport';\n");
} else {
  assert.equal(
    await readFile(target, 'utf8'),
    output,
    'Vendored adapter differs from the audited transformation',
  );
}
