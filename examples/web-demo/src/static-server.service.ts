import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import type { WebDemoConfig } from './config.js';
import { bearerTokenMatches, type SessionTicketStore } from './session-ticket.store.js';

const PUBLIC_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url));
const PUBLIC_FILES: Readonly<Record<string, { file: string; contentType: string }>> = Object.freeze(
  {
    '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  },
);

@Injectable()
export class StaticServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: Server | undefined;

  constructor(
    private readonly config: WebDemoConfig,
    private readonly sessionTickets: SessionTicketStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = createServer((request, response) => {
      void this.respond(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end('Internal server error');
      });
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.httpPort, this.config.httpHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://web-demo.local').pathname;
    if (pathname === '/session-ticket') {
      this.issueSessionTicket(request, response);
      return;
    }

    if (pathname === '/config.json') {
      this.sendHeaders(response, 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          webTransportUrl: this.config.webTransportPublicUrl,
          certificateSha256: this.config.certificateSha256 ?? null,
        }),
      );
      return;
    }

    const asset = PUBLIC_FILES[pathname];
    if (asset === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const body = await readFile(resolve(PUBLIC_DIRECTORY, asset.file));
    this.sendHeaders(response, asset.contentType);
    response.end(body);
  }

  private issueSessionTicket(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST') {
      response.writeHead(405, {
        allow: 'POST',
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Method not allowed');
      return;
    }
    if (
      request.headers.origin === undefined ||
      !this.config.pageOrigins.includes(request.headers.origin)
    ) {
      response.writeHead(403, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Origin not allowed');
      return;
    }
    if (!bearerTokenMatches(request.headers.authorization, this.config.authToken)) {
      response.writeHead(401, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'www-authenticate': 'Bearer',
      });
      response.end('Invalid bearer token');
      return;
    }

    const result = this.sessionTickets.issue(request.socket.remoteAddress ?? '');
    this.sendHeaders(response, 'application/json; charset=utf-8');
    response.end(JSON.stringify(result));
  }

  private sendHeaders(response: ServerResponse, contentType: string): void {
    const connectOrigin = new URL(this.config.webTransportPublicUrl).origin;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'self'; connect-src 'self' ${connectOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
      'content-type': contentType,
      'cross-origin-opener-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
  }
}
