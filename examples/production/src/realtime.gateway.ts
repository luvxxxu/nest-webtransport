import { Inject, Injectable } from '@nestjs/common';
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
import { RedisPresenceService } from './redis-presence.service.js';

@WebTransportGateway('/realtime')
@Injectable()
export class RealtimeGateway {
  constructor(@Inject(RedisPresenceService) private readonly presence: RedisPresenceService) {}

  @OnSession()
  async connected(
    @Session() session: WebTransportSession,
    @WebTransportContext() context: SessionContext,
  ): Promise<void> {
    const principal = context.principal as JwtPrincipal;
    let expirationTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupStarted = false;
    const cleanup = () => {
      clearTimeout(expirationTimer);
      if (cleanupStarted) return;
      cleanupStarted = true;
      void this.presence.markDisconnected(session.id).catch(() => {
        // Redis may be offline. The TTL remains the final cleanup bound.
      });
    };
    const expire = () => {
      const remaining = principal.expiresAt - Date.now();
      if (remaining <= 0) {
        cleanup();
        void session.close({ closeCode: 0x100, reason: 'Authentication expired' }).catch(() => {});
        return;
      }
      expirationTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      expirationTimer.unref();
    };
    try {
      await this.presence.markConnected(session.id, principal.userId, context.signal);
    } catch (error) {
      // SET can have reached Redis even when its reply was lost or cancelled.
      cleanup();
      throw error;
    }
    context.signal.addEventListener('abort', cleanup, { once: true });
    if (context.signal.aborted) {
      context.signal.removeEventListener('abort', cleanup);
      cleanup();
      return;
    }
    expire();
  }

  @OnDatagram('heartbeat')
  async heartbeat(
    @Session() session: WebTransportSession,
    @WebTransportContext() context: SessionContext,
  ): Promise<void> {
    await this.presence.refresh(session.id, context.signal);
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
