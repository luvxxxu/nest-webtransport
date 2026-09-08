export interface WebTransportRuntimeStats {
  readonly sessions: {
    readonly accepted: number;
    readonly rejected: number;
    readonly rejections: Readonly<Record<string, number>>;
  };
  readonly datagrams: {
    readonly dropped: number;
    readonly drops: Readonly<Record<string, number>>;
    readonly queuedBytes: number;
  };
  readonly handlers: {
    readonly active: number;
    readonly outstanding: number;
    readonly rejected: number;
  };
  readonly logs: { readonly suppressed: number };
}
