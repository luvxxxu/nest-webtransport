import { describe, expect, it } from 'vitest';

import { loadProductionConfig } from './config.js';

const validEnvironment = {
  WEBTRANSPORT_CERT_PATH: '/run/tls/tls.crt',
  WEBTRANSPORT_KEY_PATH: '/run/tls/tls.key',
  WEBTRANSPORT_ALLOWED_ORIGINS: 'https://app.example.com',
  WEBTRANSPORT_JWT_SECRET: 'a-secure-test-secret-with-32-bytes',
  WEBTRANSPORT_JWT_ISSUER: 'https://auth.example.com',
  WEBTRANSPORT_JWT_AUDIENCE: 'webtransport',
} as const;

describe('loadProductionConfig', () => {
  it('loads bounded ports and exact origin entries', () => {
    const config = loadProductionConfig(validEnvironment);

    expect(config.webTransportPort).toBe(4433);
    expect(config.operationsPort).toBe(3000);
    expect(config.allowedOrigins).toEqual(['https://app.example.com']);
  });

  it('rejects weak secrets and invalid ports', () => {
    expect(() =>
      loadProductionConfig({ ...validEnvironment, WEBTRANSPORT_JWT_SECRET: 'short' }),
    ).toThrow(/32/);
    expect(() => loadProductionConfig({ ...validEnvironment, WEBTRANSPORT_PORT: '70000' })).toThrow(
      /WEBTRANSPORT_PORT/,
    );
  });
});
