export interface WebTransportDriverCapabilities {
  readonly datagrams: boolean;
  readonly bidirectionalStreams: boolean;
  readonly unidirectionalStreams: boolean;
  readonly gracefulShutdown: boolean;
  readonly connectionStats: boolean;
  readonly keyingMaterialExport: boolean;
}
