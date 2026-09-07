import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { ProductionConfig } from './config.js';
import { verifyHs256Jwt } from './jwt-authenticator.js';

const config: ProductionConfig = {
  webTransportHost: '127.0.0.1',
  webTransportPort: 4433,
  certificatePath: '/tmp/cert',
  privateKeyPath: '/tmp/key',
  allowedOrigins: ['https://app.example.com'],
  jwtSecret: 'a-secure-test-secret-with-32-bytes',
  jwtIssuer: 'https://auth.example.com',
  jwtAudience: 'webtransport',
  redisUrl: 'redis://127.0.0.1:6379',
  operationsHost: '127.0.0.1',
  operationsPort: 3000,
};

describe('verifyHs256Jwt', () => {
  it('verifies the signature and required claims', () => {
    const token = sign({
      sub: 'user-1',
      iss: config.jwtIssuer,
      aud: config.jwtAudience,
      exp: Math.floor(Date.now() / 1_000) + 60,
      roles: ['member'],
    });

    expect(verifyHs256Jwt(token, config)).toEqual({ userId: 'user-1', roles: ['member'] });
  });

  it('rejects expired, wrong-audience, and tampered tokens', () => {
    const base = {
      sub: 'user-1',
      iss: config.jwtIssuer,
      aud: config.jwtAudience,
      exp: Math.floor(Date.now() / 1_000) + 60,
    };
    expect(() => verifyHs256Jwt(sign({ ...base, exp: 1 }), config)).toThrow(/claims/);
    expect(() => verifyHs256Jwt(sign({ ...base, aud: 'other' }), config)).toThrow(/claims/);

    const valid = sign(base);
    expect(() => verifyHs256Jwt(`${valid.slice(0, -1)}x`, config)).toThrow(/signature/);
  });
});

function sign(claims: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', config.jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
