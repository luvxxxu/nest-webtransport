import {
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type PipeTransform,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type Observable, tap } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type {
  SessionContext,
  WebTransportBidirectionalStream,
  WebTransportSession,
} from 'webtransport-core';
import { TestClient, VirtualWebTransportDriver } from '../../testing/src/index.js';
import type { WebTransportArgumentsHost } from './context/webtransport-arguments-host.js';
import { WebTransportGateway } from './decorators/gateway.decorator.js';
import { OnBidirectionalStream, OnDatagram, OnSession } from './decorators/handler.decorator.js';
import { Payload, Session, Stream, WebTransportContext } from './decorators/parameter.decorator.js';
import { WebTransportHealthService } from './server/webtransport-health.service.js';
import { WebTransportModule } from './webtransport.module.js';

const events: string[] = [];

@Injectable()
class RecordingGuard {
  canActivate(context: ExecutionContext): boolean {
    const host = (
      context as ExecutionContext & {
        switchToWebTransport(): WebTransportArgumentsHost;
      }
    ).switchToWebTransport();
    events.push(`guard:${host.getSession().path}`);
    return true;
  }
}

@Injectable()
class IncrementPipe implements PipeTransform<number, number> {
  transform(value: number): number {
    events.push(`pipe:${value}`);
    return value + 1;
  }
}

@Injectable()
class RecordingInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: { handle(): Observable<unknown> },
  ): Observable<unknown> {
    events.push('interceptor:before');
    return next.handle().pipe(tap(() => events.push('interceptor:after')));
  }
}

@Catch(Error)
@Injectable()
class RecordingFilter implements ExceptionFilter {
  catch(error: Error): void {
    events.push(`filter:${error.message}`);
  }
}

@WebTransportGateway('/realtime')
@UseGuards(RecordingGuard)
@Injectable()
class RealtimeGateway {
  sessions = 0;
  principal: unknown;
  payloads: number[] = [];
  datagramReaderReserved = false;
  streamReadersAvailable = false;

  @OnSession()
  onSession(
    @Session() session: WebTransportSession,
    @WebTransportContext() context: SessionContext,
  ): void {
    this.sessions += 1;
    this.principal = context.principal;
    this.datagramReaderReserved = session.datagrams.readable.locked;
    this.streamReadersAvailable =
      !session.incomingBidirectionalStreams.locked && !session.incomingUnidirectionalStreams.locked;
    events.push(`session:${session.id}`);
  }

  @OnDatagram('position')
  @UsePipes(IncrementPipe)
  @UseInterceptors(RecordingInterceptor)
  onPosition(@Payload() payload: number): void {
    this.payloads.push(payload);
    events.push(`handler:${payload}`);
  }

  @OnDatagram('explode')
  @UseFilters(RecordingFilter)
  explode(): void {
    throw new Error('isolated');
  }
}

@WebTransportGateway('/slow')
@Injectable()
class SlowAdmissionGateway {
  sessions = 0;

  @OnSession()
  onSession(): void {
    this.sessions += 1;
  }
}

@WebTransportGateway('/named-without-resolver')
@Injectable()
class InvalidNamedGateway {
  @OnDatagram('named')
  onNamedDatagram(): void {}
}

@WebTransportGateway('/idle-stream')
@Injectable()
class IdleStreamGateway {
  streams = 0;

  @OnBidirectionalStream()
  async onStream(@Stream() stream: WebTransportBidirectionalStream): Promise<void> {
    this.streams += 1;
    if (stream.signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => stream.signal.addEventListener('abort', () => resolve()));
  }
}

describe('WebTransportModule virtual integration', () => {
  it('discovers gateways once and runs admission, routing, and the Nest pipeline', async () => {
    events.length = 0;
    const driver = new VirtualWebTransportDriver();
    const logEvents: string[] = [];
    let authenticationCalls = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: {
            requireOrigin: false,
            authenticate: (_session, context) => {
              authenticationCalls += 1;
              context.metadata.set(Symbol.for('test-authenticated'), true);
              return { userId: 'user-1' };
            },
          },
          routing: {
            datagram: (datagram) => ({
              route: datagram[0] === 1 ? 'position' : 'explode',
              payload: datagram[1] ?? 0,
            }),
          },
          logger: (record) => logEvents.push(record.event),
        }),
      ],
      providers: [
        RealtimeGateway,
        RecordingGuard,
        IncrementPipe,
        RecordingInterceptor,
        RecordingFilter,
      ],
    }).compile();
    await moduleRef.init();

    const health = moduleRef.get(WebTransportHealthService);
    expect(health.getStatus().ready).toBe(true);

    const client = await new TestClient(driver).connect('/realtime');
    const gateway = moduleRef.get(RealtimeGateway);
    await waitFor(() => gateway.sessions === 1);
    expect(authenticationCalls).toBe(1);
    expect(gateway.principal).toEqual({ userId: 'user-1' });
    expect(gateway.datagramReaderReserved).toBe(true);
    expect(gateway.streamReadersAvailable).toBe(true);

    await client.sendDatagram(new Uint8Array([1, 4]));
    await waitFor(() => gateway.payloads.length === 1);
    expect(gateway.payloads).toEqual([5]);
    expect(events).toEqual([
      'guard:/realtime',
      `session:${client.id}`,
      'guard:/realtime',
      'interceptor:before',
      'pipe:4',
      'handler:5',
      'interceptor:after',
    ]);

    await client.sendDatagram(new Uint8Array([2]));
    await waitFor(() => events.includes('filter:isolated'));
    expect(client.signal.aborted).toBe(false);
    expect(logEvents).not.toContain('handler.error');

    await moduleRef.close();
    expect(driver.getStats().state).toBe('STOPPED');
  });

  it('cancels timed-out admission and never runs a late session handler', async () => {
    const driver = new VirtualWebTransportDriver();
    let resolveAuthentication!: (principal: unknown) => void;
    const authentication = new Promise<unknown>((resolve) => {
      resolveAuthentication = resolve;
    });
    let admissionSignal: AbortSignal | undefined;
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: {
            requireOrigin: false,
            handshakeTimeoutMs: 5,
            authenticate: (_session, context) => {
              admissionSignal = context.signal;
              return authentication;
            },
          },
          shutdown: { forceCloseTimeoutMs: 50 },
        }),
      ],
      providers: [SlowAdmissionGateway],
    }).compile();
    await moduleRef.init();

    const client = await new TestClient(driver).connect('/slow');
    const gateway = moduleRef.get(SlowAdmissionGateway);
    expect(client.signal.aborted).toBe(true);
    expect(admissionSignal?.aborted).toBe(true);

    resolveAuthentication({ userId: 'too-late' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(gateway.sessions).toBe(0);

    await moduleRef.close();
  });

  it('fails bootstrap when a named handler has no route resolver', async () => {
    const driver = new VirtualWebTransportDriver();
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: { requireOrigin: false },
        }),
      ],
      providers: [InvalidNamedGateway],
    }).compile();

    await expect(Promise.resolve().then(() => moduleRef.init())).rejects.toThrow(
      /requires routing\.datagram/,
    );
    expect(driver.getStats().state).toBe('STOPPED');
  });

  it('does not idle-close a session while an accepted stream is active', async () => {
    const driver = new VirtualWebTransportDriver();
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: { requireOrigin: false, idleTimeoutMs: 20 },
          limits: { stream: { maxLifetimeMs: 1_000 } },
          shutdown: { forceCloseTimeoutMs: 100 },
        }),
      ],
      providers: [IdleStreamGateway],
    }).compile();
    await moduleRef.init();

    const client = await new TestClient(driver).connect('/idle-stream');
    const stream = await client.createBidirectionalStream();
    const gateway = moduleRef.get(IdleStreamGateway);
    await waitFor(() => gateway.streams === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(client.signal.aborted).toBe(false);

    await stream.reset();
    await waitFor(() => client.signal.aborted);

    await moduleRef.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for virtual WebTransport work.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
