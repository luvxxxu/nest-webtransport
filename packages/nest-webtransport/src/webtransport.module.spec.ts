import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { WebTransportModule } from './webtransport.module.js';

describe('WebTransportModule', () => {
  it('compiles as a Nest module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WebTransportModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
