import { describe, expect, it } from 'vitest';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
const hasUpstreamRuntimeSupport = nodeMajor === 24 || nodeMajor === 26;

describe.runIf(hasUpstreamRuntimeSupport)('rwebtransport runtime compatibility', () => {
  it('loads the native server export', async () => {
    const upstream = await import('rwebtransport');

    expect(upstream.WebTransportServer).toBeTypeOf('function');
  });
});
