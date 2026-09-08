import { describe, expect, it } from 'vitest';

import { bearerTokenMatches, SessionTicketStore } from './session-ticket.store.js';

describe('SessionTicketStore', () => {
  it('accepts a ticket once, for the same address', () => {
    const store = new SessionTicketStore();
    const { ticket } = store.issue('::ffff:127.0.0.1');

    expect(store.consume(`/demo?ticket=${ticket}`, '127.0.0.1')).toBe(true);
    expect(store.consume(`/demo?ticket=${ticket}`, '127.0.0.1')).toBe(false);
  });

  it('rejects expired, duplicated, and address-mismatched tickets', () => {
    let now = 100;
    const store = new SessionTicketStore(10, 4, () => now);

    const wrongAddress = store.issue('127.0.0.1').ticket;
    expect(store.consume(`/demo?ticket=${wrongAddress}`, '127.0.0.2')).toBe(false);

    const duplicated = store.issue('127.0.0.1').ticket;
    expect(store.consume(`/demo?ticket=${duplicated}&ticket=${duplicated}`, '127.0.0.1')).toBe(
      false,
    );

    const expired = store.issue('127.0.0.1').ticket;
    now = 111;
    expect(store.consume(`/demo?ticket=${expired}`, '127.0.0.1')).toBe(false);
  });

  it('expires at the exact deadline and reclaims ticket capacity at that boundary', () => {
    let now = 100;
    const store = new SessionTicketStore(10, 1, () => now);
    const first = store.issue('127.0.0.1').ticket;
    now = 110;
    expect(store.consume(`/demo?ticket=${first}`, '127.0.0.1')).toBe(false);
    store.issue('127.0.0.1');
    now = 120;
    expect(() => store.issue('127.0.0.1')).not.toThrow();
  });
});

describe('bearerTokenMatches', () => {
  it('only accepts an exact bearer token', () => {
    expect(bearerTokenMatches('Bearer correct-token', 'correct-token')).toBe(true);
    expect(bearerTokenMatches('Bearer wrong-token', 'correct-token')).toBe(false);
    expect(bearerTokenMatches(undefined, 'correct-token')).toBe(false);
  });
});
