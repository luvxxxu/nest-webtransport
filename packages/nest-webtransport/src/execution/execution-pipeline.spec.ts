import {
  type ArgumentMetadata,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  type PipeTransform,
  type Provider,
  Scope,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE, REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { type Observable, tap } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { SessionContext, WebTransportSession } from 'webtransport-core';

import { TestClient, VirtualWebTransportDriver } from '../../../testing/src/index.js';
import { WebTransportGateway } from '../decorators/gateway.decorator.js';
import { OnDatagram, OnSession } from '../decorators/handler.decorator.js';
import { Payload, WebTransportContext } from '../decorators/parameter.decorator.js';
import { WebTransportHealthService } from '../server/webtransport-health.service.js';
import { WebTransportModule } from '../webtransport.module.js';

interface Invocation {
  readonly kind: string;
  readonly sessionId: string;
  readonly instance: object;
}

@Injectable()
class Recorder {
  readonly calls: Invocation[] = [];
  readonly sessions: string[] = [];
  readonly payloads: number[] = [];
}

@Injectable({ scope: Scope.REQUEST })
@Catch(Error)
class RequestEnhancer implements CanActivate, PipeTransform, NestInterceptor, ExceptionFilter {
  constructor(
    @Inject(REQUEST) private readonly request: SessionContext,
    @Inject(Recorder) private readonly recorder: Recorder,
  ) {}

  canActivate(): boolean {
    this.record('guard');
    return true;
  }

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    this.record('pipe');
    return metadata.data === 'payload' && value instanceof Uint8Array ? value[0] : value;
  }

  intercept(
    _context: ExecutionContext,
    next: { handle(): Observable<unknown> },
  ): Observable<unknown> {
    this.record('interceptor');
    return next.handle().pipe(tap(() => this.record('interceptor:after')));
  }

  catch(): void {
    this.record('filter');
  }

  private record(kind: string): void {
    this.recorder.calls.push({ kind, sessionId: this.request.sessionId, instance: this });
  }
}

@WebTransportGateway('/scoped')
@Injectable()
class ScopedGateway {
  constructor(@Inject(Recorder) private readonly recorder: Recorder) {}

  @OnSession()
  session(@WebTransportContext() context: SessionContext): void {
    this.recorder.sessions.push(context.sessionId);
  }

  @OnDatagram()
  datagram(@Payload() value: number): void {
    if (value === 255) {
      throw new Error('Handled by the request-scoped global filter');
    }
    this.recorder.payloads.push(value);
  }
}

type Registration = 'useClass' | 'useFactory' | 'useExisting';

function globalProviders(registration: Registration): Provider[] {
  return [APP_GUARD, APP_PIPE, APP_INTERCEPTOR, APP_FILTER].map((provide) => {
    switch (registration) {
      case 'useClass':
        return { provide, useClass: RequestEnhancer };
      case 'useFactory':
        return {
          provide,
          scope: Scope.REQUEST,
          inject: [REQUEST, Recorder],
          useFactory: (request: SessionContext, recorder: Recorder) =>
            new RequestEnhancer(request, recorder),
        };
      case 'useExisting':
        // Nest requires explicit global enhancer scope when the registration
        // does not carry useClass metadata (including factory and alias forms).
        return { provide, scope: Scope.REQUEST, useExisting: RequestEnhancer };
    }
    throw new TypeError(`Unsupported provider registration: ${registration}`);
  });
}

describe('WebTransport request-scoped global enhancers', () => {
  it.each(['guard', 'pipe', 'interceptor'] as const)(
    'does not start a handler after a pending %s resumes on a disconnected session',
    async (stage) => {
      let entered = false;
      let calls = 0;
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const wait = async () => {
        entered = true;
        await hold;
      };
      @WebTransportGateway('/cancel')
      @UseGuards({
        canActivate: async () => {
          if (stage === 'guard') await wait();
          return true;
        },
      })
      @UseInterceptors({
        intercept: async (_context, next) => {
          if (stage === 'interceptor') await wait();
          return next.handle();
        },
      })
      class CancellationGateway {
        @OnSession()
        session(
          @WebTransportContext({
            transform: async (value: unknown) => {
              if (stage === 'pipe') await wait();
              return value;
            },
          })
          _context: SessionContext,
        ): void {
          calls++;
        }
      }
      const driver = new VirtualWebTransportDriver();
      let session: WebTransportSession | undefined;
      driver.onSession((value) => {
        session = value;
      });
      const moduleRef = await Test.createTestingModule({
        imports: [
          WebTransportModule.forRoot({
            driver,
            server: { port: 0 },
            security: { requireOrigin: false },
          }),
        ],
        providers: [CancellationGateway],
      }).compile();
      await moduleRef.init();
      try {
        const connecting = new TestClient(driver).connect('/cancel');
        await waitFor(() => entered);
        await session?.close();
        expect((await connecting).signal.aborted).toBe(true);
        release();
        await waitFor(
          () =>
            moduleRef.get(WebTransportHealthService).getRuntimeStats().handlers.outstanding === 0,
        );
        expect(calls).toBe(0);
      } finally {
        release();
        await moduleRef.close();
      }
    },
  );

  it('does not replace a failing registered pipe factory with its class constructor', async () => {
    let calls = 0;
    let factoryCalls = 0;
    @Injectable()
    class PolicyPipe {
      transform(value: unknown): unknown {
        return value;
      }
    }
    @WebTransportGateway('/policy')
    @Injectable()
    class PolicyGateway {
      @OnSession()
      session(@WebTransportContext(PolicyPipe) _context: SessionContext): void {
        calls += 1;
      }
    }
    const driver = new VirtualWebTransportDriver();
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: { requireOrigin: false },
        }),
      ],
      providers: [
        PolicyGateway,
        {
          provide: PolicyPipe,
          scope: Scope.REQUEST,
          useFactory: () => {
            factoryCalls += 1;
            throw new Error('Policy initialization failed');
          },
        },
      ],
    }).compile();
    await moduleRef.init();
    try {
      const client = await new TestClient(driver).connect('/policy');
      expect(client.signal.aborted).toBe(true);
      expect(calls).toBe(0);
      expect(factoryCalls).toBe(1);
    } finally {
      await moduleRef.close();
    }
  });

  it.each<Registration>(['useClass', 'useFactory', 'useExisting'])(
    'resolves %s registrations, injects REQUEST and isolates session instances',
    async (registration) => {
      const driver = new VirtualWebTransportDriver();
      const moduleRef = await Test.createTestingModule({
        imports: [
          WebTransportModule.forRoot({
            driver,
            server: { port: 0 },
            security: { requireOrigin: false },
          }),
        ],
        providers: [Recorder, ScopedGateway, RequestEnhancer, ...globalProviders(registration)],
      }).compile();
      await moduleRef.init();
      try {
        const recorder = moduleRef.get(Recorder);
        const client = new TestClient(driver);
        const first = await client.connect('/scoped');
        const second = await client.connect('/scoped');
        expect(recorder.sessions).toEqual([first.id, second.id]);
        expect(first.signal.aborted).toBe(false);
        expect(second.signal.aborted).toBe(false);

        await first.sendDatagram(new Uint8Array([7]));
        await second.sendDatagram(new Uint8Array([8]));
        await waitFor(() => recorder.payloads.length === 2);
        expect(recorder.payloads.sort()).toEqual([7, 8]);
        await first.sendDatagram(new Uint8Array([255]));
        await second.sendDatagram(new Uint8Array([255]));
        await waitFor(() => recorder.calls.filter((call) => call.kind === 'filter').length === 2);
        expect(first.signal.aborted).toBe(false);
        expect(second.signal.aborted).toBe(false);

        for (const kind of ['guard', 'pipe', 'interceptor', 'interceptor:after', 'filter']) {
          const firstInstances = new Set(
            recorder.calls
              .filter((call) => call.kind === kind && call.sessionId === first.id)
              .map((call) => call.instance),
          );
          const secondInstances = new Set(
            recorder.calls
              .filter((call) => call.kind === kind && call.sessionId === second.id)
              .map((call) => call.instance),
          );
          expect(firstInstances.size, kind).toBe(1);
          expect(secondInstances.size, kind).toBe(1);
          expect([...firstInstances][0], kind).not.toBe([...secondInstances][0]);
        }
      } finally {
        await moduleRef.close();
      }
    },
  );
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for enhancer invocation');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
