import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import {
  OnBidirectionalStream,
  OnDatagram,
  OnSession,
  OnUnidirectionalStream,
  Payload,
  Session,
  Stream,
  WebTransportGateway,
  WebTransportHealthService,
  WebTransportModule,
} from 'nest-webtransport';
import { RWebTransportDriver } from 'webtransport-driver-rwebtransport';

export async function createTransportFixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nest-webtransport-tls-'));
  const certificate = join(directory, 'cert.pem');
  const key = join(directory, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-sha256',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-pkeyopt',
      'ec_param_enc:named_curve',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  const hash = Array.from(
    new X509Certificate(await readFile(certificate)).fingerprint256
      .split(':')
      .map((x) => Number.parseInt(x, 16)),
  );
  const origin = overrides.origin ?? 'http://127.0.0.1';
  const sessions = new Set();
  const errors = [];
  class EchoGateway {
    connected(session) {
      sessions.add(session);
      session.signal.addEventListener('abort', () => sessions.delete(session), { once: true });
    }
    async datagram(session, value) {
      const writer = session.datagrams.writable.getWriter();
      try {
        await writer.write(value);
      } finally {
        writer.releaseLock();
      }
    }
    async bidi(stream) {
      await stream.readable.pipeTo(stream.writable);
    }
    async uni(session, stream) {
      if (overrides.onUni) return overrides.onUni(session, stream);
      const outgoing = await session.createUnidirectionalStream();
      await stream.readable.pipeTo(outgoing.writable);
    }
  }
  WebTransportGateway('/echo')(EchoGateway);
  for (const [name, decorator] of [
    ['connected', OnSession],
    ['datagram', OnDatagram],
    ['bidi', OnBidirectionalStream],
    ['uni', OnUnidirectionalStream],
  ]) {
    decorator()(
      EchoGateway.prototype,
      name,
      Object.getOwnPropertyDescriptor(EchoGateway.prototype, name),
    );
  }
  Session()(EchoGateway.prototype, 'connected', 0);
  Session()(EchoGateway.prototype, 'datagram', 0);
  Payload()(EchoGateway.prototype, 'datagram', 1);
  Stream()(EchoGateway.prototype, 'bidi', 0);
  Session()(EchoGateway.prototype, 'uni', 0);
  Stream()(EchoGateway.prototype, 'uni', 1);
  const driver = new RWebTransportDriver({ allowedOrigins: [origin], ...overrides.driver });
  const module = await Test.createTestingModule({
    imports: [
      WebTransportModule.forRoot({
        driver,
        server: {
          host: '127.0.0.1',
          port: 0,
          tls: {
            certificate: { kind: 'path', path: certificate },
            privateKey: { kind: 'path', path: key },
          },
        },
        security: {
          allowedOrigins: [origin],
          handshakeTimeoutMs: 1_000,
          idleTimeoutMs: 30_000,
          authenticate: (session) =>
            new URL(session.path, 'https://localhost').searchParams.get('ticket') === 'test-only',
          ...overrides.security,
        },
        limits: { ip: { sessionsPerSecond: 1_000 }, ...overrides.limits },
        execution: { maxConcurrentHandlers: 1, ...overrides.execution },
        shutdown: { drainTimeoutMs: 200, forceCloseTimeoutMs: 2_000 },
        logger: (record) => {
          if (record.level === 'error') errors.push(record);
        },
      }),
    ],
    providers: [EchoGateway],
  }).compile();
  try {
    await module.init();
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    driver,
    module,
    sessions,
    errors,
    origin,
    hash,
    get url() {
      return `https://127.0.0.1:${driver.port}/echo?ticket=test-only`;
    },
    get health() {
      return module.get(WebTransportHealthService).getStatus();
    },
    async close() {
      try {
        await module.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export async function readAll(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(...chunk);
  return Uint8Array.from(chunks);
}

export async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transport state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
