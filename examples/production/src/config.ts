export interface ProductionConfig {
  readonly webTransportHost: string;
  readonly webTransportPort: number;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly allowedOrigins: readonly string[];
  readonly jwtSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly redisUrl: string;
  readonly operationsHost: string;
  readonly operationsPort: number;
}

export function loadProductionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProductionConfig {
  const allowedOrigins = required(environment, 'WEBTRANSPORT_ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (allowedOrigins.length === 0) {
    throw new Error('WEBTRANSPORT_ALLOWED_ORIGINS must contain at least one Origin.');
  }
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('WEBTRANSPORT_ALLOWED_ORIGINS must contain exact HTTPS origins.');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.hostname.includes('*')) {
      throw new Error('WEBTRANSPORT_ALLOWED_ORIGINS must contain exact HTTPS origins.');
    }
  }

  const jwtSecret = required(environment, 'WEBTRANSPORT_JWT_SECRET');
  if (new TextEncoder().encode(jwtSecret).byteLength < 32) {
    throw new Error('WEBTRANSPORT_JWT_SECRET must contain at least 32 UTF-8 bytes.');
  }
  if (/^(replace|change)[-_ ]?me|^replace-with/i.test(jwtSecret)) {
    throw new Error('WEBTRANSPORT_JWT_SECRET must be replaced with a randomly generated secret.');
  }
  const redisUrl = required(environment, 'REDIS_URL');
  try {
    const parsed = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || parsed.hostname.length === 0) {
      throw new Error('Invalid Redis URL');
    }
  } catch {
    throw new Error('REDIS_URL must be a redis:// or rediss:// URL.');
  }

  return Object.freeze({
    webTransportHost: environment.WEBTRANSPORT_HOST?.trim() || '0.0.0.0',
    webTransportPort: port(environment.WEBTRANSPORT_PORT ?? '4433', 'WEBTRANSPORT_PORT'),
    certificatePath: required(environment, 'WEBTRANSPORT_CERT_PATH'),
    privateKeyPath: required(environment, 'WEBTRANSPORT_KEY_PATH'),
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    jwtSecret,
    jwtIssuer: required(environment, 'WEBTRANSPORT_JWT_ISSUER'),
    jwtAudience: required(environment, 'WEBTRANSPORT_JWT_AUDIENCE'),
    redisUrl,
    operationsHost: environment.OPERATIONS_HOST?.trim() || '127.0.0.1',
    operationsPort: port(environment.OPERATIONS_PORT ?? '3000', 'OPERATIONS_PORT'),
  });
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

function port(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return parsed;
}
