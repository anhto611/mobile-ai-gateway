import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, runChain } from '../src/providers';
import type { Env } from '../src/types';
import { anthropicReply, chatReply, geminiReply, jsonResponse, mockFetch } from './helpers';

const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GROQ_API_KEY: 'q' } as Env;
const req = { prompt: 'hello', json: true, maxOutputTokens: 100, temperature: 0.2 };
const parse = (t: string) => JSON.parse(t);

afterEach(() => vi.unstubAllGlobals());

describe('provider request formats', () => {
  it('calls Gemini with the key header and JSON mode', async () => {
    const calls = mockFetch(() => geminiReply('{"ok":1}'));
    const r = await runChain(env, [{ provider: 'gemini', model: 'gemini-x' }], { ...req, image: { data: 'aGk=', mimeType: 'image/png' } }, parse);
    expect(r.value).toEqual({ ok: 1 });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('g');
    expect(calls[0].body.generationConfig).toEqual({ maxOutputTokens: 100, temperature: 0.2, responseMimeType: 'application/json' });
    expect(calls[0].body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'aGk=' } });
  });

  it('calls Anthropic Messages API with the image first', async () => {
    const calls = mockFetch(() => anthropicReply('{"ok":2}'));
    await runChain(env, [{ provider: 'anthropic', model: 'claude-haiku-5-5' }], { ...req, image: { data: 'aGk=', mimeType: 'image/jpeg' } }, parse);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('a');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].body.model).toBe('claude-haiku-5-5');
    expect(calls[0].body.max_tokens).toBe(100);
    expect(calls[0].body.messages[0].content[0].type).toBe('image');
  });

  it('calls Groq and OpenAI with Chat Completions', async () => {
    const calls = mockFetch(() => chatReply('{"ok":3}'));
    await runChain(env, [{ provider: 'groq', model: 'openai/gpt-oss-120b' }], req, parse);
    await runChain(env, [{ provider: 'openai', model: 'some-model' }], req, parse);
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(calls[1].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.messages[0].content).toBe('hello');
  });
});

describe('runChain', () => {
  it('falls back to the next model on server errors', async () => {
    const calls = mockFetch((url) => (url.includes('groq') ? jsonResponse({ error: 'overloaded' }, 503) : geminiReply('{"a":1}')));
    const r = await runChain(env, [{ provider: 'groq', model: 'x' }, { provider: 'gemini', model: 'y' }], req, parse);
    expect(r.model).toEqual({ provider: 'gemini', model: 'y' });
    expect(calls).toHaveLength(2);
  });

  it('falls back when the output cannot be parsed', async () => {
    mockFetch((url) => (url.includes('groq') ? chatReply('not json') : geminiReply('{"a":1}')));
    const r = await runChain(env, [{ provider: 'groq', model: 'x' }, { provider: 'gemini', model: 'y' }], req, parse);
    expect(r.value).toEqual({ a: 1 });
  });

  it('skips models without a key', async () => {
    const calls = mockFetch(() => geminiReply('{"a":1}'));
    await runChain({ GEMINI_API_KEY: 'g' } as Env, [{ provider: 'anthropic', model: 'x' }, { provider: 'gemini', model: 'y' }], req, parse);
    expect(calls).toHaveLength(1);
  });

  it('stops on input errors instead of trying every provider', async () => {
    const calls = mockFetch(() => jsonResponse({ error: { message: 'Invalid image data' } }, 400));
    await expect(runChain(env, [{ provider: 'gemini', model: 'x' }, { provider: 'anthropic', model: 'y' }], req, parse)).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
    expect(calls).toHaveLength(1);
  });

  it('fails clearly when no key is set', async () => {
    await expect(runChain({} as Env, [{ provider: 'gemini', model: 'x' }], req, parse)).rejects.toBeInstanceOf(ProviderError);
  });
});
