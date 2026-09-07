export const WebTransportServerState = {
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  DRAINING: 'DRAINING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
} as const;

export type WebTransportServerState =
  (typeof WebTransportServerState)[keyof typeof WebTransportServerState];
