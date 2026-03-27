import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows calls below the threshold", () => {
    const limiter = new RateLimiter({ threshold: 5, max: 10, windowMs: 60000 });
    for (let i = 0; i < 4; i++) {
      expect(() => limiter.trackCall()).not.toThrow();
    }
  });

  it("throws when threshold is reached", () => {
    const limiter = new RateLimiter({ threshold: 3, max: 5, windowMs: 60000 });
    limiter.trackCall();
    limiter.trackCall();
    limiter.trackCall();
    expect(() => limiter.trackCall()).toThrow(/rate limit approaching/);
  });

  it("includes count and max in error message", () => {
    const limiter = new RateLimiter({ threshold: 2, max: 10, windowMs: 60000 });
    limiter.trackCall();
    limiter.trackCall();
    expect(() => limiter.trackCall()).toThrow("2/10 requests");
  });

  it("includes reset time in error message", () => {
    const limiter = new RateLimiter({
      threshold: 2,
      max: 10,
      windowMs: 60000,
    });
    limiter.trackCall();
    vi.advanceTimersByTime(10000); // 10 seconds later
    limiter.trackCall();
    // Oldest call is at t=0, window is 60s, current time is t=10s
    // Reset = ceil((0 + 60000 - 10000) / 60000) = ceil(50000/60000) = 1 minute
    expect(() => limiter.trackCall()).toThrow("~1 minutes");
  });

  it("allows calls again after window expires", () => {
    const limiter = new RateLimiter({ threshold: 2, max: 5, windowMs: 60000 });
    limiter.trackCall();
    limiter.trackCall();
    expect(() => limiter.trackCall()).toThrow(/rate limit/);

    // Advance past the window
    vi.advanceTimersByTime(60001);

    // Old timestamps are now outside the window
    expect(() => limiter.trackCall()).not.toThrow();
  });

  it("prunes old timestamps when array grows large", () => {
    const limiter = new RateLimiter({
      threshold: 200,
      max: 200,
      windowMs: 60000,
    });

    // Fill with old timestamps by calling and advancing time
    for (let i = 0; i < 100; i++) {
      limiter.trackCall();
    }

    // Move past the window so all existing timestamps are old
    vi.advanceTimersByTime(60001);

    // Add enough to trigger pruning (> max * 2 = 400 total)
    // We already have 100, need > 300 more to trigger
    for (let i = 0; i < 100; i++) {
      limiter.trackCall();
      vi.advanceTimersByTime(1);
    }

    // Should still work — old entries should be pruned
    expect(() => limiter.trackCall()).not.toThrow();
  });

  it("counts only calls within the window", () => {
    const limiter = new RateLimiter({ threshold: 3, max: 5, windowMs: 60000 });

    limiter.trackCall(); // t=0
    vi.advanceTimersByTime(30000);
    limiter.trackCall(); // t=30s

    // First call expires
    vi.advanceTimersByTime(30001);
    // Now at t=60001ms. Call at t=0 is outside window, call at t=30000 is inside
    // Recent count = 1, so we can make 2 more before hitting threshold of 3

    limiter.trackCall(); // recent count was 1, now 2 after push
    expect(() => limiter.trackCall()).not.toThrow(); // recent count was 2, now 3 after push
    // Now at threshold
    expect(() => limiter.trackCall()).toThrow(/rate limit/);
  });
});
