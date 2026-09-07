import type { ArgumentsHost, ExecutionContext, Type } from '@nestjs/common';
import type {
  HttpArgumentsHost,
  RpcArgumentsHost,
  WsArgumentsHost,
} from '@nestjs/common/interfaces/features/arguments-host.interface';
import type {
  SessionContext,
  WebTransportBidirectionalStream,
  WebTransportReceiveStream,
  WebTransportSession,
} from 'webtransport-core';

export type WebTransportIncomingStream =
  | WebTransportBidirectionalStream
  | WebTransportReceiveStream;

export interface WebTransportArgumentsHost {
  getSession(): WebTransportSession;
  getStream(): WebTransportIncomingStream | undefined;
  getDatagram(): Uint8Array | undefined;
  getPayload<T = unknown>(): T;
  getSessionContext(): SessionContext;
}

export interface WebTransportExecutionContext extends ExecutionContext {
  switchToWebTransport(): WebTransportArgumentsHost;
}

export type WebTransportHandlerArguments = readonly [
  session: WebTransportSession,
  stream: WebTransportIncomingStream | undefined,
  datagram: Uint8Array | undefined,
  payload: unknown,
  context: SessionContext,
];

export class WebTransportExecutionContextHost implements WebTransportExecutionContext {
  constructor(
    private readonly args: WebTransportHandlerArguments,
    private readonly classRef: Type<unknown>,
    private readonly handler: (...args: readonly unknown[]) => unknown,
  ) {}

  getClass<T = unknown>(): Type<T> {
    return this.classRef as Type<T>;
  }

  getHandler(): (...args: readonly unknown[]) => unknown {
    return this.handler;
  }

  getArgs<T extends unknown[] = unknown[]>(): T {
    return [...this.args] as T;
  }

  getArgByIndex<T = unknown>(index: number): T {
    return this.args[index] as T;
  }

  getType<TContext extends string = string>(): TContext {
    return 'webtransport' as TContext;
  }

  switchToWebTransport(): WebTransportArgumentsHost {
    return createWebTransportArgumentsHost(this.args);
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = unknown>() => this.args[3] as T,
      getContext: <T = unknown>() => this.args[4] as T,
    };
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = unknown>() => this.args[0] as T,
      getResponse: <T = unknown>() => undefined as T,
      getNext: <T = unknown>() => undefined as T,
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = unknown>() => this.args[0] as T,
      getData: <T = unknown>() => this.args[3] as T,
      getPattern: () => '',
    };
  }
}

export function switchToWebTransport(context: ArgumentsHost): WebTransportArgumentsHost {
  if ('switchToWebTransport' in context) {
    const candidate = context as Partial<WebTransportExecutionContext>;
    if (typeof candidate.switchToWebTransport === 'function') {
      return candidate.switchToWebTransport();
    }
  }

  return createWebTransportArgumentsHost(
    context.getArgs<unknown[]>() as unknown as WebTransportHandlerArguments,
  );
}

function createWebTransportArgumentsHost(
  args: WebTransportHandlerArguments,
): WebTransportArgumentsHost {
  return {
    getSession: () => args[0],
    getStream: () => args[1],
    getDatagram: () => args[2],
    getPayload: <T = unknown>() => args[3] as T,
    getSessionContext: () => args[4],
  };
}
