import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway, GatewayError } from '../client/src/index';
import { handleRequest } from '../src/gateway';
import { MemoryQuota } from '../src/quota';
import type { Env, GatewayConfig } from '../src/types';
import { geminiReply } from './helpers';

const config: GatewayConfig = {
  limits: { perMinutePerIp: 100, globalDaily: 100 },
  features: {
    echo: {
      description: 'Echo',
      input: { fields: { text: { type: 'string', required: true } } },
      prompt: '{{text}}',
      output: { type: 'text' },
      models: [{ provider: 'gemini', model: 'g' }],
      limits: { free: 1, premium: 'unlimited' },
    },
  },
};

/** Wires the client straight to the handler, with Gemini mocked. */
function setup() {
  const quota = new MemoryQuota();
  const upstream = vi.fn(async () => geminiReply('  hello back  '));
  const gatewayFetch = (async (url: string, init: RequestInit) => {
    vi.stubGlobal('fetch', upstream);
    try {
      return await handleRequest(new Request(url, init), { GEMINI_API_KEY: 'k' } as Env, config, { quota });
    } finally {
      vi.unstubAllGlobals();
    }
  }) as unknown as typeof fetch;
  return createGateway({ baseUrl: 'https://gw.test/', deviceId: async () => 'install-abc-123', fetch: gatewayFetch });
}

afterEach(() => vi.unstubAllGlobals());

describe('client', () => {
  it('runs a feature and returns data and usage', async () => {
    const ai = setup();
    const r = await ai.run<string>('echo', { text: 'hello' });
    expect(r.data).toBe('hello back');
    expect(r.usage).toMatchObject({ used: 1, limit: 1, remaining: 0 });
  });

  it('throws typed errors with details', async () => {
    const ai = setup();
    await ai.run('echo', { text: 'a' });
    const err = (await ai.run('echo', { text: 'a' }).catch((e) => e)) as GatewayError;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe('quota_exceeded');
    expect(err.status).toBe(429);
    expect(err.details.limit).toBe(1);
    expect(err.retryable).toBe(false);
  });

  it('lists features', async () => {
    expect((await setup().listFeatures()).map((f) => f.name)).toEqual(['echo']);
  });

  it('maps network failures and timeouts', async () => {
    const down = createGateway({ baseUrl: 'https://x', deviceId: 'install-abc-123', fetch: (async () => { throw new TypeError('Network request failed'); }) as any });
    await expect(down.run('echo')).rejects.toMatchObject({ code: 'network_error', retryable: true });
    const slow = createGateway({
      baseUrl: 'https://x',
      deviceId: 'install-abc-123',
      timeoutMs: 10,
      fetch: ((_: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as any,
    });
    await expect(slow.run('echo')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('sends the purchase proof and app key', async () => {
    const seen: Record<string, string>[] = [];
    const ai = createGateway({
      baseUrl: 'https://x',
      deviceId: 'install-abc-123',
      appKey: 'k1',
      getPurchaseProof: () => 'ios:1',
      fetch: (async (_: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ ok: true, data: 1, usage: {}, model: {} }));
      }) as any,
    });
    await ai.run('echo', { text: 'a' });
    expect(seen[0]).toMatchObject({ 'X-Device-Id': 'install-abc-123', 'X-Purchase-Proof': 'ios:1', 'X-App-Key': 'k1' });
  });
});
