import { resolve } from 'node:path';

export interface WebDemoConfig {
  readonly httpHost: string;
  readonly httpPort: number;
  readonly pageOrigins: readonly string[];
  readonly webTransportHost: string;
  readonly webTransportPort: number;
  readonly webTransportPublicUrl: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly certificateSha256: string | undefined;
  readonly authToken: string;
}

export function loadWebDemoConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WebDemoConfig {
  const httpHost = environment.WEB_DEMO_HTTP_HOST?.trim() || '127.0.0.1';
  const httpPort = parsePort(environment.WEB_DEMO_HTTP_PORT ?? '3000', 'WEB_DEMO_HTTP_PORT');
  const pageOrigins = parsePageOrigins(environment, httpPort);
  const webTransportPort = parsePort(environment.WEBTRANSPORT_PORT ?? '4433', 'WEBTRANSPORT_PORT');
  const publicUrl = new URL(
    environment.WEBTRANSPORT_PUBLIC_URL ?? `https://127.0.0.1:${webTransportPort}/demo`,
  );
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/demo') {
    throw new Error('WEBTRANSPORT_PUBLIC_URL must be an HTTPS URL ending in /demo.');
  }

  const authToken = required(environment, 'WEBTRANSPORT_AUTH_TOKEN');
  if (new TextEncoder().encode(authToken).byteLength < 32) {
    throw new Error('WEBTRANSPORT_AUTH_TOKEN must contain at least 32 UTF-8 bytes.');
  }

  const hash = environment.WEBTRANSPORT_CERT_SHA256?.trim().toLowerCase();
  if (hash !== undefined && hash.length > 0 && !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('WEBTRANSPORT_CERT_SHA256 must be a 64-character SHA-256 hex value.');
  }

  return Object.freeze({
    httpHost,
    httpPort,
    pageOrigins,
    webTransportHost: environment.WEBTRANSPORT_HOST?.trim() || '0.0.0.0',
    webTransportPort,
    webTransportPublicUrl: publicUrl.toString(),
    certificatePath: resolve(required(environment, 'WEBTRANSPORT_TLS_CERT_PATH')),
    privateKeyPath: resolve(required(environment, 'WEBTRANSPORT_TLS_KEY_PATH')),
    certificateSha256: hash === undefined || hash.length === 0 ? undefined : hash,
    authToken,
  });
}

function parsePageOrigins(
  environment: Readonly<Record<string, string | undefined>>,
  httpPort: number,
): readonly string[] {
  const configuredList = environment.WEB_DEMO_PAGE_ORIGINS?.trim();
  if (configuredList !== undefined && configuredList.length > 0) {
    return Object.freeze([
      ...new Set(
        configuredList
          .split(',')
          .map((value) => parseOrigin(value.trim(), 'WEB_DEMO_PAGE_ORIGINS')),
      ),
    ]);
  }

  const configured = parseOrigin(
    environment.WEB_DEMO_PAGE_ORIGIN ?? `http://127.0.0.1:${httpPort}`,
    'WEB_DEMO_PAGE_ORIGIN',
  );
  const url = new URL(configured);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return Object.freeze([configured]);
  }

  const port = url.port.length > 0 ? `:${url.port}` : '';
  return Object.freeze([`${url.protocol}//127.0.0.1${port}`, `${url.protocol}//localhost${port}`]);
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

function parsePort(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function parseOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) Origin.`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`${name} must be an exact Origin without a path or trailing slash.`);
  }
  return parsed.origin;
}
