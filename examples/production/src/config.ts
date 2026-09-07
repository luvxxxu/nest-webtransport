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

  const jwtSecret = required(environment, 'WEBTRANSPORT_JWT_SECRET');
  if (new TextEncoder().encode(jwtSecret).byteLength < 32) {
    throw new Error('WEBTRANSPORT_JWT_SECRET must contain at least 32 UTF-8 bytes.');
  }

  return Object.freeze({
    webTransportHost: environment.WEBTRANSPORT_HOST ?? '0.0.0.0',
    webTransportPort: port(environment.WEBTRANSPORT_PORT ?? '4433', 'WEBTRANSPORT_PORT'),
    certificatePath: required(environment, 'WEBTRANSPORT_CERT_PATH'),
    privateKeyPath: required(environment, 'WEBTRANSPORT_KEY_PATH'),
    allowedOrigins: Object.freeze(allowedOrigins),
    jwtSecret,
    jwtIssuer: required(environment, 'WEBTRANSPORT_JWT_ISSUER'),
    jwtAudience: required(environment, 'WEBTRANSPORT_JWT_AUDIENCE'),
    redisUrl: environment.REDIS_URL ?? 'redis://127.0.0.1:6379',
    operationsHost: environment.OPERATIONS_HOST ?? '0.0.0.0',
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
