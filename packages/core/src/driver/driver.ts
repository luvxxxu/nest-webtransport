import type { WebTransportSession } from '../session/session.js';
import type { WebTransportDriverCapabilities } from './capabilities.js';
import type { DriverStopOptions, WebTransportServerOptions } from './options.js';
import type { WebTransportDriverStats } from './stats.js';

export type Unsubscribe = () => void;

export type WebTransportSessionCallback = (session: WebTransportSession) => void | Promise<void>;

export interface WebTransportDriver {
  readonly capabilities: WebTransportDriverCapabilities;

  start(options: WebTransportServerOptions): Promise<void>;
  stop(options?: DriverStopOptions): Promise<void>;
  onSession(callback: WebTransportSessionCallback): Unsubscribe;
  getStats(): WebTransportDriverStats;
}
