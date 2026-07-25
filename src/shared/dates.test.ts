import { afterEach, describe, expect, it, vi } from "vitest";
import { dateMonthsAgo } from "./dates.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("dateMonthsAgo", () => {
  it("clamps to the last day of the target month instead of rolling over", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-03-31 minus one month: February has no 31st. Plain setMonth
    // rolls forward to 2026-03-03, silently shortening the window.
    vi.setSystemTime(new Date(2026, 2, 31, 12, 0, 0));

    expect(dateMonthsAgo(1)).toBe("2026-02-28");
  });

  it("handles leap years when clamping", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2024, 2, 31, 12, 0, 0)); // 2024-03-31, leap year

    expect(dateMonthsAgo(1)).toBe("2024-02-29");
  });

  it("keeps the day of month when the target month is long enough", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0)); // 2026-06-15

    expect(dateMonthsAgo(3)).toBe("2026-03-15");
  });

  it("crosses year boundaries", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 31, 12, 0, 0)); // 2026-01-31

    expect(dateMonthsAgo(2)).toBe("2025-11-30");
  });
});
