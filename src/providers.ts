import type { ImageInput } from './prompt';
import type { Env, ModelRef, ProviderName } from './types';

export interface AiRequest {
  prompt: string;
  image?: ImageInput;
  json: boolean;
  temperature?: number;
  maxOutputTokens: number;
}

/** A provider failure. `retryable` false means the next provider would fail the same way. */
export class ProviderError extends Error {
  constructor(
    public provider: ProviderName,
    message: string,
    public status?: number,
    public retryable = true,
  ) {
    super(`${provider}: ${message}`);
  }
}

const TIMEOUT_MS = 30_000;

const KEY_NAMES: Record<ProviderName, keyof Env> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
};

export function apiKeyFor(env: Env, provider: ProviderName): string | undefined {
  const value = env[KEY_NAMES[provider]];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function keyNameFor(provider: ProviderName): string {
  return KEY_NAMES[provider] as string;
}

async function post(provider: ProviderName, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(provider, `request failed (${(err as Error).name ?? 'network'})`);
  }
  const text = await res.text();
  if (!res.ok) {
    // A 400 about the input (bad image, prompt too long) would fail on every provider.
    const inputProblem = res.status === 400 && /image|input|argument|too (long|large)|invalid_request/i.test(text);
    throw new ProviderError(provider, `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, !inputProblem);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(provider, 'response was not JSON');
  }
}

async function callGemini(key: string, model: string, req: AiRequest): Promise<string> {
  const parts: unknown[] = [{ text: req.prompt }];
  if (req.image) parts.push({ inlineData: { mimeType: req.image.mimeType, data: req.image.data } });
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens,
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.json && { responseMimeType: 'application/json' }),
    },
  };
  const data = (await post(
    'gemini',
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': key },
    body,
  )) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new ProviderError('gemini', `empty response (${candidate?.finishReason ?? 'no candidates'})`);
  return text;
}

async function callAnthropic(key: string, model: string, req: AiRequest): Promise<string> {
  const content: unknown[] = [];
  if (req.image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: req.image.mimeType, data: req.image.data } });
  }
  content.push({ type: 'text', text: req.prompt });
  const data = (await post(
    'anthropic',
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    {
      model,
      max_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      messages: [{ role: 'user', content }],
    },
  )) as { content?: { type: string; text?: string }[]; stop_reason?: string };
  const text = data.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
  if (!text) throw new ProviderError('anthropic', `empty response (${data.stop_reason ?? 'no content'})`);
  return text;
}

/** OpenAI and Groq share the Chat Completions format. */
async function callChatCompletions(
  provider: 'openai' | 'groq',
  key: string,
  model: string,
  req: AiRequest,
): Promise<string> {
  const url =
    provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
  const content: unknown[] = [{ type: 'text', text: req.prompt }];
  if (req.image) {
    content.push({ type: 'image_url', image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` } });
  }
  const data = (await post(provider, url, { Authorization: `Bearer ${key}` }, {
    model,
    messages: [{ role: 'user', content: req.image ? content : req.prompt }],
    max_completion_tokens: req.maxOutputTokens,
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.json && { response_format: { type: 'json_object' } }),
  })) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new ProviderError(provider, `empty response (${data.choices?.[0]?.finish_reason ?? 'no choices'})`);
  return text;
}

export function callModel(env: Env, ref: ModelRef, req: AiRequest): Promise<string> {
  const key = apiKeyFor(env, ref.provider);
  if (!key) return Promise.reject(new ProviderError(ref.provider, `${keyNameFor(ref.provider)} is not set`));
  switch (ref.provider) {
    case 'gemini':
      return callGemini(key, ref.model, req);
    case 'anthropic':
      return callAnthropic(key, ref.model, req);
    case 'openai':
    case 'groq':
      return callChatCompletions(ref.provider, key, ref.model, req);
  }
}

export interface ChainResult<T> {
  value: T;
  model: ModelRef;
}

/**
 * Tries each model in order. `parse` turns the raw reply into the final value and throws
 * when the reply is unusable, which moves on to the next model.
 * Models without an API key are skipped.
 */
export async function runChain<T>(
  env: Env,
  models: ModelRef[],
  req: AiRequest,
  parse: (text: string) => T,
): Promise<ChainResult<T>> {
  const usable = models.filter((m) => apiKeyFor(env, m.provider));
  if (usable.length === 0) {
    throw new ProviderError(models[0]?.provider ?? 'gemini', 'no API key is set for any model of this feature', undefined, false);
  }
  let lastError: unknown;
  for (const model of usable) {
    try {
      const text = await callModel(env, model, req);
      try {
        return { value: parse(text), model };
      } catch (err) {
        throw new ProviderError(model.provider, `unusable output: ${(err as Error).message}`);
      }
    } catch (err) {
      lastError = err;
      console.warn(`[gateway] ${model.provider}/${model.model} failed: ${(err as Error).message}`);
      if (err instanceof ProviderError && !err.retryable) throw err;
    }
  }
  throw lastError;
}
