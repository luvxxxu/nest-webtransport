import type { Attributes, Meter, Tracer } from '@opentelemetry/api';
import type { WebTransportDriver } from 'webtransport-core';

export interface WebTransportOtelOptions {
  readonly driver: WebTransportDriver;
  readonly meter?: Meter;
  readonly tracer?: Tracer;
  readonly instrumentationName?: string;
  readonly attributes?: Attributes;
}

export interface NormalizedWebTransportOtelOptions {
  readonly driver: WebTransportDriver;
  readonly meter: Meter;
  readonly tracer: Tracer;
  readonly attributes: Attributes;
}
