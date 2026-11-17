import { errorResponse, HttpError, json } from './http';
import { sha256Hex } from './jwt';
import { extractJson, schemaInstruction, validate } from './json';
import { renderPrompt, validateImage, validateInput } from './prompt';
import { ProviderError, runChain } from './providers';
import { verifyPurchase } from './purchase';
import { nextUtcMidnight, utcDay, type QuotaBackend } from './quota';
import type { Env, FeatureConfig, GatewayConfig } from './types';

export interface Deps {
  quota: QuotaBackend;
  /** Overridable in tests. */
  verifyPurchase?: typeof verifyPurchase;
  now?: () => number;
}

const MAX_BODY_BYTES = 6_000_000;
const PREMIUM_TTL_MS = 60 * 60 * 1000;
const FREE_TTL_MS = 60 * 1000;
const DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export async function handleRequest(request: Request, env: Env, config: GatewayConfig, deps: Deps): Promise<Response> {
  const cors = corsHeaders(request, config);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') return json({ ok: true }, 200, cors);

    checkAppKey(request, env);

    if (path === '/v1/features') {
      if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET');
      return json({ ok: true, data: listFeatures(config) }, 200, cors);
    }

    const match = /^\/v1\/features\/([A-Za-z0-9_-]+)$/.exec(path);
    if (match) {
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST');
      return json(await runFeature(request, env, config, deps, match[1]), 200, cors);
    }

    throw new HttpError(404, 'not_found', 'No such endpoint');
  } catch (err) {
    const headers = { ...cors };
    if (err instanceof HttpError && typeof err.details?.retryAfter === 'number') headers['Retry-After'] = String(err.details.retryAfter);
    return errorResponse(err, headers);
  }
}

function listFeatures(config: GatewayConfig) {
  return Object.entries(config.features).map(([name, f]) => ({
    name,
    description: f.description,
    input: { fields: f.input?.fields ?? {}, image: f.input?.image ?? 'none' },
    output: f.output.type === 'json' ? { type: 'json', schema: f.output.schema } : { type: 'text' },
    limits: f.limits,
  }));
}

function checkAppKey(request: Request, env: Env): void {
  if (!env.APP_KEY) return;
  const given = request.headers.get('X-App-Key') ?? '';
  if (!timingSafeEqual(given, env.APP_KEY)) throw new HttpError(401, 'unauthorized', 'Missing or wrong X-App-Key');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, 'bad_request', 'Request body is too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'bad_request', 'Request body is too large');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad_request', 'Body must be a JSON object');
  }
}

async function isPremium(env: Env, config: GatewayConfig, deps: Deps, scope: string, proof: string | null): Promise<boolean> {
  if (!proof || !config.purchases) return false;
  if (proof.length > 2048) throw new HttpError(400, 'bad_request', 'X-Purchase-Proof is too long');
  const key = `premium:${await sha256Hex(proof)}`;
  const cached = await deps.quota.getCached(scope, key);
  if (cached !== undefined) return cached;
  const result = await (deps.verifyPurchase ?? verifyPurchase)(env, config, proof);
  if (result !== null) await deps.quota.setCached(scope, key, result, result ? PREMIUM_TTL_MS : FREE_TTL_MS);
  return result === true;
}

async function runFeature(request: Request, env: Env, config: GatewayConfig, deps: Deps, name: string) {
  const now = deps.now?.() ?? Date.now();
  const feature: FeatureConfig | undefined = Object.hasOwn(config.features, name) ? config.features[name] : undefined;
  if (!feature) throw new HttpError(404, 'not_found', `No feature named "${name}"`);

  const deviceId = request.headers.get('X-Device-Id') ?? '';
  if (!DEVICE_ID.test(deviceId)) {
    throw new HttpError(400, 'bad_request', 'X-Device-Id must be 8-128 characters: letters, digits, . _ : -');
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const window = Math.floor(now / 60_000);
  if (!(await deps.quota.rateLimit(`ip:${ip}`, window, config.limits.perMinutePerIp))) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute.', { retryAfter: 60 - Math.floor((now / 1000) % 60) });
  }

  const body = await readBody(request);
  const input = validateInput(feature, body.input);
  const image = validateImage(feature, body.image);

  const deviceScope = `device:${deviceId}`;
  const premium = await isPremium(env, config, deps, deviceScope, request.headers.get('X-Purchase-Proof'));
  const limit = premium ? feature.limits.premium : feature.limits.free;
  const numericLimit = limit === 'unlimited' ? null : limit;
  const day = utcDay(now);
  const resetsAt = nextUtcMidnight(now);

  if (numericLimit === 0) {
    throw new HttpError(403, 'premium_required', 'This feature is for premium users', { premium });
  }

  const device = await deps.quota.consumeDaily(deviceScope, name, day, numericLimit);
  if (!device.allowed) {
    throw new HttpError(429, 'quota_exceeded', 'Daily limit reached for this feature', {
      limit: numericLimit,
      used: device.used,
      resetsAt,
      premium,
    });
  }

  const global = await deps.quota.consumeDaily('global', 'all', day, config.limits.globalDaily);
  if (!global.allowed) {
    await deps.quota.refundDaily(deviceScope, name, day);
    throw new HttpError(503, 'busy', 'The service is at capacity for today. Try again tomorrow.', { resetsAt });
  }

  const prompt = renderPrompt(feature, input) + (feature.output.type === 'json' ? schemaInstruction(feature.output.schema) : '');
  const output = feature.output;
  try {
    const result = await runChain(
      env,
      feature.models,
      { prompt, image, json: output.type === 'json', temperature: feature.temperature, maxOutputTokens: feature.maxOutputTokens ?? 1024 },
      (text) => {
        if (output.type === 'text') return text.trim();
        const value = extractJson(text);
        const problems = validate(value, output.schema);
        if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
        return value;
      },
    );
    return {
      ok: true,
      data: result.value,
      usage: {
        used: device.used,
        limit: numericLimit,
        remaining: numericLimit === null ? null : Math.max(0, numericLimit - device.used),
        resetsAt,
        premium,
      },
      model: result.model,
    };
  } catch (err) {
    await Promise.all([deps.quota.refundDaily(deviceScope, name, day), deps.quota.refundDaily('global', 'all', day)]);
    if (err instanceof ProviderError && !err.retryable) {
      if (err.status === 400) throw new HttpError(400, 'bad_request', 'The AI provider rejected this input (check the image or text length)');
      throw new HttpError(500, 'not_configured', 'No AI provider key is set for this feature');
    }
    throw new HttpError(502, 'ai_failed', 'The AI could not produce a result. Please try again.');
  }
}

function corsHeaders(request: Request, config: GatewayConfig): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = config.cors?.allowOrigins ?? [];
  if (!origin || !(allowed.includes('*') || allowed.includes(origin))) return {};
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Purchase-Proof, X-App-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
