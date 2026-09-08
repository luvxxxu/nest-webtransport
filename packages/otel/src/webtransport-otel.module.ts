import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_INTERCEPTOR, ModuleRef } from '@nestjs/core';
import { metrics, trace } from '@opentelemetry/api';
import { WebTransportHealthService } from 'nest-webtransport';

import { WebTransportMetrics } from './metrics.js';
import type { NormalizedWebTransportOtelOptions, WebTransportOtelOptions } from './options.js';
import { WebTransportTracingInterceptor } from './tracing.interceptor.js';

const WEBTRANSPORT_OTEL_OPTIONS = Symbol('WEBTRANSPORT_OTEL_OPTIONS');

@Injectable()
class WebTransportOtelLifecycle implements OnModuleInit, OnModuleDestroy {
  private collector: WebTransportMetrics | undefined;

  constructor(
    @Inject(WEBTRANSPORT_OTEL_OPTIONS) private readonly options: NormalizedWebTransportOtelOptions,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    let runtimeStats = this.options.runtimeStats;
    if (runtimeStats === undefined) {
      try {
        const health = this.moduleRef.get(WebTransportHealthService, { strict: false });
        runtimeStats = () => health.getRuntimeStats();
      } catch {
        /* Standalone driver instrumentation has no Nest runtime. */
      }
    }
    this.collector = new WebTransportMetrics(this.options.driver, {
      ...this.options,
      ...(runtimeStats === undefined ? {} : { runtimeStats }),
    });
    this.collector.enable();
  }

  onModuleDestroy(): void {
    this.collector?.disable();
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
      ...(options.runtimeStats === undefined ? {} : { runtimeStats: options.runtimeStats }),
      recordExceptionDetails: options.recordExceptionDetails ?? false,
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
