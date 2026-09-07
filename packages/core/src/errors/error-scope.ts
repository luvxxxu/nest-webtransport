export const WebTransportErrorScope = {
  HANDLER: 'HANDLER',
  STREAM: 'STREAM',
  SESSION: 'SESSION',
  SERVER: 'SERVER',
  FATAL: 'FATAL',
} as const;

export type WebTransportErrorScope =
  (typeof WebTransportErrorScope)[keyof typeof WebTransportErrorScope];
