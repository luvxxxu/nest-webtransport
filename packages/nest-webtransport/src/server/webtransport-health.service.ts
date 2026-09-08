import { Inject, Injectable } from '@nestjs/common';
import {
  type WebTransportDriverStats,
  type WebTransportLifecycleSnapshot,
  WebTransportServerState,
} from 'webtransport-core';
import type { WebTransportRuntimeStats } from './runtime-stats.js';
import { WebTransportRuntime } from './webtransport-runtime.js';

export interface WebTransportHealthStatus {
  readonly alive: boolean;
  readonly ready: boolean;
  readonly lifecycle: WebTransportLifecycleSnapshot;
  readonly activeSessions: number;
}

@Injectable()
export class WebTransportHealthService {
  constructor(
    @Inject(WebTransportRuntime)
    private readonly runtime: WebTransportRuntime,
  ) {}

  getStatus(): WebTransportHealthStatus {
    const lifecycle = this.runtime.snapshot;
    const driverState = this.runtime.driver.getStats().state;
    return Object.freeze({
      alive:
        lifecycle.alive &&
        !(
          lifecycle.state === WebTransportServerState.RUNNING &&
          driverState !== WebTransportServerState.RUNNING
        ),
      ready: lifecycle.ready && driverState === WebTransportServerState.RUNNING,
      lifecycle,
      activeSessions: this.runtime.activeSessions,
    });
  }

  getDriverStats(): WebTransportDriverStats {
    return this.runtime.driver.getStats();
  }

  getRuntimeStats(): WebTransportRuntimeStats {
    return this.runtime.getStats();
  }
}
