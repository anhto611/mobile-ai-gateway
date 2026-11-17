/**
 * Client for mobile-ai-gateway. No dependencies, uses the global fetch.
 *
 *   const ai = createGateway({ baseUrl: 'https://my-gateway.workers.dev', deviceId });
 *   const { data, usage } = await ai.run<Expense>('parse-expense', { text: 'coffee 4.5', today: '2026-11-18' });
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'premium_required'
  | 'busy'
  | 'ai_failed'
  | 'not_configured'
  | 'network_error'
  | 'timeout';

export interface Usage {
  used: number;
  /** null when the user has no limit for this feature. */
  limit: number | null;
  remaining: number | null;
  /** ISO time of the next reset (UTC midnight). */
  resetsAt: string;
  premium: boolean;
}

export interface RunResult<T> {
  data: T;
  usage: Usage;
  model: { provider: string; model: string };
}

export interface ImagePayload {
  /** Base64 data, with or without a `data:image/...;base64,` prefix. */
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface FeatureInfo {
  name: string;
  description: string;
  input: { fields: Record<string, { type: string; required?: boolean; maxLength?: number }>; image: 'none' | 'optional' | 'required' };
  output: { type: 'json'; schema: unknown } | { type: 'text' };
  limits: { free: number; premium: number | 'unlimited' };
}

export class GatewayError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
    /** Extra fields from the server, e.g. `limit` and `resetsAt` for quota_exceeded. */
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  /** Worth retrying later without changing anything. */
  get retryable(): boolean {
    return this.code === 'ai_failed' || this.code === 'network_error' || this.code === 'timeout' || this.code === 'rate_limited' || this.code === 'busy';
  }
}

export interface GatewayOptions {
  baseUrl: string;
  /**
   * A stable id for this install, used as the key for daily limits.
   * For example a UUID you create on first launch and keep in storage.
   */
  deviceId: string | (() => string | Promise<string>);
  /**
   * Returns the purchase proof for premium users, or null for free users.
   * iOS: `ios:<transactionId>`, Android: `android:<productId>:<purchaseToken>`.
   */
  getPurchaseProof?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Only if the gateway has APP_KEY set. */
  appKey?: string;
  /** Defaults to 60 seconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RunOptions {
  image?: ImagePayload;
  signal?: AbortSignal;
}

export interface Gateway {
  run<T = unknown>(feature: string, input?: Record<string, string | number | boolean | undefined>, options?: RunOptions): Promise<RunResult<T>>;
  listFeatures(): Promise<FeatureInfo[]>;
}

export function createGateway(options: GatewayOptions): Gateway {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const deviceId = typeof options.deviceId === 'function' ? await options.deviceId() : options.deviceId;
    const proof = await options.getPurchaseProof?.();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Device-Id': deviceId };
    if (proof) headers['X-Purchase-Proof'] = proof;
    if (options.appKey) headers['X-App-Key'] = options.appKey;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    let res: Response;
    try {
      res = await doFetch(baseUrl + path, { ...init, headers, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw new GatewayError('timeout', `No answer after ${timeoutMs} ms`, 0);
      if (signal?.aborted) throw err;
      throw new GatewayError('network_error', (err as Error)?.message || 'Network request failed', 0);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new GatewayError(res.ok ? 'ai_failed' : 'network_error', `Unexpected response (HTTP ${res.status})`, res.status);
    }
    if (!res.ok || body?.ok === false) {
      const { code = 'ai_failed', message = `HTTP ${res.status}`, ...details } = body?.error ?? {};
      throw new GatewayError(code, message, res.status, details);
    }
    return body as T;
  }

  return {
    async run<T>(feature: string, input: Record<string, unknown> = {}, runOptions: RunOptions = {}) {
      const body = await request<{ data: T; usage: Usage; model: RunResult<T>['model'] }>(
        `/v1/features/${encodeURIComponent(feature)}`,
        { method: 'POST', body: JSON.stringify({ input, ...(runOptions.image && { image: runOptions.image }) }) },
        runOptions.signal,
      );
      return { data: body.data, usage: body.usage, model: body.model };
    },
    async listFeatures() {
      const body = await request<{ data: FeatureInfo[] }>('/v1/features', { method: 'GET' });
      return body.data;
    },
  };
}
