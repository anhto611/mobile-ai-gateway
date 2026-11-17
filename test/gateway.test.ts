import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, type Deps } from '../src/gateway';
import { MemoryQuota } from '../src/quota';
import type { Env, GatewayConfig } from '../src/types';
import { geminiReply, jsonResponse, mockFetch } from './helpers';

const config: GatewayConfig = {
  limits: { perMinutePerIp: 100, globalDaily: 1000 },
  purchases: { apple: { bundleId: 'com.x', lifetimeProducts: ['life'] } },
  features: {
    parse: {
      description: 'Parse',
      input: { fields: { text: { type: 'string', required: true } } },
      prompt: 'Parse {{text}}',
      output: { type: 'json', schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } } },
      models: [{ provider: 'gemini', model: 'g' }],
      limits: { free: 2, premium: 'unlimited' },
    },
    pro: {
      description: 'Premium only',
      prompt: 'Hi',
      output: { type: 'text' },
      models: [{ provider: 'gemini', model: 'g' }],
      limits: { free: 0, premium: 5 },
    },
  },
};

const env = { GEMINI_API_KEY: 'key' } as Env;
const DEVICE = 'device-1234';
let quota: MemoryQuota;
let deps: Deps;

function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`https://gw.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Device-Id': DEVICE, 'CF-Connecting-IP': '1.2.3.4', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleRequest(req, env, config, deps);
}

beforeEach(() => {
  quota = new MemoryQuota();
  deps = { quota, now: () => Date.parse('2026-11-18T10:00:00Z'), verifyPurchase: vi.fn(async () => true) };
});
afterEach(() => vi.unstubAllGlobals());

describe('routes', () => {
  it('answers /health', async () => {
    expect((await call('/health')).status).toBe(200);
  });

  it('lists features', async () => {
    const res = await call('/v1/features');
    const body = (await res.json()) as any;
    expect(body.data.map((f: any) => f.name)).toEqual(['parse', 'pro']);
  });

  it('returns 404 for unknown features and paths', async () => {
    expect((await call('/v1/features/nope', {})).status).toBe(404);
    expect((await call('/v1/features/toString', {})).status).toBe(404);
    expect((await call('/other')).status).toBe(404);
  });

  it('requires a device id', async () => {
    const res = await call('/v1/features/parse', { input: { text: 'x' } }, { 'X-Device-Id': 'short' });
    expect(res.status).toBe(400);
  });

  it('checks the app key when one is set', async () => {
    const req = (key?: string) =>
      handleRequest(new Request('https://gw.test/v1/features', { headers: key ? { 'X-App-Key': key } : {} }), { ...env, APP_KEY: 'secret' }, config, deps);
    expect((await req()).status).toBe(401);
    expect((await req('wrong!')).status).toBe(401);
    expect((await req('secret')).status).toBe(200);
  });
});

describe('running a feature', () => {
  it('returns validated JSON with usage', async () => {
    const calls = mockFetch(() => geminiReply('{"amount": 12.5}'));
    const res = await call('/v1/features/parse', { input: { text: 'lunch 12.5' } });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ amount: 12.5 });
    expect(body.usage).toEqual({ used: 1, limit: 2, remaining: 1, resetsAt: '2026-11-19T00:00:00.000Z', premium: false });
    expect(body.model).toEqual({ provider: 'gemini', model: 'g' });
    expect(calls[0].body.contents[0].parts[0].text).toContain('Parse lunch 12.5');
    expect(calls[0].body.contents[0].parts[0].text).toContain('JSON Schema');
  });

  it('enforces the free daily limit', async () => {
    mockFetch(() => geminiReply('{"amount": 1}'));
    await call('/v1/features/parse', { input: { text: 'a' } });
    await call('/v1/features/parse', { input: { text: 'a' } });
    const res = await call('/v1/features/parse', { input: { text: 'a' } });
    const body = (await res.json()) as any;
    expect(res.status).toBe(429);
    expect(body.error).toMatchObject({ code: 'quota_exceeded', limit: 2, used: 2, resetsAt: '2026-11-19T00:00:00.000Z' });
  });

  it('does not charge the user when the AI fails', async () => {
    mockFetch(() => jsonResponse({ error: 'down' }, 500));
    const res = await call('/v1/features/parse', { input: { text: 'a' } });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.code).toBe('ai_failed');
    expect(quota.counts.get(`device:${DEVICE}|parse|2026-11-18`)).toBe(0);
    expect(quota.counts.get('global|all|2026-11-18')).toBe(0);
  });

  it('retries with the next model when output does not match the schema', async () => {
    const twoModels: GatewayConfig = {
      ...config,
      features: { parse: { ...config.features.parse, models: [{ provider: 'gemini', model: 'a' }, { provider: 'gemini', model: 'b' }] } },
    };
    mockFetch((url) => geminiReply(url.includes('/a:') ? '{"amount":"twelve"}' : '{"amount":12}'));
    const res = await handleRequest(
      new Request('https://gw.test/v1/features/parse', { method: 'POST', headers: { 'X-Device-Id': DEVICE }, body: JSON.stringify({ input: { text: 'x' } }) }),
      env,
      twoModels,
      deps,
    );
    expect(((await res.json()) as any).model.model).toBe('b');
  });

  it('applies the global daily cap', async () => {
    mockFetch(() => geminiReply('{"amount": 1}'));
    const capped = { ...config, limits: { ...config.limits, globalDaily: 0 } };
    const res = await handleRequest(
      new Request('https://gw.test/v1/features/parse', { method: 'POST', headers: { 'X-Device-Id': DEVICE }, body: JSON.stringify({ input: { text: 'x' } }) }),
      env,
      capped,
      deps,
    );
    expect(res.status).toBe(503);
    expect(quota.counts.get(`device:${DEVICE}|parse|2026-11-18`)).toBe(0);
  });

  it('rate limits per IP', async () => {
    mockFetch(() => geminiReply('{"amount": 1}'));
    const tight = { ...config, limits: { ...config.limits, perMinutePerIp: 1 } };
    const send = () =>
      handleRequest(
        new Request('https://gw.test/v1/features/parse', { method: 'POST', headers: { 'X-Device-Id': DEVICE, 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify({ input: { text: 'x' } }) }),
        env,
        tight,
        deps,
      );
    expect((await send()).status).toBe(200);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });
});

describe('premium', () => {
  it('uses premium limits when the purchase checks out, and caches the result', async () => {
    mockFetch(() => geminiReply('{"amount": 1}'));
    for (let i = 0; i < 4; i++) {
      const res = await call('/v1/features/parse', { input: { text: 'a' } }, { 'X-Purchase-Proof': 'ios:123' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).usage).toMatchObject({ limit: null, remaining: null, premium: true });
    }
    expect(deps.verifyPurchase).toHaveBeenCalledTimes(1);
  });

  it('blocks premium-only features for free users', async () => {
    const res = await call('/v1/features/pro', {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('premium_required');
  });

  it('treats an unverifiable purchase as free without caching it', async () => {
    deps.verifyPurchase = vi.fn(async () => null);
    mockFetch(() => geminiReply('hi'));
    expect((await call('/v1/features/pro', {}, { 'X-Purchase-Proof': 'ios:1' })).status).toBe(403);
    expect((await call('/v1/features/pro', {}, { 'X-Purchase-Proof': 'ios:1' })).status).toBe(403);
    expect(deps.verifyPurchase).toHaveBeenCalledTimes(2);
  });
});

describe('cors', () => {
  it('only answers allowed origins', async () => {
    const withCors = { ...config, cors: { allowOrigins: ['https://app.example'] } };
    const pre = (origin: string) =>
      handleRequest(new Request('https://gw.test/v1/features', { method: 'OPTIONS', headers: { Origin: origin } }), env, withCors, deps);
    expect((await pre('https://app.example')).headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    expect((await pre('https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
