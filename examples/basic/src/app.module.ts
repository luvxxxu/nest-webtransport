import { Logger, Module } from '@nestjs/common';
import { type WebTransportLogRecord, WebTransportModule } from 'nest-webtransport';
import { RWebTransportDriver } from 'webtransport-driver-rwebtransport';

import { BasicGateway } from './basic.gateway.js';
import { authorizationMatches, basicExampleConfig } from './config.js';

const transportLogger = new Logger('WebTransport');

function logTransportRecord(record: WebTransportLogRecord): void {
  const message = JSON.stringify(record);
  switch (record.level) {
    case 'debug':
      transportLogger.debug(message);
      return;
    case 'info':
      transportLogger.log(message);
      return;
    case 'warn':
      transportLogger.warn(message);
      return;
    case 'error':
      transportLogger.error(message);
  }
}

@Module({
  imports: [
    WebTransportModule.forRoot({
      driver: new RWebTransportDriver({
        // This static list is enforced by rwebtransport before CONNECT is accepted.
        allowedOrigins: basicExampleConfig.allowedOrigins,
      }),
      server: {
        host: basicExampleConfig.host,
        port: basicExampleConfig.port,
        tls: {
          certificate: { kind: 'path', path: basicExampleConfig.certificatePath },
          privateKey: { kind: 'path', path: basicExampleConfig.privateKeyPath },
        },
      },
      security: {
        // The Nest runtime repeats the exact Origin check after the native session is surfaced.
        requireOrigin: true,
        allowedOrigins: basicExampleConfig.allowedOrigins,
        maxHeaderSize: 16 * 1024,
        maxDatagramSize: 1_200,
        handshakeTimeoutMs: 5_000,
        idleTimeoutMs: 60_000,
        authenticate(session) {
          if (
            !authorizationMatches(
              session.headers.get('authorization'),
              basicExampleConfig.authorizationHeader,
            )
          ) {
            return false;
          }

          return { subject: 'basic-example-client' };
        },
      },
      limits: {
        server: { maxSessions: 1_000 },
        ip: { maxSessions: 20, sessionsPerSecond: 5 },
        session: {
          maxBidirectionalStreams: 32,
          maxUnidirectionalStreams: 32,
          maxDatagramsPerSecond: 250,
          maxConcurrentHandlers: 16,
          maxPendingHandlers: 32,
        },
        stream: { maxLifetimeMs: 120_000 },
      },
      execution: {
        maxConcurrentHandlers: 16,
        maxPendingHandlers: 32,
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
      logger: logTransportRecord,
    }),
  ],
  providers: [BasicGateway],
})
export class AppModule {}
