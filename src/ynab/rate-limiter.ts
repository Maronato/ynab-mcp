const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_THRESHOLD = 190;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Client-side tracker for YNAB's 200-requests-per-rolling-hour limit.
 *
 * Local call timestamps are the primary signal. Because the counter resets
 * when the process restarts, it is reconciled against the server's
 * `X-Rate-Limit: used/limit` response header whenever one is seen, and a 429
 * from the server marks the window as exhausted outright.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly threshold: number;
  private readonly max: number;
  private readonly windowMs: number;

  /** Last `used` value reported by the server's X-Rate-Limit header. */
  private serverUsed: number | null = null;
  private serverUsedAt = 0;

  constructor(
    options: { threshold?: number; max?: number; windowMs?: number } = {},
  ) {
    this.threshold = options.threshold ?? RATE_LIMIT_THRESHOLD;
    this.max = options.max ?? RATE_LIMIT_MAX;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  }

  /** Reconcile with the server's authoritative used/limit count. */
  syncFromServer(used: number): void {
    this.serverUsed = used;
    this.serverUsedAt = Date.now();
  }

  /** The server returned 429: treat the window as fully exhausted. */
  notifyServerLimited(): void {
    this.serverUsed = this.max;
    this.serverUsedAt = Date.now();
  }

  /**
   * Server count decayed linearly over the window since it was observed.
   * The server count is a rolling-window total whose members expire over the
   * following hour; without their timestamps a linear decay is the best
   * stale estimate. Fresh observations (the common case — every successful
   * response refreshes it) are used as-is.
   */
  private serverEstimate(now: number): number {
    if (this.serverUsed === null) return 0;
    const age = now - this.serverUsedAt;
    if (age >= this.windowMs) return 0;
    return Math.ceil(this.serverUsed * (1 - age / this.windowMs));
  }

  /** Human-readable estimate of when capacity frees up. */
  describeReset(now = Date.now()): string {
    const windowStart = now - this.windowMs;
    const oldest = this.timestamps.find((t) => t > windowStart);
    if (oldest !== undefined) {
      const resetMinutes = Math.max(
        1,
        Math.ceil((oldest + this.windowMs - now) / 60000),
      );
      return `Try again in ~${resetMinutes} minute(s).`;
    }
    return "Try again within the next 60 minutes.";
  }

  trackCall(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Prune old entries when the array grows large
    if (this.timestamps.length > this.max * 2) {
      const firstValid = this.timestamps.findIndex((t) => t > windowStart);
      if (firstValid > 0) {
        this.timestamps.splice(0, firstValid);
      }
    }

    const recentCount = this.timestamps.filter((t) => t > windowStart).length;
    const effectiveCount = Math.max(recentCount, this.serverEstimate(now));

    if (effectiveCount >= this.threshold) {
      throw new Error(
        `YNAB API rate limit approaching (${effectiveCount}/${this.max} requests in the last hour). ` +
          this.describeReset(now),
      );
    }

    this.timestamps.push(now);
  }
}
