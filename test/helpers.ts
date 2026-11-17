import { vi } from 'vitest';

export interface MockCall {
  url: string;
  init: RequestInit;
  body: any;
}

/** Replaces global fetch. `handler` returns a Response for each call. */
export function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: MockCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let body: any = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    calls.push({ url, init, body });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const geminiReply = (text: string) => jsonResponse({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
export const anthropicReply = (text: string) => jsonResponse({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
export const chatReply = (text: string) => jsonResponse({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
