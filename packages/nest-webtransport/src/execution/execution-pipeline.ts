import {
  type ArgumentMetadata,
  type CanActivate,
  type ExceptionFilter,
  ForbiddenException,
  Inject,
  Injectable,
  type NestInterceptor,
  type PipeTransform,
  type Type,
} from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  FILTER_CATCH_EXCEPTIONS,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PIPES_METADATA,
} from '@nestjs/common/constants';
import { ApplicationConfig, type ContextId, ModuleRef } from '@nestjs/core';
import {
  InvalidClassScopeException,
  UnknownElementException,
} from '@nestjs/core/errors/exceptions/index.js';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper.js';
import { defer, from, isObservable, lastValueFrom, type Observable, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

import {
  WebTransportExecutionContextHost,
  type WebTransportHandlerArguments,
} from '../context/webtransport-arguments-host.js';
import type { CompiledWebTransportHandler } from '../routing/gateway-registry.js';

type EnhancerClass<T> = Type<T>;
type Enhancer<T> = T | EnhancerClass<T>;

@Injectable()
export class WebTransportExecutionPipeline {
  private readonly createdEnhancers = new WeakMap<ModuleRef, Map<object, Promise<unknown>>>();

  constructor(
    @Inject(ModuleRef)
    private readonly moduleRef: ModuleRef,
    @Inject(ApplicationConfig)
    private readonly applicationConfig: ApplicationConfig,
  ) {}

  async invoke(
    handler: CompiledWebTransportHandler,
    transportArguments: WebTransportHandlerArguments,
    contextId?: ContextId,
  ): Promise<unknown> {
    const signal = transportArguments[4].signal;
    signal.throwIfAborted();
    const instance = await this.resolveGateway(handler, contextId);
    signal.throwIfAborted();
    const callback = Reflect.get(instance, handler.methodName) as unknown;
    if (typeof callback !== 'function') {
      throw new TypeError(
        `WebTransport gateway method ${handler.metatype.name}.${handler.methodName} is not callable.`,
      );
    }
    const context = new WebTransportExecutionContextHost(
      transportArguments,
      handler.metatype,
      callback as (...args: readonly unknown[]) => unknown,
    );

    try {
      await this.activateGuards(handler, context, contextId);
      const requestInterceptors = await this.resolveRequestEnhancers(
        this.applicationConfig.getGlobalRequestInterceptors(),
        contextId,
      );
      const interceptors = await this.resolveEnhancers<NestInterceptor>(
        [
          ...this.applicationConfig.getGlobalInterceptors(),
          ...requestInterceptors,
          ...readEnhancers<NestInterceptor>(INTERCEPTORS_METADATA, handler.metatype),
          ...readEnhancers<NestInterceptor>(INTERCEPTORS_METADATA, handler.callback),
        ],
        contextId,
        handler.moduleRef,
        handler.providerHost,
      );

      signal.throwIfAborted();
      const result = this.runInterceptors(interceptors, context, async () => {
        signal.throwIfAborted();
        const args = await this.createArguments(handler, transportArguments, contextId);
        signal.throwIfAborted();
        return callback.apply(instance, args);
      });
      return await lastValueFrom(result);
    } catch (error) {
      if (signal.aborted) throw error;
      return this.handleException(error, handler, context, contextId);
    }
  }

  private async activateGuards(
    handler: CompiledWebTransportHandler,
    context: WebTransportExecutionContextHost,
    contextId?: ContextId,
  ): Promise<void> {
    const requestGuards = await this.resolveRequestEnhancers(
      this.applicationConfig.getGlobalRequestGuards(),
      contextId,
    );
    const guards = await this.resolveEnhancers<CanActivate>(
      [
        ...this.applicationConfig.getGlobalGuards(),
        ...requestGuards,
        ...readEnhancers<CanActivate>(GUARDS_METADATA, handler.metatype),
        ...readEnhancers<CanActivate>(GUARDS_METADATA, handler.callback),
      ],
      contextId,
      handler.moduleRef,
      handler.providerHost,
    );

    for (const guard of guards) {
      const signal = context.switchToWebTransport().getSessionContext().signal;
      signal.throwIfAborted();
      const decision = guard.canActivate(context);
      const allowed = isObservable(decision) ? await lastValueFrom(decision) : await decision;
      signal.throwIfAborted();
      if (!allowed) {
        throw new ForbiddenException('WebTransport session or event was rejected by a guard.');
      }
    }
  }

  private async createArguments(
    handler: CompiledWebTransportHandler,
    transportArguments: WebTransportHandlerArguments,
    contextId?: ContextId,
  ): Promise<unknown[]> {
    const maxParameterIndex = handler.parameters.reduce(
      (highest, parameter) => Math.max(highest, parameter.index),
      -1,
    );
    const args = new Array<unknown>(Math.max(handler.callback.length, maxParameterIndex + 1));
    const requestPipes = await this.resolveRequestEnhancers(
      this.applicationConfig.getGlobalRequestPipes(),
      contextId,
    );
    const sharedPipes = await this.resolveEnhancers<PipeTransform>(
      [
        ...this.applicationConfig.getGlobalPipes(),
        ...requestPipes,
        ...readEnhancers<PipeTransform>(PIPES_METADATA, handler.metatype),
        ...readEnhancers<PipeTransform>(PIPES_METADATA, handler.callback),
      ],
      contextId,
      handler.moduleRef,
      handler.providerHost,
    );

    await Promise.all(
      handler.parameters.map(async (parameter) => {
        const parameterPipes = await this.resolveEnhancers<PipeTransform>(
          parameter.pipes,
          contextId,
          handler.moduleRef,
          handler.providerHost,
        );
        let value = extractParameter(parameter.kind, transportArguments);
        const metadata: ArgumentMetadata = {
          type: 'custom',
          metatype: handler.parameterTypes[parameter.index] as Type<unknown> | undefined,
          data: parameter.kind,
        };

        for (const pipe of [...sharedPipes, ...parameterPipes]) {
          transportArguments[4].signal.throwIfAborted();
          value = await pipe.transform(value, metadata);
        }
        args[parameter.index] = value;
      }),
    );

    return args;
  }

  private runInterceptors(
    interceptors: readonly NestInterceptor[],
    context: WebTransportExecutionContextHost,
    invokeHandler: () => unknown,
  ): Observable<unknown> {
    const dispatch = (index: number): Observable<unknown> => {
      context.switchToWebTransport().getSessionContext().signal.throwIfAborted();
      const interceptor = interceptors[index];
      if (interceptor === undefined) {
        return toObservable(invokeHandler);
      }

      return defer(() =>
        from(
          Promise.resolve(interceptor.intercept(context, { handle: () => dispatch(index + 1) })),
        ),
      ).pipe(mergeMap((stream) => stream));
    };

    return dispatch(0);
  }

  private async handleException(
    error: unknown,
    handler: CompiledWebTransportHandler,
    context: WebTransportExecutionContextHost,
    contextId?: ContextId,
  ): Promise<unknown> {
    const requestFilters = await this.resolveRequestEnhancers(
      this.applicationConfig.getGlobalRequestFilters(),
      contextId,
    );
    const filters = await this.resolveEnhancers<ExceptionFilter>(
      [
        ...this.applicationConfig.getGlobalFilters(),
        ...requestFilters,
        ...readEnhancers<ExceptionFilter>(EXCEPTION_FILTERS_METADATA, handler.metatype),
        ...readEnhancers<ExceptionFilter>(EXCEPTION_FILTERS_METADATA, handler.callback),
      ].reverse(),
      contextId,
      handler.moduleRef,
      handler.providerHost,
    );

    for (const filter of filters) {
      const caughtTypes =
        (Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, filter.constructor) as
          | readonly Type<unknown>[]
          | undefined) ?? [];
      if (
        caughtTypes.length === 0 ||
        caughtTypes.some((caughtType) => error instanceof caughtType)
      ) {
        return filter.catch(error, context);
      }
    }

    throw error;
  }

  private async resolveEnhancers<T>(
    enhancers: readonly Enhancer<T>[],
    contextId?: ContextId,
    owner?: ModuleRef,
    host?: InstanceWrapper['host'],
  ): Promise<T[]> {
    return Promise.all(
      enhancers.map((enhancer) => this.resolveEnhancer(enhancer, contextId, owner, host)),
    );
  }

  private async resolveEnhancer<T>(
    enhancer: Enhancer<T>,
    contextId?: ContextId,
    owner?: ModuleRef,
    host?: InstanceWrapper['host'],
  ): Promise<T> {
    if (typeof enhancer !== 'function') {
      return enhancer;
    }
    const enhancerType = enhancer as Type<T>;
    const providerHost =
      host === undefined ? undefined : findVisibleProviderHost(host, enhancerType);
    const providerRef = providerHost?.providers.get(ModuleRef)?.instance as ModuleRef | undefined;
    const moduleRef = providerRef ?? owner ?? this.moduleRef;
    const strict = owner !== undefined;

    try {
      return moduleRef.get(enhancerType, { strict });
    } catch (error) {
      if (error instanceof InvalidClassScopeException) {
        // A registered provider must retain its factory, scope and failures.
        // Recreating the metatype here could bypass a failed authorization DI
        // factory by silently substituting a different instance.
        return moduleRef.resolve(enhancerType, contextId, { strict });
      }
      if (!(error instanceof UnknownElementException)) {
        throw error;
      }
      if (contextId !== undefined) {
        return moduleRef.create(enhancerType, contextId);
      }
      let created = this.createdEnhancers.get(moduleRef);
      if (created === undefined) {
        created = new Map();
        this.createdEnhancers.set(moduleRef, created);
      }
      let pending = created.get(enhancerType);
      if (pending === undefined) {
        pending = moduleRef.create(enhancerType as Type<unknown>);
        created.set(enhancerType, pending);
      }
      return (await pending) as T;
    }
  }

  private async resolveRequestEnhancers<T>(
    wrappers: readonly InstanceWrapper<T>[],
    contextId?: ContextId,
  ): Promise<T[]> {
    if (contextId === undefined) {
      return [];
    }

    return Promise.all(
      wrappers.map(async (wrapper) => {
        // APP_* registrations use generated provider tokens. Their metatype may
        // be a factory or an alias and is not the registered injection token.
        const owner = wrapper.host?.providers.get(ModuleRef)?.instance as ModuleRef | undefined;
        return (owner ?? this.moduleRef).resolve<T>(wrapper.token, contextId, {
          strict: owner !== undefined,
        });
      }),
    );
  }

  private async resolveGateway(
    handler: CompiledWebTransportHandler,
    contextId?: ContextId,
  ): Promise<object> {
    if (contextId === undefined) {
      return handler.instance;
    }

    return (handler.moduleRef ?? this.moduleRef).resolve(
      handler.providerToken ?? handler.metatype,
      contextId,
      { strict: handler.moduleRef !== undefined },
    );
  }
}

function findVisibleProviderHost(
  host: NonNullable<InstanceWrapper['host']>,
  token: Type<unknown>,
): InstanceWrapper['host'] {
  if (host.providers.has(token) || host.injectables.has(token)) return host;
  const visited = new Set<NonNullable<InstanceWrapper['host']>>();
  const findExported = (
    candidate: NonNullable<InstanceWrapper['host']>,
  ): InstanceWrapper['host'] => {
    if (visited.has(candidate)) return undefined;
    visited.add(candidate);
    if (candidate.exports.has(token) && candidate.providers.has(token)) return candidate;
    for (const imported of candidate.imports) {
      if (!candidate.exports.has(imported.metatype)) continue;
      const found = findExported(imported);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const imported of host.imports) {
    const found = findExported(imported);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readEnhancers<T>(metadataKey: string, target: object): readonly Enhancer<T>[] {
  return (Reflect.getMetadata(metadataKey, target) as readonly Enhancer<T>[] | undefined) ?? [];
}

function extractParameter(
  kind: 'session' | 'stream' | 'payload' | 'context',
  args: WebTransportHandlerArguments,
): unknown {
  switch (kind) {
    case 'session':
      return args[0];
    case 'stream':
      return args[1];
    case 'payload':
      return args[3];
    case 'context':
      return args[4];
  }
}

function toObservable(factory: () => unknown): Observable<unknown> {
  return defer(() => from(Promise.resolve(factory()))).pipe(
    mergeMap((value) => (isObservable(value) ? value : of(value))),
  );
}
