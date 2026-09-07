import { Inject, Injectable, Scope, UseGuards } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { SessionContext, WebTransportSession } from 'webtransport-core';
import { TestClient, VirtualWebTransportDriver } from '../../testing/src/index.js';
import { WebTransportGateway } from './decorators/gateway.decorator.js';
import { OnDatagram, OnSession } from './decorators/handler.decorator.js';
import { Payload, Session } from './decorators/parameter.decorator.js';
import { WebTransportHealthService } from './server/webtransport-health.service.js';
import { WebTransportModule } from './webtransport.module.js';

@WebTransportGateway('/audit')
class AuditGateway {
  @OnSession()
  connected() {}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('admission resource accounting', () => {
  it.each(['timeout', 'disconnect'] as const)(
    'retains the permit until real authentication settles after %s',
    async (mode) => {
      const driver = new VirtualWebTransportDriver();
      let release!: () => void;
      let calls = 0;
      const module = await Test.createTestingModule({
        imports: [
          WebTransportModule.forRoot({
            driver,
            server: { port: 0 },
            limits: { server: { maxSessions: 1 }, ip: { sessionsPerSecond: 100 } },
            security: {
              requireOrigin: false,
              handshakeTimeoutMs: 10,
              authenticate: async (session) => {
                calls++;
                if (mode === 'disconnect') await session.close();
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
                return true;
              },
            },
            shutdown: { drainTimeoutMs: 20, forceCloseTimeoutMs: 50 },
          }),
        ],
        providers: [AuditGateway],
      }).compile();
      await module.init();
      try {
        for (let i = 0; i < 4; i++) {
          const client = await new TestClient(driver).connect('/audit');
          expect(client.signal.aborted).toBe(true);
          await tick();
        }
        expect(calls).toBe(1);
        release();
        await tick();
        const next = await new TestClient(driver).connect('/audit');
        expect(next.signal.aborted).toBe(true);
        expect(calls).toBe(2);
      } finally {
        release();
        await module.close();
      }
    },
  );
});

class BaseGateway {
  values: Uint8Array[] = [];
  @OnDatagram()
  message(@Payload() value: Uint8Array) {
    this.values.push(value);
  }
}
@WebTransportGateway('/inherited')
class InheritedGateway extends BaseGateway {}

@Injectable({ scope: Scope.REQUEST })
class SessionIdentity {
  constructor(@Inject(REQUEST) readonly context: SessionContext) {}
}
@WebTransportGateway('/scoped')
@Injectable({ scope: Scope.REQUEST })
class ScopedGateway {
  static identities: string[] = [];
  constructor(@Inject(SessionIdentity) readonly identity: SessionIdentity) {}
  @OnSession()
  connect(@Session() session: WebTransportSession) {
    expect(this.identity.context.sessionId).toBe(session.id);
    ScopedGateway.identities.push(this.identity.context.sessionId);
  }
}
@WebTransportGateway('/denied')
@UseGuards({ canActivate: () => false })
class DeniedGateway {
  @OnSession()
  connect() {
    throw new Error('A denied handler must not run');
  }
}

it('preserves inherited arguments, session-scoped DI, and guard rejection', async () => {
  const driver = new VirtualWebTransportDriver();
  const module = await Test.createTestingModule({
    imports: [
      WebTransportModule.forRootAsync({
        useFactory: async () => ({
          driver,
          server: { port: 0 },
          security: { requireOrigin: false },
        }),
      }),
    ],
    providers: [InheritedGateway, ScopedGateway, SessionIdentity, DeniedGateway],
  }).compile();
  await module.init();
  try {
    const inherited = await new TestClient(driver).connect('/inherited');
    await inherited.sendDatagram(new Uint8Array([42]));
    await tick();
    expect(module.get(InheritedGateway).values).toEqual([new Uint8Array([42])]);
    const first = await new TestClient(driver).connect('/scoped');
    const second = await new TestClient(driver).connect('/scoped');
    expect(ScopedGateway.identities).toEqual([first.id, second.id]);
    const denied = await new TestClient(driver).connect('/denied');
    expect(denied.signal.aborted).toBe(true);
    expect(module.get(WebTransportHealthService).getStatus().ready).toBe(true);
  } finally {
    await module.close();
  }
});
