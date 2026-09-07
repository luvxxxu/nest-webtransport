import type { PipeTransform, Type } from '@nestjs/common';

import { WEBTRANSPORT_PARAMETER_METADATA } from '../metadata/constants.js';
import type {
  WebTransportParameterKind,
  WebTransportParameterMetadata,
  WebTransportPipe,
} from '../metadata/types.js';

type PipeInput = PipeTransform | Type<PipeTransform>;

export function Session(...pipes: PipeInput[]): ParameterDecorator {
  return createParameterDecorator('session', pipes);
}

export function Stream(...pipes: PipeInput[]): ParameterDecorator {
  return createParameterDecorator('stream', pipes);
}

export function Payload(...pipes: PipeInput[]): ParameterDecorator {
  return createParameterDecorator('payload', pipes);
}

export function WebTransportContext(...pipes: PipeInput[]): ParameterDecorator {
  return createParameterDecorator('context', pipes);
}

function createParameterDecorator(
  kind: WebTransportParameterKind,
  pipes: readonly WebTransportPipe[],
): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) {
      throw new TypeError('WebTransport parameter decorators can only be used on methods.');
    }

    const existing =
      (Reflect.getOwnMetadata(WEBTRANSPORT_PARAMETER_METADATA, target, propertyKey) as
        | readonly WebTransportParameterMetadata[]
        | undefined) ?? [];

    const next = existing.filter((parameter) => parameter.index !== parameterIndex);
    next.push(
      Object.freeze({
        index: parameterIndex,
        kind,
        pipes: Object.freeze([...pipes]),
      }),
    );
    next.sort((left, right) => left.index - right.index);

    Reflect.defineMetadata(
      WEBTRANSPORT_PARAMETER_METADATA,
      Object.freeze(next),
      target,
      propertyKey,
    );
  };
}
