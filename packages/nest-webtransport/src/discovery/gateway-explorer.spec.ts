import { type DynamicModule, Inject, Injectable, Module, Scope, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { SessionContext } from 'webtransport-core';

import { TestClient, VirtualWebTransportDriver } from '../../../testing/src/index.js';
import { WebTransportGateway } from '../decorators/gateway.decorator.js';
import { OnSession } from '../decorators/handler.decorator.js';
import { WebTransportContext } from '../decorators/parameter.decorator.js';
import { WebTransportModule } from '../webtransport.module.js';

const OWNER = Symbol('owner');

@Injectable()
class Recorder {
  readonly calls: string[] = [];
}

@Module({ providers: [Recorder], exports: [Recorder] })
class SharedModule {}

@Injectable({ scope: Scope.REQUEST })
class OwnedGuard {
  constructor(
    @Inject(OWNER) private readonly owner: string,
    @Inject(Recorder) private readonly recorder: Recorder,
  ) {}

  canActivate(): boolean {
    this.recorder.calls.push(`guard:${this.owner}`);
    return true;
  }
}

@Injectable()
class OwnedPipe {
  constructor(
    @Inject(OWNER) private readonly owner: string,
    @Inject(Recorder) private readonly recorder: Recorder,
  ) {}

  transform(value: unknown): unknown {
    this.recorder.calls.push(`pipe:${this.owner}`);
    return value;
  }
}

@WebTransportGateway('/owned')
@UseGuards(OwnedGuard)
@Injectable({ scope: Scope.REQUEST })
class OwnedGateway {
  constructor(
    @Inject(OWNER) private readonly owner: string,
    @Inject(Recorder) private readonly recorder: Recorder,
  ) {}

  @OnSession()
  session(@WebTransportContext(OwnedPipe) context: SessionContext): void {
    this.recorder.calls.push(`gateway:${this.owner}:${context.sessionId}`);
  }
}

@Module({})
class FeatureModule {
  static register(owner: string): DynamicModule {
    return {
      module: FeatureModule,
      imports: [SharedModule],
      providers: [OwnedGateway, { provide: OWNER, useValue: owner }],
    };
  }
}

describe('GatewayExplorer module ownership', () => {
  it('preserves custom pipe factories from separately configured re-exported modules', async () => {
    const received: string[] = [];
    class ImportedPipe {
      transform(): string {
        return 'incorrect-direct-construction';
      }
    }
    @Module({})
    class PipesModule {
      static register(owner: string): DynamicModule {
        return {
          module: PipesModule,
          providers: [
            {
              provide: ImportedPipe,
              scope: Scope.REQUEST,
              useFactory: () => ({ transform: () => owner }),
            },
          ],
          exports: [ImportedPipe],
        };
      }
    }
    @Module({})
    class BridgeModule {
      static register(owner: string): DynamicModule {
        return {
          module: BridgeModule,
          imports: [PipesModule.register(owner)],
          exports: [PipesModule],
        };
      }
    }
    @WebTransportGateway('/imported-pipe')
    class ImportedGateway {
      @OnSession()
      session(@WebTransportContext(ImportedPipe) owner: string): void {
        received.push(owner);
      }
    }
    @Module({})
    class ConsumerModule {
      static register(owner: string): DynamicModule {
        return {
          module: ConsumerModule,
          imports: [BridgeModule.register(owner)],
          providers: [ImportedGateway],
        };
      }
    }
    const driver = new VirtualWebTransportDriver();
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: { requireOrigin: false },
        }),
        ConsumerModule.register('first'),
        ConsumerModule.register('second'),
      ],
    }).compile();
    await moduleRef.init();
    try {
      const client = await new TestClient(driver).connect('/imported-pipe');
      expect(client.signal.aborted).toBe(false);
      expect(received).toEqual(['first', 'second']);
    } finally {
      await moduleRef.close();
    }
  });

  it('resolves duplicate gateway and enhancer classes within their owning feature module', async () => {
    const driver = new VirtualWebTransportDriver();
    const moduleRef = await Test.createTestingModule({
      imports: [
        WebTransportModule.forRoot({
          driver,
          server: { port: 0 },
          security: { requireOrigin: false },
        }),
        FeatureModule.register('first'),
        FeatureModule.register('second'),
      ],
    }).compile();
    await moduleRef.init();
    try {
      const client = await new TestClient(driver).connect('/owned');
      expect(client.signal.aborted).toBe(false);
      expect(moduleRef.get(Recorder).calls).toEqual([
        'guard:first',
        'pipe:first',
        `gateway:first:${client.id}`,
        'guard:second',
        'pipe:second',
        `gateway:second:${client.id}`,
      ]);
    } finally {
      await moduleRef.close();
    }
  });
});
