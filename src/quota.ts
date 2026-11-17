/** Counters behind the limits. Implemented by a Durable Object in production and in memory in tests. */
export interface QuotaBackend {
  /** Adds one to a daily counter unless it is already at `limit` (null = no limit, still counted). */
  consumeDaily(scope: string, bucket: string, day: string, limit: number | null): Promise<{ allowed: boolean; used: number }>;
  /** Takes back one call, used when the AI call fails so users are not charged for errors. */
  refundDaily(scope: string, bucket: string, day: string): Promise<void>;
  /** Fixed-window rate limit. Returns false when over the limit. */
  rateLimit(scope: string, window: number, limit: number): Promise<boolean>;
  getCached(scope: string, key: string): Promise<boolean | undefined>;
  setCached(scope: string, key: string, value: boolean, ttlMs: number): Promise<void>;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcMidnight(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

export class MemoryQuota implements QuotaBackend {
  counts = new Map<string, number>();
  cache = new Map<string, { value: boolean; expiresAt: number }>();

  async consumeDaily(scope: string, bucket: string, day: string, limit: number | null) {
    const key = `${scope}|${bucket}|${day}`;
    const used = this.counts.get(key) ?? 0;
    if (limit !== null && used >= limit) return { allowed: false, used };
    this.counts.set(key, used + 1);
    return { allowed: true, used: used + 1 };
  }

  async refundDaily(scope: string, bucket: string, day: string) {
    const key = `${scope}|${bucket}|${day}`;
    this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 0) - 1));
  }

  async rateLimit(scope: string, window: number, limit: number) {
    const key = `${scope}|rate|${window}`;
    const used = this.counts.get(key) ?? 0;
    if (used >= limit) return false;
    this.counts.set(key, used + 1);
    return true;
  }

  async getCached(scope: string, key: string) {
    const hit = this.cache.get(`${scope}|${key}`);
    return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
  }

  async setCached(scope: string, key: string, value: boolean, ttlMs: number) {
    this.cache.set(`${scope}|${key}`, { value, expiresAt: Date.now() + ttlMs });
  }
}
