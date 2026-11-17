import { DurableObject } from 'cloudflare:workers';
import type { QuotaBackend } from './quota';
import type { Env } from './types';

/**
 * One instance per scope (a device, an IP address, or "global"), so counters for
 * different users never contend with each other. Data lives in the object's SQLite storage.
 */
export class QuotaCounter extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usage (bucket TEXT NOT NULL, period TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket, period))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  }

  private current(bucket: string, period: string): number {
    const row = this.sql.exec<{ count: number }>(`SELECT count FROM usage WHERE bucket = ? AND period = ?`, bucket, period).toArray()[0];
    return row?.count ?? 0;
  }

  private add(bucket: string, period: string, delta: number): number {
    this.sql.exec(
      `INSERT INTO usage (bucket, period, count) VALUES (?, ?, MAX(0, ?))
       ON CONFLICT (bucket, period) DO UPDATE SET count = MAX(0, count + ?)`,
      bucket, period, delta, delta,
    );
    return this.current(bucket, period);
  }

  consumeDaily(bucket: string, day: string, limit: number | null): { allowed: boolean; used: number } {
    const used = this.current(bucket, day);
    if (limit !== null && used >= limit) return { allowed: false, used };
    if (used === 0) this.prune(day);
    return { allowed: true, used: this.add(bucket, day, 1) };
  }

  refundDaily(bucket: string, day: string): void {
    this.add(bucket, day, -1);
  }

  rateLimit(window: number, limit: number): boolean {
    const period = `w${window}`;
    if (this.current('rate', period) >= limit) return false;
    this.sql.exec(`DELETE FROM usage WHERE bucket = 'rate' AND period != ?`, period);
    this.add('rate', period, 1);
    return true;
  }

  getCached(key: string): boolean | undefined {
    const row = this.sql.exec<{ value: number; expires_at: number }>(`SELECT value, expires_at FROM cache WHERE key = ?`, key).toArray()[0];
    if (!row || row.expires_at <= Date.now()) return undefined;
    return row.value === 1;
  }

  setCached(key: string, value: boolean, ttlMs: number): void {
    this.sql.exec(`DELETE FROM cache WHERE expires_at <= ?`, Date.now());
    this.sql.exec(
      `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      key, value ? 1 : 0, Date.now() + ttlMs,
    );
  }

  /** Keeps a week of daily counters, which is plenty for debugging. */
  private prune(today: string): void {
    const cutoff = new Date(Date.parse(today) - 7 * 86_400_000).toISOString().slice(0, 10);
    this.sql.exec(`DELETE FROM usage WHERE bucket != 'rate' AND period < ?`, cutoff);
  }
}

export function durableQuota(env: Env): QuotaBackend {
  const stub = (scope: string) => env.QUOTA.get(env.QUOTA.idFromName(scope)) as unknown as DurableObjectStub<QuotaCounter>;
  return {
    consumeDaily: (scope, bucket, day, limit) => stub(scope).consumeDaily(bucket, day, limit),
    refundDaily: (scope, bucket, day) => stub(scope).refundDaily(bucket, day),
    rateLimit: (scope, window, limit) => stub(scope).rateLimit(window, limit),
    getCached: (scope, key) => stub(scope).getCached(key),
    setCached: (scope, key, value, ttlMs) => stub(scope).setCached(key, value, ttlMs),
  };
}
