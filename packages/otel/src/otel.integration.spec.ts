import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Meter, Span, Tracer } from '@opentelemetry/api';
import { OnDatagram, Payload, WebTransportGateway, WebTransportModule } from 'nest-webtransport';
import { describe, expect, it } from 'vitest';
import { TestClient, VirtualWebTransportDriver } from '../../testing/src/index.js';

import { WebTransportOtelModule } from './webtransport-otel.module.js';

@WebTransportGateway('/observed')
@Injectable()
class ObservedGateway {
  payloads: Uint8Array[] = [];

  @OnDatagram()
  onDatagram(@Payload() payload: Uint8Array): void {
    this.payloads.push(payload);
  }
}

describe('WebTransportOtelModule', () => {
  it('registers metrics and tracing without changing handler behavior', async () => {
    const driver = new VirtualWebTransportDriver();
    const telemetry = createTelemetryRecorder();
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: { requireOrigin: false },
        }),
        WebTransportOtelModule.forRoot({
          driver,
          meter: telemetry.meter,
          tracer: telemetry.tracer,
        }),
      ],
      providers: [ObservedGateway],
    }).compile();
    await moduleRef.init();

    const client = await new TestClient(driver).connect('/observed');
    await client.sendDatagram(new Uint8Array([1, 2, 3]));
    const gateway = moduleRef.get(ObservedGateway);
    await waitFor(() => gateway.payloads.length === 1);

    expect(gateway.payloads[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(telemetry.observableInstruments).toHaveLength(10);
    expect(telemetry.spans).toContain('webtransport.datagram.ObservedGateway.onDatagram');
    expect(telemetry.handlerDurations).toHaveLength(1);
    expect(telemetry.endedSpans).toBe(1);
    await moduleRef.close();
  });
});

function createTelemetryRecorder(): {
  readonly meter: Meter;
  readonly tracer: Tracer;
  readonly observableInstruments: string[];
  readonly spans: string[];
  readonly handlerDurations: number[];
  readonly endedSpans: number;
} {
  const observableInstruments: string[] = [];
  const spans: string[] = [];
  const handlerDurations: number[] = [];
  const state = { endedSpans: 0 };
  const observable = (name: string) => ({
    addCallback: (callback: (result: { observe(value: number): void }) => void) => {
      observableInstruments.push(name);
      callback({ observe: () => {} });
    },
    removeCallback: () => {},
  });
  const meter = {
    createObservableGauge: (name: string) => observable(name),
    createObservableCounter: (name: string) => observable(name),
    createHistogram: () => ({ record: (value: number) => handlerDurations.push(value) }),
    createCounter: () => ({ add: () => {} }),
  } as unknown as Meter;
  const tracer = {
    startSpan: (name: string) => {
      spans.push(name);
      return {
        recordException: () => {},
        setStatus: () => {},
        end: () => {
          state.endedSpans += 1;
        },
      } as unknown as Span;
    },
  } as unknown as Tracer;

  return {
    meter,
    tracer,
    observableInstruments,
    spans,
    handlerDurations,
    get endedSpans() {
      return state.endedSpans;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for observed handler work.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
