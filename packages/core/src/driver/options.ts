export type WebTransportCredential =
  | {
      readonly kind: 'path';
      readonly path: string;
    }
  | {
      readonly kind: 'pem';
      readonly value: string;
    }
  | {
      readonly kind: 'bytes';
      readonly value: Uint8Array;
    };

export interface WebTransportTlsOptions {
  readonly certificate: WebTransportCredential;
  readonly privateKey: WebTransportCredential;
  readonly passphrase?: string;
}

export interface WebTransportServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly tls?: WebTransportTlsOptions;
  readonly applicationProtocols?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface DriverStopOptions {
  readonly graceful?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
