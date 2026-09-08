import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { WebTransportSession, WebTransportSessionAuthenticator } from 'nest-webtransport';

import type { ProductionConfig } from './config.js';

const MAX_AUTHORIZATION_BYTES = 8 * 1024;

export interface JwtPrincipal {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly expiresAt: number;
}

@Injectable()
export class JwtAuthenticator {
  constructor(private readonly config: ProductionConfig) {}

  readonly authenticate: WebTransportSessionAuthenticator = (session) =>
    this.verifySession(session);

  private verifySession(session: WebTransportSession): JwtPrincipal | false {
    const authorization = session.headers.get('authorization');
    if (
      authorization === null ||
      authorization.length > MAX_AUTHORIZATION_BYTES ||
      !authorization.startsWith('Bearer ')
    ) {
      return false;
    }

    try {
      return verifyHs256Jwt(authorization.slice('Bearer '.length), this.config);
    } catch {
      return false;
    }
  }
}

export function verifyHs256Jwt(token: string, config: ProductionConfig): JwtPrincipal {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = parseJsonObject(encodedHeader);
  const claims = parseJsonObject(encodedPayload);
  if (
    header.alg !== 'HS256' ||
    (header.typ !== undefined && header.typ !== 'JWT') ||
    header.crit !== undefined ||
    header.b64 !== undefined
  ) {
    throw new Error('Unsupported JWT header');
  }

  const expected = createHmac('sha256', config.jwtSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    throw new Error('JWT signature must use unpadded base64url encoding');
  }
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (
    signature.byteLength !== expected.byteLength ||
    signature.toString('base64url') !== encodedSignature ||
    !timingSafeEqual(signature, expected)
  ) {
    throw new Error('Invalid JWT signature');
  }

  const now = Math.floor(Date.now() / 1_000);
  if (
    claims.iss !== config.jwtIssuer ||
    !matchesAudience(claims.aud, config.jwtAudience) ||
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    !Number.isSafeInteger(claims.exp * 1_000) ||
    claims.exp <= now ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > now))
  ) {
    throw new Error('Invalid JWT claims');
  }

  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((role): role is string => typeof role === 'string')
    : [];
  return Object.freeze({
    userId: claims.sub,
    roles: Object.freeze(roles),
    expiresAt: claims.exp * 1_000,
  });
}

function parseJsonObject(encoded: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('JWT segments must use unpadded base64url encoding');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_AUTHORIZATION_BYTES ||
    bytes.toString('base64url') !== encoded
  ) {
    throw new Error('Invalid JWT segment size');
  }
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JWT segment is not an object');
  }
  return value as Record<string, unknown>;
}

function matchesAudience(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}
