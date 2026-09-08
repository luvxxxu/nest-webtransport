import type { ExecutionContext } from '@nestjs/common';
import { type Attributes, context as activeContext } from '@opentelemetry/api';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedWebTransportOtelOptions } from './options.js';
import { WebTransportTracingInterceptor } from './tracing.interceptor.js';

describe('tracing isolation and propagation', () => {
  it('subscribes inside the active span and never labels credentials from the URL', async () => {
    let insideContext = false;
    let handlerContext = false;
    let ended = 0;
    const attributes: Attributes[] = [];
    const contextSpy = vi.spyOn(activeContext, 'with').mockImplementation((_ctx, fn) => {
      insideContext = true;
      try {
        return fn();
      } finally {
        insideContext = false;
      }
    });
    const interceptor = new WebTransportTracingInterceptor({
      attributes: {},
      meter: {
        createHistogram: () => ({
          record: (_value: number, labels: Attributes) => attributes.push(labels),
        }),
        createCounter: () => ({ add: () => {} }),
      },
      tracer: {
        startSpan: (_name: string, options: { attributes: Attributes }) => {
          attributes.push(options.attributes);
          return { end: () => ended++, recordException() {}, setStatus() {} };
        },
      },
    } as unknown as NormalizedWebTransportOtelOptions);
    class Gateway {}
    const host = {
      getType: () => 'webtransport',
      getClass: () => Gateway,
      getHandler: () => function event() {},
      switchToWebTransport: () => ({
        getSession: () => ({ id: 'session-1', path: '/echo?ticket=secret#fragment' }),
        getStream: () => undefined,
        getDatagram: () => new Uint8Array(),
      }),
    } as unknown as ExecutionContext;
    try {
      const result = await lastValueFrom(
        interceptor.intercept(host, {
          handle: () =>
            defer(() => {
              handlerContext = insideContext;
              return of('ok');
            }),
        }),
      );
      expect(result).toBe('ok');
      expect(handlerContext).toBe(true);
      expect(ended).toBe(1);
      expect(attributes.every((labels) => labels['webtransport.path'] === '/echo')).toBe(true);
      expect(JSON.stringify(attributes)).not.toContain('secret');
    } finally {
      contextSpy.mockRestore();
    }
  });
});

it('redacts handler exception messages and stacks by default', async () => {
  const exceptions: unknown[] = [];
  const interceptor = new WebTransportTracingInterceptor({
    attributes: {},
    meter: { createHistogram: () => ({ record() {} }), createCounter: () => ({ add() {} }) },
    tracer: {
      startSpan: () => ({
        end() {},
        recordException: (error: unknown) => exceptions.push(error),
        setStatus() {},
      }),
    },
  } as unknown as NormalizedWebTransportOtelOptions);
  const host = {
    getType: () => 'webtransport',
    getClass: () => class Gateway {},
    getHandler: () => function packet() {},
    switchToWebTransport: () => ({
      getSession: () => ({ id: '1', path: '/safe' }),
      getStream: () => undefined,
      getDatagram: () => new Uint8Array(),
    }),
  } as unknown as ExecutionContext;
  const failure = new Error('Bearer secret-token');
  await expect(
    lastValueFrom(interceptor.intercept(host, { handle: () => throwError(() => failure) })),
  ).rejects.toBe(failure);
  expect(exceptions).toEqual([{ name: 'WebTransportHandlerError', message: 'Handler failed' }]);
});
