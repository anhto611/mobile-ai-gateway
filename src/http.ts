export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'busy'
  | 'ai_failed'
  | 'not_configured'
  | 'premium_required';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(error: unknown, headers: Record<string, string> = {}): Response {
  if (error instanceof HttpError) {
    return json({ ok: false, error: { code: error.code, message: error.message, ...error.details } }, error.status, headers);
  }
  console.error('Unhandled error', error);
  return json({ ok: false, error: { code: 'ai_failed', message: 'Something went wrong. Please try again.' } }, 500, headers);
}
