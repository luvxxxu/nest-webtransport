import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface StoredTicket {
  readonly expiresAt: number;
  readonly remoteAddress: string;
}

export class SessionTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(
    private readonly lifetimeMs = 10_000,
    private readonly maximumTickets = 256,
    private readonly now: () => number = Date.now,
  ) {}

  issue(remoteAddress: string): { ticket: string; expiresInMs: number } {
    this.removeExpired();
    if (this.tickets.size >= this.maximumTickets) {
      throw new Error('Too many pending WebTransport session tickets.');
    }

    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(digest(ticket), {
      expiresAt: this.now() + this.lifetimeMs,
      remoteAddress: normalizeAddress(remoteAddress),
    });
    return { ticket, expiresInMs: this.lifetimeMs };
  }

  consume(path: string, remoteAddress: string): boolean {
    let url: URL;
    try {
      url = new URL(path, 'https://webtransport.invalid');
    } catch {
      return false;
    }

    const supplied = url.searchParams.getAll('ticket');
    const ticket = supplied[0];
    if (
      url.pathname !== '/demo' ||
      supplied.length !== 1 ||
      ticket === undefined ||
      ticket.length > 128
    ) {
      return false;
    }

    const key = digest(ticket);
    const stored = this.tickets.get(key);
    if (stored === undefined) return false;

    this.tickets.delete(key);
    return (
      stored.expiresAt >= this.now() &&
      constantTimeTextEqual(stored.remoteAddress, normalizeAddress(remoteAddress))
    );
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(key);
    }
  }
}

export function bearerTokenMatches(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  return constantTimeTextEqual(authorization.slice('Bearer '.length), token);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function normalizeAddress(value: string): string {
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function constantTimeTextEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
