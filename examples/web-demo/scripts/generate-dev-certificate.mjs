import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const certificateDirectory = resolve(exampleDirectory, '.cert');
const certificatePath = resolve(certificateDirectory, 'certificate.pem');
const privateKeyPath = resolve(certificateDirectory, 'private-key.pem');
mkdirSync(certificateDirectory, { recursive: true });

execFileSync(
  'openssl',
  ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', privateKeyPath],
  { stdio: 'inherit' },
);

execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-new',
    '-sha256',
    '-days',
    '13',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext',
    'basicConstraints=critical,CA:FALSE',
    '-addext',
    'keyUsage=critical,digitalSignature',
    '-addext',
    'extendedKeyUsage=serverAuth',
    '-key',
    privateKeyPath,
    '-out',
    certificatePath,
  ],
  { stdio: 'inherit' },
);

const der = execFileSync('openssl', ['x509', '-in', certificatePath, '-outform', 'DER']);
const hash = createHash('sha256').update(der).digest('hex');
const token = randomBytes(32).toString('base64url');
const environment = `WEB_DEMO_HTTP_HOST=127.0.0.1
WEB_DEMO_HTTP_PORT=3000
WEB_DEMO_PAGE_ORIGINS=http://127.0.0.1:3000,http://localhost:3000
WEBTRANSPORT_HOST=0.0.0.0
WEBTRANSPORT_PORT=4433
WEBTRANSPORT_PUBLIC_URL=https://127.0.0.1:4433/demo
WEBTRANSPORT_TLS_CERT_PATH=${certificatePath}
WEBTRANSPORT_TLS_KEY_PATH=${privateKeyPath}
WEBTRANSPORT_CERT_SHA256=${hash}
WEBTRANSPORT_AUTH_TOKEN=${token}
`;
writeFileSync(resolve(exampleDirectory, '.env'), environment, { mode: 0o600 });

process.stdout.write(`\nDevelopment certificate and .env created.\nSHA-256: ${hash}\n`);
