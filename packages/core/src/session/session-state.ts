export const WebTransportSessionState = {
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
} as const;

export type WebTransportSessionState =
  (typeof WebTransportSessionState)[keyof typeof WebTransportSessionState];
