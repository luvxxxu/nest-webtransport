import { timingSafeEqual } from 'node:crypto';

export interface BasicExampleConfig {
  readonly host: string;
  readonly port: number;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly allowedOrigins: readonly string[];
  readonly authorizationHeader: string;
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('WEBTRANSPORT_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function parseAllowedOrigins(value: string): readonly string[] {
  const origins = [
    ...new Set(
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];
  if (origins.length === 0) {
    throw new Error('WEBTRANSPORT_ALLOWED_ORIGINS must contain at least one exact Origin.');
  }

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`WEBTRANSPORT_ALLOWED_ORIGINS contains an invalid Origin: ${origin}`);
    }

    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.origin !== origin ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new Error(
        `WEBTRANSPORT_ALLOWED_ORIGINS must use canonical HTTP(S) origins without paths: ${origin}`,
      );
    }
  }

  return Object.freeze(origins);
}

function buildAuthorizationHeader(token: string): string {
  if (token.length < 32) {
    throw new Error('WEBTRANSPORT_AUTH_TOKEN must contain at least 32 characters.');
  }
  return `Bearer ${token}`;
}

export function loadBasicExampleConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BasicExampleConfig {
  return Object.freeze({
    host: environment.WEBTRANSPORT_HOST?.trim() || '0.0.0.0',
    port: parsePort(environment.WEBTRANSPORT_PORT?.trim() || '4433'),
    certificatePath: requiredEnvironmentValue(environment, 'WEBTRANSPORT_TLS_CERT_PATH'),
    privateKeyPath: requiredEnvironmentValue(environment, 'WEBTRANSPORT_TLS_KEY_PATH'),
    allowedOrigins: parseAllowedOrigins(
      requiredEnvironmentValue(environment, 'WEBTRANSPORT_ALLOWED_ORIGINS'),
    ),
    authorizationHeader: buildAuthorizationHeader(
      requiredEnvironmentValue(environment, 'WEBTRANSPORT_AUTH_TOKEN'),
    ),
  });
}

export function authorizationMatches(actual: string | null, expected: string): boolean {
  if (actual === null) {
    return false;
  }

  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export const basicExampleConfig = loadBasicExampleConfig();
