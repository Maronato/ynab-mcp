const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_THRESHOLD = 190;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly threshold: number;
  private readonly max: number;
  private readonly windowMs: number;

  constructor(
    options: { threshold?: number; max?: number; windowMs?: number } = {},
  ) {
    this.threshold = options.threshold ?? RATE_LIMIT_THRESHOLD;
    this.max = options.max ?? RATE_LIMIT_MAX;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
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

    if (recentCount >= this.threshold) {
      const oldest = this.timestamps.find((t) => t > windowStart) ?? now;
      const resetMinutes = Math.ceil((oldest + this.windowMs - now) / 60000);
      throw new Error(
        `YNAB API rate limit approaching (${recentCount}/${this.max} requests in the last hour). ` +
          `Try again in ~${resetMinutes} minutes.`,
      );
    }

    this.timestamps.push(now);
  }
}
