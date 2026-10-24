/**
 * Fixed-window rate limiter backed by a Durable Object.
 *
 * Why a DO and not KV: counters must be strongly consistent, otherwise a burst
 * of parallel requests all read the same stale count and the limit is useless.
 * The limiter protects the *worker* (and therefore the shared GitHub quota),
 * which is separate from GitHub's own per-token limits.
 */
export class RateLimiter {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? 60);
    const windowMs = Number(url.searchParams.get('windowMs') ?? 60_000);
    const bucket = url.searchParams.get('bucket') ?? 'default';
    const cost = Number(url.searchParams.get('cost') ?? 1);
    const now = Date.now();

    const stored = (await this.state.storage.get<{ count: number; resetAt: number }>(bucket)) ?? {
      count: 0,
      resetAt: now + windowMs,
    };
    const current = stored.resetAt <= now ? { count: 0, resetAt: now + windowMs } : stored;
    const allowed = current.count + cost <= limit;
    if (allowed) {
      current.count += cost;
      await this.state.storage.put(bucket, current);
    }
    return Response.json({
      allowed,
      remaining: Math.max(0, limit - current.count),
      resetAt: new Date(current.resetAt).toISOString(),
      limit,
    });
  }
}
