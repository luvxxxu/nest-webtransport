export interface SessionContext<Principal = unknown> {
  readonly sessionId: string;
  principal?: Principal;
  readonly metadata: Map<symbol, unknown>;
  readonly createdAt: number;
  readonly signal: AbortSignal;
}
