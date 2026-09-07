import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { GatewayExplorer } from './discovery/gateway-explorer.js';
import { WebTransportExecutionPipeline } from './execution/execution-pipeline.js';
import type {
  WebTransportModuleAsyncOptions,
  WebTransportModuleOptions,
} from './interfaces/module-options.interface.js';
import {
  type NormalizedWebTransportModuleOptions,
  normalizeWebTransportModuleOptions,
} from './module/options.js';
import { WEBTRANSPORT_DRIVER, WEBTRANSPORT_MODULE_OPTIONS } from './module/tokens.js';
import { GatewayRegistry } from './routing/gateway-registry.js';
import { WebTransportHealthService } from './server/webtransport-health.service.js';
import { WebTransportRuntime } from './server/webtransport-runtime.js';

const INFRASTRUCTURE_PROVIDERS = [
  GatewayRegistry,
  GatewayExplorer,
  WebTransportExecutionPipeline,
] as const;

const RUNTIME_PROVIDERS = [WebTransportRuntime, WebTransportHealthService] as const;

@Module({
  imports: [DiscoveryModule],
  providers: [...INFRASTRUCTURE_PROVIDERS],
})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules conventionally expose static registration methods.
export class WebTransportModule {
  static forRoot(options: WebTransportModuleOptions): DynamicModule {
    const normalized = normalizeWebTransportModuleOptions(options);

    return {
      module: WebTransportModule,
      providers: [
        {
          provide: WEBTRANSPORT_MODULE_OPTIONS,
          useValue: normalized,
        },
        {
          provide: WEBTRANSPORT_DRIVER,
          useValue: normalized.driver,
        },
        ...RUNTIME_PROVIDERS,
      ],
      exports: [WEBTRANSPORT_DRIVER, WebTransportHealthService],
    };
  }

  static forRootAsync(options: WebTransportModuleAsyncOptions): DynamicModule {
    const normalizedOptionsProvider: FactoryProvider<NormalizedWebTransportModuleOptions> = {
      provide: WEBTRANSPORT_MODULE_OPTIONS,
      inject: [...(options.inject ?? [])] as NonNullable<FactoryProvider['inject']>,
      useFactory: async (...dependencies: readonly unknown[]) =>
        normalizeWebTransportModuleOptions(await options.useFactory(...dependencies)),
    };

    return {
      module: WebTransportModule,
      imports: options.imports === undefined ? [] : [...options.imports],
      providers: [
        normalizedOptionsProvider,
        {
          provide: WEBTRANSPORT_DRIVER,
          inject: [WEBTRANSPORT_MODULE_OPTIONS],
          useFactory: (resolved: NormalizedWebTransportModuleOptions) => resolved.driver,
        },
        ...RUNTIME_PROVIDERS,
      ],
      exports: [WEBTRANSPORT_DRIVER, WebTransportHealthService],
    };
  }
}
