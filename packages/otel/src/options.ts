import type { Attributes, Meter, Tracer } from '@opentelemetry/api';
import type { WebTransportRuntimeStats } from 'nest-webtransport';
import type { WebTransportDriver } from 'webtransport-core';

export interface WebTransportOtelOptions {
  readonly driver: WebTransportDriver;
  readonly meter?: Meter;
  readonly tracer?: Tracer;
  readonly instrumentationName?: string;
  readonly attributes?: Attributes;
  /** Optional runtime counters for standalone metrics collectors. Nest modules discover health automatically. */
  readonly runtimeStats?: () => WebTransportRuntimeStats;
  /** Error messages/stacks may contain credentials. Enable only with an exporter redaction policy. */
  readonly recordExceptionDetails?: boolean;
}

export interface NormalizedWebTransportOtelOptions {
  readonly driver: WebTransportDriver;
  readonly meter: Meter;
  readonly tracer: Tracer;
  readonly attributes: Attributes;
  readonly runtimeStats?: () => WebTransportRuntimeStats;
  readonly recordExceptionDetails?: boolean;
}
