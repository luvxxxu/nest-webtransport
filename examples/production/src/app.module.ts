import { type DynamicModule, Module } from '@nestjs/common';
import {
  RWebTransportDriver,
  type WebTransportDriver,
  WebTransportModule,
  type WebTransportRouteResolution,
} from 'nest-webtransport';
import { WebTransportOtelModule } from 'nest-webtransport-otel';
import { createBoundedLogger } from './bounded-logger.js';
import type { ProductionConfig } from './config.js';
import { JwtAuthenticator } from './jwt-authenticator.js';
import { OperationsServer } from './operations-server.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RedisPresenceService } from './redis-presence.service.js';
import { PRODUCTION_CONFIG } from './tokens.js';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules require a class token.
export class AppModule {
  static register(
    config: ProductionConfig,
    driver: WebTransportDriver = new RWebTransportDriver({ allowedOrigins: config.allowedOrigins }),
  ): DynamicModule {
    const authenticator = new JwtAuthenticator(config);
    return {
      module: AppModule,
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
            server: {
              maxSessions: 1_000,
              maxConcurrentHandlers: 128,
              maxPendingHandlers: 512,
              maxQueuedDatagramBytes: 8 * 1024 * 1024,
              maxStreams: 512,
            },
            ip: { maxSessions: 100, sessionsPerSecond: 10 },
            session: {
              maxBidirectionalStreams: 16,
              maxUnidirectionalStreams: 16,
              maxDatagramsPerSecond: 10,
              maxConcurrentHandlers: 8,
              maxPendingHandlers: 16,
            },
            stream: { maxLifetimeMs: 300_000 },
          },
          execution: { maxConcurrentHandlers: 8, maxPendingHandlers: 16, overflow: 'drop' },
          datagrams: { queue: { size: 16, overflow: 'drop-oldest' } },
          routing: {
            datagram: routeDatagram,
            bidirectionalStream: async (stream) => ({ route: 'echo', value: stream }),
          },
          shutdown: { graceful: true, drainTimeoutMs: 10_000, forceCloseTimeoutMs: 15_000 },
          logger: createBoundedLogger(),
        }),
        WebTransportOtelModule.forRoot({ driver, attributes: { 'service.name': 'realtime' } }),
      ],
      providers: [
        { provide: PRODUCTION_CONFIG, useValue: config },
        RealtimeGateway,
        RedisPresenceService,
        OperationsServer,
      ],
    };
  }
}

function routeDatagram(datagram: Uint8Array): WebTransportRouteResolution<Uint8Array> {
  return datagram[0] === 1
    ? { route: 'heartbeat', value: datagram, payload: datagram.subarray(1) }
    : { value: datagram, payload: datagram };
}
