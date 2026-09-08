import type { InjectionToken, Type } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper.js';

import type { WebTransportHandlerKind, WebTransportParameterMetadata } from '../metadata/types.js';

export interface CompiledWebTransportHandler {
  readonly gatewayPath: string;
  readonly kind: WebTransportHandlerKind;
  readonly route: string | undefined;
  readonly instance: object;
  readonly metatype: Type<unknown>;
  readonly methodName: string;
  readonly callback: (...args: readonly unknown[]) => unknown;
  readonly parameters: readonly WebTransportParameterMetadata[];
  readonly parameterTypes: readonly unknown[];
  readonly providerToken?: InjectionToken;
  readonly moduleRef?: ModuleRef;
  readonly providerHost?: InstanceWrapper['host'];
}

@Injectable()
export class GatewayRegistry {
  private readonly handlers = new Map<string, CompiledWebTransportHandler[]>();
  private readonly paths = new Set<string>();
  private readonly handlerKinds = new Set<string>();

  clear(): void {
    this.handlers.clear();
    this.paths.clear();
    this.handlerKinds.clear();
  }

  register(handler: CompiledWebTransportHandler): void {
    this.paths.add(normalizeGatewayPath(handler.gatewayPath));
    this.handlerKinds.add(handlerKindKey(handler.gatewayPath, handler.kind));
    const key = registryKey(handler.gatewayPath, handler.kind, handler.route);
    const handlers = this.handlers.get(key);

    if (handlers === undefined) {
      this.handlers.set(key, [handler]);
      return;
    }

    handlers.push(handler);
  }

  find(
    path: string,
    kind: WebTransportHandlerKind,
    route?: string,
  ): readonly CompiledWebTransportHandler[] {
    const normalizedPath = normalizeGatewayPath(path);
    const exact =
      route === undefined || route === ''
        ? undefined
        : this.handlers.get(registryKey(normalizedPath, kind, route));
    const fallback = this.handlers.get(registryKey(normalizedPath, kind, undefined));

    if (exact === undefined) {
      return fallback === undefined ? [] : [...fallback];
    }

    if (fallback === undefined) {
      return [...exact];
    }

    return [...exact, ...fallback];
  }

  get size(): number {
    let count = 0;
    for (const handlers of this.handlers.values()) {
      count += handlers.length;
    }
    return count;
  }

  list(): readonly CompiledWebTransportHandler[] {
    return [...this.handlers.values()].flat();
  }

  hasPath(path: string): boolean {
    return this.paths.has(normalizeGatewayPath(path));
  }

  hasHandlers(path: string, kind: WebTransportHandlerKind): boolean {
    return this.handlerKinds.has(handlerKindKey(path, kind));
  }
}

export function normalizeGatewayPath(path: string): string {
  let pathname: string;
  try {
    pathname = new URL(path, 'https://webtransport.invalid').pathname;
  } catch {
    pathname = path;
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function registryKey(
  path: string,
  kind: WebTransportHandlerKind,
  route: string | undefined,
): string {
  return `${normalizeGatewayPath(path)}\u0000${kind}\u0000${route ?? ''}`;
}

function handlerKindKey(path: string, kind: WebTransportHandlerKind): string {
  return `${normalizeGatewayPath(path)}\u0000${kind}`;
}
