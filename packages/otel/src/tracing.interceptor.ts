import { type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import {
  type Attributes,
  context as activeContext,
  type Counter,
  type Histogram,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { switchToWebTransport } from 'nest-webtransport';
import { catchError, defer, finalize, Observable, throwError } from 'rxjs';

import type { NormalizedWebTransportOtelOptions } from './options.js';

@Injectable()
export class WebTransportTracingInterceptor implements NestInterceptor {
  private readonly duration: Histogram;
  private readonly errors: Counter;

  constructor(private readonly options: NormalizedWebTransportOtelOptions) {
    this.duration = options.meter.createHistogram('webtransport.handlers.duration', {
      description: 'WebTransport handler execution duration',
      unit: 'ms',
    });
    this.errors = options.meter.createCounter('webtransport.handlers.errors', {
      description: 'WebTransport handler errors',
    });
  }

  intercept(
    context: ExecutionContext,
    next: { handle(): Observable<unknown> },
  ): Observable<unknown> {
    if (context.getType<string>() !== 'webtransport') return next.handle();

    return defer(() => {
      const host = switchToWebTransport(context);
      const session = host.getSession();
      const stream = host.getStream();
      const kind =
        stream !== undefined ? 'stream' : host.getDatagram() !== undefined ? 'datagram' : 'session';
      const name = `webtransport.${kind}.${context.getClass().name}.${context.getHandler().name}`;
      const metricAttributes: Attributes = {
        ...this.options.attributes,
        'webtransport.kind': kind,
        // CONNECT query strings can contain one-time credentials and must never
        // become telemetry labels (or create an unbounded label cardinality).
        'webtransport.path': new URL(session.path, 'https://webtransport.invalid').pathname,
      };
      const spanAttributes: Attributes = {
        ...metricAttributes,
        'webtransport.session.id': session.id,
        ...(stream === undefined ? {} : { 'webtransport.stream.id': stream.id.toString() }),
      };
      const startedAt = performance.now();
      const span = this.options.tracer.startSpan(name, { attributes: spanAttributes });
      const spanContext = trace.setSpan(activeContext.active(), span);

      return new Observable<unknown>((subscriber) =>
        activeContext.with(spanContext, () => next.handle().subscribe(subscriber)),
      ).pipe(
        catchError((error: unknown) => {
          this.errors.add(1, metricAttributes);
          span.recordException(toException(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          return throwError(() => error);
        }),
        finalize(() => {
          this.duration.record(performance.now() - startedAt, metricAttributes);
          span.end();
        }),
      );
    });
  }
}

function toException(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown WebTransport handler error');
}
