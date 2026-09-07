import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { metrics, trace } from '@opentelemetry/api';

import { WebTransportMetrics } from './metrics.js';
import type { NormalizedWebTransportOtelOptions, WebTransportOtelOptions } from './options.js';
import { WebTransportTracingInterceptor } from './tracing.interceptor.js';

const WEBTRANSPORT_OTEL_OPTIONS = Symbol('WEBTRANSPORT_OTEL_OPTIONS');

@Injectable()
class WebTransportOtelLifecycle implements OnModuleInit, OnModuleDestroy {
  readonly metrics: WebTransportMetrics;

  constructor(@Inject(WEBTRANSPORT_OTEL_OPTIONS) options: NormalizedWebTransportOtelOptions) {
    this.metrics = new WebTransportMetrics(options.driver, options);
  }

  onModuleInit(): void {
    this.metrics.enable();
  }

  onModuleDestroy(): void {
    this.metrics.disable();
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules conventionally expose static registration methods.
export class WebTransportOtelModule {
  static forRoot(options: WebTransportOtelOptions): DynamicModule {
    if (options?.driver == null) {
      throw new TypeError('WebTransportOtelModule requires the WebTransport driver.');
    }
    const instrumentationName = options.instrumentationName ?? 'nest-webtransport';
    const normalized: NormalizedWebTransportOtelOptions = Object.freeze({
      driver: options.driver,
      meter: options.meter ?? metrics.getMeter(instrumentationName),
      tracer: options.tracer ?? trace.getTracer(instrumentationName),
      attributes: Object.freeze({ ...(options.attributes ?? {}) }),
    });

    return {
      module: WebTransportOtelModule,
      providers: [
        { provide: WEBTRANSPORT_OTEL_OPTIONS, useValue: normalized },
        WebTransportOtelLifecycle,
        {
          provide: APP_INTERCEPTOR,
          inject: [WEBTRANSPORT_OTEL_OPTIONS],
          useFactory: (resolved: NormalizedWebTransportOtelOptions) =>
            new WebTransportTracingInterceptor(resolved),
        },
      ],
    };
  }
}
