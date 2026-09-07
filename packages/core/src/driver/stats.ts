import type { WebTransportServerState } from '../lifecycle/server-state.js';

export interface WebTransportConnectionStats {
  readonly sessionId: string;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly datagramsReceived: number;
  readonly datagramsSent: number;
  readonly packetsLost?: number;
  readonly smoothedRttMs?: number;
}

export interface WebTransportDriverStats {
  readonly capturedAt: number;
  readonly state: WebTransportServerState;
  readonly sessions: {
    readonly active: number;
    readonly total: number;
    readonly rejected: number;
  };
  readonly streams: {
    readonly active: number;
    readonly total: number;
  };
  readonly datagrams: {
    readonly received: number;
    readonly sent: number;
    readonly dropped: number;
  };
  readonly bytes: {
    readonly received: number;
    readonly sent: number;
  };
  readonly connections?: readonly WebTransportConnectionStats[];
}
