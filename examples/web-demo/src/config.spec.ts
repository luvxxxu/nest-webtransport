import { describe, expect, it } from 'vitest';

import { loadWebDemoConfig } from './config.js';

const environment = {
  WEB_DEMO_PAGE_ORIGIN: 'http://127.0.0.1:3000',
  WEBTRANSPORT_PUBLIC_URL: 'https://127.0.0.1:4433/demo',
  WEBTRANSPORT_TLS_CERT_PATH: './certificate.pem',
  WEBTRANSPORT_TLS_KEY_PATH: './private-key.pem',
  WEBTRANSPORT_CERT_SHA256: 'ab'.repeat(32),
  WEBTRANSPORT_AUTH_TOKEN: 'a-secure-web-demo-token-over-32-bytes',
} as const;

describe('loadWebDemoConfig', () => {
  it('loads exact origins, URLs, certificate hash, and safe defaults', () => {
    const config = loadWebDemoConfig(environment);

    expect(config.httpPort).toBe(3000);
    expect(config.webTransportPort).toBe(4433);
    expect(config.pageOrigins).toEqual(['http://127.0.0.1:3000', 'http://localhost:3000']);
    expect(config.webTransportPublicUrl).toBe('https://127.0.0.1:4433/demo');
    expect(config.certificateSha256).toBe('ab'.repeat(32));
  });

  it('rejects weak tokens, malformed hashes, and non-HTTPS transport URLs', () => {
    expect(() => loadWebDemoConfig({ ...environment, WEBTRANSPORT_AUTH_TOKEN: 'short' })).toThrow(
      /32/,
    );
    expect(() =>
      loadWebDemoConfig({ ...environment, WEBTRANSPORT_CERT_SHA256: 'not-a-hash' }),
    ).toThrow(/SHA-256/);
    expect(() =>
      loadWebDemoConfig({
        ...environment,
        WEBTRANSPORT_PUBLIC_URL: 'http://127.0.0.1:4433/demo',
      }),
    ).toThrow(/HTTPS/);
  });

  it('accepts an explicit list of page origins', () => {
    const config = loadWebDemoConfig({
      ...environment,
      WEB_DEMO_PAGE_ORIGINS: 'https://demo.example.com,https://admin.example.com',
    });

    expect(config.pageOrigins).toEqual(['https://demo.example.com', 'https://admin.example.com']);
  });
});
