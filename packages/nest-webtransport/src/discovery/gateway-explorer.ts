import { Inject, Injectable, type OnModuleInit, type Type } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import {
  WEBTRANSPORT_GATEWAY_METADATA,
  WEBTRANSPORT_HANDLER_METADATA,
  WEBTRANSPORT_PARAMETER_METADATA,
} from '../metadata/constants.js';
import type {
  WebTransportGatewayOptions,
  WebTransportHandlerMetadata,
  WebTransportParameterMetadata,
} from '../metadata/types.js';
import { GatewayRegistry } from '../routing/gateway-registry.js';

interface DiscoverableWrapper {
  readonly instance?: object | null;
  readonly metatype?: Type<unknown> | null;
}

@Injectable()
export class GatewayExplorer implements OnModuleInit {
  constructor(
    @Inject(DiscoveryService)
    private readonly discoveryService: DiscoveryService,
    @Inject(MetadataScanner)
    private readonly metadataScanner: MetadataScanner,
    @Inject(GatewayRegistry)
    private readonly registry: GatewayRegistry,
  ) {}

  onModuleInit(): void {
    this.explore();
  }

  explore(): void {
    this.registry.clear();

    for (const wrapper of this.discoveryService.getProviders() as DiscoverableWrapper[]) {
      this.exploreProvider(wrapper);
    }
  }

  private exploreProvider(wrapper: DiscoverableWrapper): void {
    const { instance, metatype } = wrapper;
    if (metatype == null) {
      return;
    }

    const gateway = Reflect.getMetadata(WEBTRANSPORT_GATEWAY_METADATA, metatype) as
      | WebTransportGatewayOptions
      | undefined;
    if (gateway === undefined) {
      return;
    }

    const prototype = metatype.prototype as object | null;
    const discoveryTarget = instance ?? prototype;
    if (discoveryTarget === null) {
      return;
    }
    for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
      const callback = Reflect.get(discoveryTarget, methodName) as unknown;
      if (typeof callback !== 'function') {
        continue;
      }

      const handler = Reflect.getMetadata(WEBTRANSPORT_HANDLER_METADATA, callback) as
        | WebTransportHandlerMetadata
        | undefined;
      if (handler === undefined) {
        continue;
      }

      // Read arguments from the prototype that declares this method. Inherited
      // methods keep their decorators; overrides must not inherit stale arguments.
      let declaringPrototype = prototype;
      while (declaringPrototype !== null && !Object.hasOwn(declaringPrototype, methodName)) {
        declaringPrototype = Object.getPrototypeOf(declaringPrototype) as object | null;
      }

      const parameters =
        (declaringPrototype === null
          ? undefined
          : (Reflect.getOwnMetadata(
              WEBTRANSPORT_PARAMETER_METADATA,
              declaringPrototype,
              methodName,
            ) as readonly WebTransportParameterMetadata[] | undefined)) ?? [];
      const parameterTypes =
        (declaringPrototype === null
          ? undefined
          : (Reflect.getOwnMetadata('design:paramtypes', declaringPrototype, methodName) as
              | readonly unknown[]
              | undefined)) ?? [];

      this.registry.register({
        gatewayPath: gateway.path,
        kind: handler.kind,
        route: handler.route,
        instance: discoveryTarget,
        metatype,
        methodName,
        callback: callback as (...args: readonly unknown[]) => unknown,
        parameters,
        parameterTypes,
      });
    }
  }
}
