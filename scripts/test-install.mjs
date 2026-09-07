import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'nest-webtransport-install-'));
try {
  const dependencies = {};
  for (const entry of await readdir(join(root, 'packages'))) {
    const directory = join(root, 'packages', entry);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const tarball = join(temporary, `${manifest.name}.tgz`);
    execFileSync('bun', ['pm', 'pack', '--filename', tarball], { cwd: directory, stdio: 'pipe' });
    const packed = JSON.parse(
      execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    assert.equal(packed.license, 'MIT');
    assert.equal(packed.version, '0.1.0');
    assert.ok(
      !JSON.stringify(packed).includes('workspace:'),
      'Published metadata must not contain workspace references',
    );
    const files = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' });
    assert.ok(files.includes('package/LICENSE'));
    assert.ok(!/\.spec\.|\.test\.|\.env/.test(files), 'Do not publish tests or secrets');
    dependencies[manifest.name] = `file:${tarball}`;
  }
  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of [
    '@nestjs/common',
    '@nestjs/core',
    'reflect-metadata',
    'rxjs',
    '@opentelemetry/api',
    'typescript',
    '@types/node',
  ]) {
    dependencies[name] = workspace.devDependencies[name];
  }
  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({ name: 'release-install-probe', private: true, type: 'module', dependencies }),
  );
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: temporary,
    stdio: 'pipe',
    timeout: 180_000,
  });
  await writeFile(
    join(temporary, 'probe.mjs'),
    `
    import 'reflect-metadata';
    import assert from 'node:assert/strict';
    import { NestFactory } from '@nestjs/core';
    import { Module } from '@nestjs/common';
    import { WebTransportModule, WebTransportHealthService } from 'nest-webtransport';
    import { VirtualWebTransportDriver } from 'nest-webtransport-testing';
    import { RWebTransportDriver } from 'webtransport-driver-rwebtransport';
    import { WebTransportOtelModule } from 'nest-webtransport-otel';
    const driver = new VirtualWebTransportDriver();
    class App {}
    Module({imports: [WebTransportModule.forRoot({driver, server: {port: 0}, security: {requireOrigin: false}}), WebTransportOtelModule.forRoot({driver})]})(App);
    const app = await NestFactory.createApplicationContext(App, {logger: false});
    assert.equal(app.get(WebTransportHealthService).getStatus().ready, true);
    assert.equal(new RWebTransportDriver().getStats().state, 'STOPPED');
    await app.close();
    assert.equal(driver.getStats().state, 'STOPPED');
  `,
  );
  execFileSync(process.execPath, ['probe.mjs'], { cwd: temporary, stdio: 'pipe', timeout: 30_000 });
  await writeFile(
    join(temporary, 'probe.ts'),
    `
    import { WebTransportModule, type WebTransportSession } from 'nest-webtransport';
    import { RWebTransportDriver } from 'webtransport-driver-rwebtransport';
    import { VirtualWebTransportDriver, TestClient } from 'nest-webtransport-testing';
    import { WebTransportOtelModule } from 'nest-webtransport-otel';
    import { BoundedQueue } from 'webtransport-core';
    const driver = new RWebTransportDriver();
    WebTransportModule.forRoot({driver, server: {port: 0}, security: {requireOrigin: false}});
    WebTransportOtelModule.forRoot({driver});
    new TestClient(new VirtualWebTransportDriver());
    new BoundedQueue<WebTransportSession>({capacity: 1, overflow: 'reject'});
  `,
  );
  execFileSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2023',
      '--skipLibCheck',
      'false',
      'probe.ts',
    ],
    { cwd: temporary, stdio: 'pipe', timeout: 30_000 },
  );
  console.log(
    'All five packed packages install, load, bootstrap Nest and typecheck outside the workspace.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
