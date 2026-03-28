import { describe, expect, it, vi } from "vitest";
import {
  buildAmountBuckets,
  getDominantCategory,
  PayeeProfileAnalyzer,
} from "./payee-profiles.js";

function createMockClient() {
  return {
    getTransactionsInRange: vi.fn().mockResolvedValue([]),
    getPayees: vi.fn().mockResolvedValue([]),
  };
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    payee_id: "payee-1",
    category_id: "cat-1",
    date: "2026-03-01",
    amount: -50000,
    deleted: false,
    ...overrides,
  };
}

describe("PayeeProfileAnalyzer", () => {
  it("builds profiles from transaction history", async () => {
    const client = createMockClient();
    client.getTransactionsInRange.mockResolvedValue([
      makeTx({ payee_id: "p1", category_id: "groceries", date: "2026-03-01" }),
      makeTx({ payee_id: "p1", category_id: "groceries", date: "2026-02-15" }),
      makeTx({ payee_id: "p1", category_id: "household", date: "2026-01-10" }),
      makeTx({ payee_id: "p2", category_id: "dining", date: "2026-03-05" }),
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Whole Foods", deleted: false },
      { id: "p2", name: "Restaurant", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);
    const profiles = await analyzer.getProfiles("budget-1");

    expect(profiles.size).toBe(2);

    const p1 = profiles.get("p1");
    expect(p1).toBeDefined();
    expect(p1?.payee_name).toBe("Whole Foods");
    expect(p1?.total_count).toBe(3);
    expect(p1?.category_counts.get("groceries")).toBe(2);
    expect(p1?.category_counts.get("household")).toBe(1);
    expect(p1?.most_recent_category_id).toBe("groceries");
    expect(p1?.most_recent_date).toBe("2026-03-01");

    const p2 = profiles.get("p2");
    expect(p2?.total_count).toBe(1);
    expect(p2?.most_recent_category_id).toBe("dining");
  });

  it("caches profiles per budget", async () => {
    const client = createMockClient();
    client.getTransactionsInRange.mockResolvedValue([
      makeTx({ payee_id: "p1", category_id: "cat-1" }),
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Test", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);

    const first = await analyzer.getProfiles("budget-1");
    const second = await analyzer.getProfiles("budget-1");

    expect(first).toBe(second); // same reference
    expect(client.getTransactionsInRange).toHaveBeenCalledTimes(1);
  });

  it("returns cache when requested range is already covered", async () => {
    const client = createMockClient();
    client.getTransactionsInRange.mockResolvedValue([
      makeTx({ payee_id: "p1", category_id: "cat-1" }),
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Test", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);

    // Fetch 12 months, then request 6 months — cache should cover it
    await analyzer.getProfiles("budget-1", 12);
    await analyzer.getProfiles("budget-1", 6);

    expect(client.getTransactionsInRange).toHaveBeenCalledTimes(1);
  });

  it("refetches when a broader range is requested", async () => {
    const client = createMockClient();
    client.getTransactionsInRange.mockResolvedValue([
      makeTx({ payee_id: "p1", category_id: "cat-1" }),
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Test", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);

    // Fetch 6 months, then request 12 — needs refetch
    await analyzer.getProfiles("budget-1", 6);
    await analyzer.getProfiles("budget-1", 12);

    expect(client.getTransactionsInRange).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache for a budget", async () => {
    const client = createMockClient();
    client.getTransactionsInRange.mockResolvedValue([
      makeTx({ payee_id: "p1", category_id: "cat-1" }),
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Test", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);

    await analyzer.getProfiles("budget-1");
    analyzer.invalidate("budget-1");
    await analyzer.getProfiles("budget-1");

    expect(client.getTransactionsInRange).toHaveBeenCalledTimes(2);
  });

  it("processes subtransactions of split transactions", async () => {
    const client = createMockClient();
    client.getTransactionsInRange.mockResolvedValue([
      {
        ...makeTx({
          payee_id: "p1",
          category_id: "split-cat",
          date: "2026-03-01",
        }),
        subtransactions: [
          { amount: -30000, category_id: "groceries", deleted: false },
          { amount: -20000, category_id: "household", deleted: false },
        ],
      },
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Superstore", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);
    const profiles = await analyzer.getProfiles("budget-1");

    const p1 = profiles.get("p1");
    expect(p1).toBeDefined();
    expect(p1?.total_count).toBe(2);
    expect(p1?.category_counts.get("groceries")).toBe(1);
    expect(p1?.category_counts.get("household")).toBe(1);
    expect(p1?.category_counts.has("split-cat")).toBe(false);
  });

  it("skips transactions without payee or category", async () => {
    const client = createMockClient();
    client.getTransactionsInRange.mockResolvedValue([
      makeTx({ payee_id: null, category_id: "cat-1" }),
      makeTx({ payee_id: "p1", category_id: null }),
      makeTx({ payee_id: "p1", category_id: "cat-1" }),
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Test", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);
    const profiles = await analyzer.getProfiles("budget-1");

    expect(profiles.size).toBe(1);
    expect(profiles.get("p1")?.total_count).toBe(1);
  });

  it("applies recency weighting", async () => {
    const client = createMockClient();
    // Recent transaction should have higher weight than old one
    client.getTransactionsInRange.mockResolvedValue([
      makeTx({ payee_id: "p1", category_id: "new-cat", date: "2026-03-25" }),
      makeTx({ payee_id: "p1", category_id: "old-cat", date: "2025-10-01" }),
    ]);
    client.getPayees.mockResolvedValue([
      { id: "p1", name: "Test", deleted: false },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const analyzer = new PayeeProfileAnalyzer(client as any);
    const profiles = await analyzer.getProfiles("budget-1");
    const p1 = profiles.get("p1");
    expect(p1).toBeDefined();

    // Raw counts are equal
    expect(p1?.category_counts.get("new-cat")).toBe(1);
    expect(p1?.category_counts.get("old-cat")).toBe(1);

    // Recency-weighted score should favor the recent one
    const newWeight = p1?.recency_weighted.get("new-cat") ?? 0;
    const oldWeight = p1?.recency_weighted.get("old-cat") ?? 0;
    expect(newWeight).toBeGreaterThan(oldWeight);
  });
});

describe("buildAmountBuckets", () => {
  it("returns empty for fewer than 3 transactions", () => {
    const result = buildAmountBuckets([
      { amount: -10000, category_id: "cat-1" },
      { amount: -20000, category_id: "cat-2" },
    ]);
    expect(result).toEqual([]);
  });

  it("returns empty when all transactions use same category", () => {
    const result = buildAmountBuckets([
      { amount: -5000, category_id: "cat-1" },
      { amount: -10000, category_id: "cat-1" },
      { amount: -50000, category_id: "cat-1" },
      { amount: -100000, category_id: "cat-1" },
    ]);
    expect(result).toEqual([]);
  });

  it("creates buckets when amounts cluster by category", () => {
    // Small amounts → subscriptions, large amounts → electronics
    const txs = [
      { amount: -9990, category_id: "subscriptions" },
      { amount: -9990, category_id: "subscriptions" },
      { amount: -12990, category_id: "subscriptions" },
      { amount: -299000, category_id: "electronics" },
      { amount: -349000, category_id: "electronics" },
      { amount: -499000, category_id: "electronics" },
    ];
    const result = buildAmountBuckets(txs);

    expect(result.length).toBeGreaterThanOrEqual(2);

    // Find the bucket containing small amounts
    const smallBucket = result.find((b) => b.max < 50000);
    if (smallBucket) {
      expect(getDominantCategory(smallBucket.category_counts)).toBe(
        "subscriptions",
      );
    }
  });
});

describe("getDominantCategory", () => {
  it("returns the category with highest count", () => {
    const counts = new Map([
      ["cat-1", 5],
      ["cat-2", 10],
      ["cat-3", 3],
    ]);
    expect(getDominantCategory(counts)).toBe("cat-2");
  });

  it("returns null for empty map", () => {
    expect(getDominantCategory(new Map())).toBeNull();
  });
});
