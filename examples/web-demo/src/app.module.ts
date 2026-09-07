import { Module } from '@nestjs/common';
import { WebTransportModule } from 'nest-webtransport';
import { RWebTransportDriver } from 'webtransport-driver-rwebtransport';

import { loadWebDemoConfig } from './config.js';
import { DemoGateway } from './demo.gateway.js';
import { SessionTicketStore } from './session-ticket.store.js';
import { StaticServer } from './static-server.service.js';

export const webDemoConfig = loadWebDemoConfig();
const sessionTickets = new SessionTicketStore();

@Module({
  imports: [
    WebTransportModule.forRoot({
      driver: new RWebTransportDriver({ allowedOrigins: webDemoConfig.pageOrigins }),
      server: {
        host: webDemoConfig.webTransportHost,
        port: webDemoConfig.webTransportPort,
        tls: {
          certificate: { kind: 'path', path: webDemoConfig.certificatePath },
          privateKey: { kind: 'path', path: webDemoConfig.privateKeyPath },
        },
      },
      security: {
        allowedOrigins: webDemoConfig.pageOrigins,
        requireOrigin: true,
        maxHeaderSize: 16 * 1024,
        maxDatagramSize: 1_200,
        handshakeTimeoutMs: 5_000,
        idleTimeoutMs: 60_000,
        authenticate: (session) =>
          sessionTickets.consume(session.path, session.remoteAddress ?? '')
            ? { subject: 'web-demo-user' }
            : false,
      },
      limits: {
        server: { maxSessions: 100 },
        ip: { maxSessions: 5, sessionsPerSecond: 3 },
        session: {
          maxBidirectionalStreams: 16,
          maxUnidirectionalStreams: 16,
          maxDatagramsPerSecond: 100,
          maxConcurrentHandlers: 8,
          maxPendingHandlers: 16,
        },
        stream: { maxLifetimeMs: 120_000 },
      },
      execution: { maxConcurrentHandlers: 8, maxPendingHandlers: 16, overflow: 'close-session' },
      datagrams: { queue: { size: 64, overflow: 'drop-oldest' } },
      shutdown: { graceful: true, drainTimeoutMs: 5_000, forceCloseTimeoutMs: 10_000 },
      logger: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
    }),
  ],
  providers: [
    {
      provide: StaticServer,
      useFactory: () => new StaticServer(webDemoConfig, sessionTickets),
    },
    DemoGateway,
  ],
})
export class AppModule {}
