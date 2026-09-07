import { Module } from '@nestjs/common';
import { WebTransportModule, type WebTransportRouteResolution } from 'nest-webtransport';
import { WebTransportOtelModule } from 'nest-webtransport-otel';
import { RWebTransportDriver } from 'webtransport-driver-rwebtransport';

import { loadProductionConfig } from './config.js';
import { JwtAuthenticator } from './jwt-authenticator.js';
import { OperationsServer } from './operations-server.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RedisPresenceService } from './redis-presence.service.js';
import { PRODUCTION_CONFIG } from './tokens.js';

const config = loadProductionConfig();
const driver = new RWebTransportDriver({ allowedOrigins: config.allowedOrigins });
const authenticator = new JwtAuthenticator(config);

@Module({
  imports: [
    WebTransportModule.forRoot({
      driver,
      server: {
        host: config.webTransportHost,
        port: config.webTransportPort,
        tls: {
          certificate: { kind: 'path', path: config.certificatePath },
          privateKey: { kind: 'path', path: config.privateKeyPath },
        },
      },
      security: {
        requireOrigin: true,
        allowedOrigins: config.allowedOrigins,
        authenticate: authenticator.authenticate,
        handshakeTimeoutMs: 5_000,
        idleTimeoutMs: 60_000,
      },
      limits: {
        server: { maxSessions: 50_000 },
        ip: { maxSessions: 100, sessionsPerSecond: 10 },
        session: {
          maxBidirectionalStreams: 100,
          maxUnidirectionalStreams: 100,
          maxDatagramsPerSecond: 1_000,
          maxConcurrentHandlers: 64,
          maxPendingHandlers: 128,
        },
        stream: { maxLifetimeMs: 300_000 },
      },
      execution: { maxConcurrentHandlers: 64, maxPendingHandlers: 128, overflow: 'drop' },
      datagrams: { queue: { size: 256, overflow: 'drop-oldest' } },
      routing: {
        datagram: routeDatagram,
        bidirectionalStream: async (stream) => ({ route: 'echo', value: stream }),
      },
      shutdown: { graceful: true, drainTimeoutMs: 10_000, forceCloseTimeoutMs: 15_000 },
      logger: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
    }),
    WebTransportOtelModule.forRoot({ driver, attributes: { 'service.name': 'realtime' } }),
  ],
  providers: [
    { provide: PRODUCTION_CONFIG, useValue: config },
    RealtimeGateway,
    RedisPresenceService,
    OperationsServer,
  ],
})
export class AppModule {}

function routeDatagram(datagram: Uint8Array): WebTransportRouteResolution<Uint8Array> {
  return datagram[0] === 1
    ? { route: 'heartbeat', value: datagram, payload: datagram.subarray(1) }
    : { value: datagram, payload: datagram };
}
