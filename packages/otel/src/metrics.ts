import { type Attributes, type Meter, metrics, type Observable } from '@opentelemetry/api';
import type { WebTransportDriver, WebTransportDriverStats } from 'webtransport-core';

import type { WebTransportOtelOptions } from './options.js';

export type WebTransportMetricsOptions = Omit<WebTransportOtelOptions, 'driver'>;

interface MetricBinding {
  readonly instrument: Observable;
  readonly callback: Parameters<Observable['addCallback']>[0];
}

export class WebTransportMetrics {
  readonly meter: Meter;

  private readonly bindings: MetricBinding[] = [];
  private enabled = false;

  constructor(
    private readonly driver: WebTransportDriver,
    options: WebTransportMetricsOptions = {},
  ) {
    this.meter =
      options.meter ?? metrics.getMeter(options.instrumentationName ?? 'nest-webtransport');
    const attributes = Object.freeze({ ...(options.attributes ?? {}) });

    this.bindGauge(
      'webtransport.sessions.active',
      'Current active WebTransport sessions',
      attributes,
      (stats) => stats.sessions.active,
    );
    this.bindCounter(
      'webtransport.sessions.total',
      'Accepted WebTransport sessions since process start',
      attributes,
      (stats) => stats.sessions.total,
    );
    this.bindCounter(
      'webtransport.sessions.rejected',
      'Rejected WebTransport sessions since process start',
      attributes,
      (stats) => stats.sessions.rejected,
    );
    this.bindGauge(
      'webtransport.streams.active',
      'Current active WebTransport streams',
      attributes,
      (stats) => stats.streams.active,
    );
    this.bindCounter(
      'webtransport.streams.total',
      'WebTransport streams since process start',
      attributes,
      (stats) => stats.streams.total,
    );
    this.bindCounter(
      'webtransport.datagrams.received',
      'Received WebTransport datagrams since process start',
      attributes,
      (stats) => stats.datagrams.received,
    );
    this.bindCounter(
      'webtransport.datagrams.sent',
      'Sent WebTransport datagrams since process start',
      attributes,
      (stats) => stats.datagrams.sent,
    );
    this.bindCounter(
      'webtransport.datagrams.dropped',
      'Dropped WebTransport datagrams since process start',
      attributes,
      (stats) => stats.datagrams.dropped,
    );
    this.bindCounter(
      'webtransport.bytes.received',
      'Received WebTransport bytes since process start',
      attributes,
      (stats) => stats.bytes.received,
    );
    this.bindCounter(
      'webtransport.bytes.sent',
      'Sent WebTransport bytes since process start',
      attributes,
      (stats) => stats.bytes.sent,
    );
    const runtimeStats = options.runtimeStats;
    if (runtimeStats !== undefined) {
      const bindings = [
        ['webtransport.runtime.sessions.accepted', false, () => runtimeStats().sessions.accepted],
        ['webtransport.runtime.sessions.rejected', false, () => runtimeStats().sessions.rejected],
        ['webtransport.runtime.datagrams.dropped', false, () => runtimeStats().datagrams.dropped],
        [
          'webtransport.runtime.datagrams.queued_bytes',
          true,
          () => runtimeStats().datagrams.queuedBytes,
        ],
        ['webtransport.runtime.handlers.active', true, () => runtimeStats().handlers.active],
        [
          'webtransport.runtime.handlers.outstanding',
          true,
          () => runtimeStats().handlers.outstanding,
        ],
        ['webtransport.runtime.handlers.rejected', false, () => runtimeStats().handlers.rejected],
        ['webtransport.runtime.logs.suppressed', false, () => runtimeStats().logs.suppressed],
      ] as const;
      for (const [name, gauge, read] of bindings) {
        const instrument = gauge
          ? this.meter.createObservableGauge(name)
          : this.meter.createObservableCounter(name);
        this.bindings.push({
          instrument,
          callback: (result) => result.observe(read(), attributes),
        });
      }
      for (const [name, read] of [
        ['webtransport.runtime.sessions.rejections', () => runtimeStats().sessions.rejections],
        ['webtransport.runtime.datagrams.drops', () => runtimeStats().datagrams.drops],
      ] as const) {
        const instrument = this.meter.createObservableCounter(name);
        this.bindings.push({
          instrument,
          callback: (result) => {
            for (const [reason, value] of Object.entries(read()))
              result.observe(value, { ...attributes, reason });
          },
        });
      }
    }
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    for (const binding of this.bindings) binding.instrument.addCallback(binding.callback);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    for (const binding of this.bindings) binding.instrument.removeCallback(binding.callback);
  }

  private bindGauge(
    name: string,
    description: string,
    attributes: Attributes,
    read: (stats: WebTransportDriverStats) => number,
  ): void {
    const instrument = this.meter.createObservableGauge(name, { description });
    this.bindings.push({
      instrument,
      callback: (result) => result.observe(read(this.driver.getStats()), attributes),
    });
  }

  private bindCounter(
    name: string,
    description: string,
    attributes: Attributes,
    read: (stats: WebTransportDriverStats) => number,
  ): void {
    const instrument = this.meter.createObservableCounter(name, { description });
    this.bindings.push({
      instrument,
      callback: (result) => result.observe(read(this.driver.getStats()), attributes),
    });
  }
}
