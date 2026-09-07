import { Injectable } from '@nestjs/common';
import {
  OnBidirectionalStream,
  OnDatagram,
  OnSession,
  Payload,
  Session,
  type SessionContext,
  Stream,
  type WebTransportBidirectionalStream,
  WebTransportContext,
  WebTransportGateway,
  type WebTransportSession,
} from 'nest-webtransport';

import type { JwtPrincipal } from './jwt-authenticator.js';
import type { RedisPresenceService } from './redis-presence.service.js';

@WebTransportGateway('/realtime')
@Injectable()
export class RealtimeGateway {
  constructor(private readonly presence: RedisPresenceService) {}

  @OnSession()
  async connected(
    @Session() session: WebTransportSession,
    @WebTransportContext() context: SessionContext,
  ): Promise<void> {
    const principal = context.principal as JwtPrincipal;
    await this.presence.markConnected(session.id, principal.userId);
    context.signal.addEventListener(
      'abort',
      () => {
        void this.presence.markDisconnected(session.id).catch(() => {});
      },
      { once: true },
    );
  }

  @OnDatagram('heartbeat')
  async heartbeat(@Session() session: WebTransportSession): Promise<void> {
    await this.presence.refresh(session.id);
  }

  @OnBidirectionalStream('echo')
  async echo(@Stream() stream: WebTransportBidirectionalStream): Promise<void> {
    await stream.readable.pipeTo(stream.writable);
  }

  @OnDatagram()
  unknownDatagram(@Payload() _payload: Uint8Array): void {
    // The unnamed fallback deliberately ignores unknown application datagrams.
  }
}
