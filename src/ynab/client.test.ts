import { beforeEach, describe, expect, it, vi } from "vitest";

import { YnabClient } from "./client.js";

// --- Mock ynab.API shape ---

function createMockApi() {
  return {
    plans: {
      getPlans: vi.fn().mockResolvedValue({ data: { plans: [] } }),
      getPlanSettingsById: vi.fn().mockResolvedValue({
        data: { settings: { currency_format: {} } },
      }),
    },
    accounts: {
      getAccounts: vi.fn().mockResolvedValue({
        data: { accounts: [], server_knowledge: 1 },
      }),
    },
    categories: {
      getCategories: vi.fn().mockResolvedValue({
        data: { category_groups: [], server_knowledge: 1 },
      }),
      updateMonthCategory: vi.fn().mockResolvedValue({
        data: { category: {} },
      }),
      getMonthCategoryById: vi.fn().mockResolvedValue({
        data: { category: {} },
      }),
    },
    payees: {
      getPayees: vi.fn().mockResolvedValue({
        data: { payees: [], server_knowledge: 1 },
      }),
    },
    transactions: {
      getTransactions: vi.fn().mockResolvedValue({
        data: { transactions: [] },
      }),
      getTransactionsByAccount: vi.fn().mockResolvedValue({
        data: { transactions: [] },
      }),
      getTransactionsByCategory: vi.fn().mockResolvedValue({
        data: { transactions: [] },
      }),
      getTransactionsByPayee: vi.fn().mockResolvedValue({
        data: { transactions: [] },
      }),
      getTransactionById: vi.fn().mockResolvedValue({
        data: { transaction: null },
      }),
      createTransactions: vi.fn().mockResolvedValue({
        data: { transactions: [] },
      }),
      updateTransactions: vi.fn().mockResolvedValue({
        data: { transactions: [] },
      }),
      deleteTransaction: vi.fn().mockResolvedValue({
        data: { transaction: {} },
      }),
    },
    scheduledTransactions: {
      getScheduledTransactions: vi.fn().mockResolvedValue({
        data: { scheduled_transactions: [], server_knowledge: 1 },
      }),
      getScheduledTransactionById: vi.fn().mockResolvedValue({
        data: { scheduled_transaction: null },
      }),
      createScheduledTransaction: vi.fn().mockResolvedValue({
        data: { scheduled_transaction: {} },
      }),
      updateScheduledTransaction: vi.fn().mockResolvedValue({
        data: { scheduled_transaction: {} },
      }),
      deleteScheduledTransaction: vi.fn().mockResolvedValue({
        data: { scheduled_transaction: {} },
      }),
    },
    months: {
      getPlanMonth: vi.fn().mockResolvedValue({
        data: {
          month: {
            month: "2024-01-01",
            income: 0,
            budgeted: 0,
            activity: 0,
            to_be_budgeted: 0,
            age_of_money: null,
            categories: [],
          },
        },
      }),
    },
  };
}

let client: YnabClient;
let mockApi: ReturnType<typeof createMockApi>;

beforeEach(() => {
  client = new YnabClient("fake-token");
  mockApi = createMockApi();
  (client as unknown as { api: unknown }).api = mockApi;
});

// --- Helper to create transaction-like objects ---

function tx(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    date: "2024-01-15",
    amount: -50000,
    memo: "Groceries",
    cleared: "cleared",
    approved: true,
    deleted: false,
    account_id: "acc-1",
    payee_id: "payee-1",
    category_id: "cat-1",
    subtransactions: [],
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    name: "Checking",
    type: "checking",
    on_budget: true,
    closed: false,
    deleted: false,
    balance: 100000,
    ...overrides,
  };
}

function scheduledTx(overrides: Record<string, unknown> = {}) {
  return {
    id: "stx-1",
    date_first: "2024-01-01",
    date_next: "2024-02-01",
    frequency: "monthly",
    amount: -100000,
    account_id: "acc-1",
    payee_id: "payee-1",
    category_id: "cat-1",
    deleted: false,
    ...overrides,
  };
}

// ===== Tests =====

describe("resolveBudgetId", () => {
  it("returns 'last-used' when no budgetId provided", () => {
    expect(client.resolveBudgetId()).toBe("last-used");
  });

  it("returns the provided budgetId", () => {
    expect(client.resolveBudgetId("my-budget")).toBe("my-budget");
  });

  it("returns cached resolved ID after resolveRealBudgetId", async () => {
    mockApi.plans.getPlans.mockResolvedValue({
      data: {
        plans: [
          { id: "budget-a", last_modified_on: "2024-01-01" },
          { id: "budget-b", last_modified_on: "2024-02-01" },
        ],
      },
    });

    await client.resolveRealBudgetId();
    expect(client.resolveBudgetId()).toBe("budget-b");
  });
});

describe("resolveRealBudgetId", () => {
  it("returns the budgetId directly if not 'last-used'", async () => {
    const result = await client.resolveRealBudgetId("specific-budget");
    expect(result).toBe("specific-budget");
    expect(mockApi.plans.getPlans).not.toHaveBeenCalled();
  });

  it("fetches budgets and returns most recently modified", async () => {
    mockApi.plans.getPlans.mockResolvedValue({
      data: {
        plans: [
          { id: "old", last_modified_on: "2024-01-01" },
          { id: "newest", last_modified_on: "2024-03-01" },
          { id: "mid", last_modified_on: "2024-02-01" },
        ],
      },
    });

    const result = await client.resolveRealBudgetId();
    expect(result).toBe("newest");
  });

  it("caches the result for subsequent calls", async () => {
    mockApi.plans.getPlans.mockResolvedValue({
      data: { plans: [{ id: "budget-1", last_modified_on: "2024-01-01" }] },
    });

    await client.resolveRealBudgetId();
    await client.resolveRealBudgetId();

    expect(mockApi.plans.getPlans).toHaveBeenCalledTimes(1);
  });

  it("returns 'last-used' when no budgets exist", async () => {
    mockApi.plans.getPlans.mockResolvedValue({ data: { plans: [] } });
    const result = await client.resolveRealBudgetId();
    expect(result).toBe("last-used");
  });

  it("returns 'last-used' when API throws", async () => {
    mockApi.plans.getPlans.mockRejectedValue(new Error("Network error"));
    const result = await client.resolveRealBudgetId();
    expect(result).toBe("last-used");
  });
});

describe("searchTransactions — filtering", () => {
  beforeEach(() => {
    mockApi.transactions.getTransactions.mockResolvedValue({
      data: {
        transactions: [
          tx({
            id: "t1",
            date: "2024-01-10",
            amount: -10000,
            memo: "Coffee",
            cleared: "cleared",
            approved: true,
            account_id: "acc-1",
            category_id: "cat-1",
            payee_id: "payee-1",
          }),
          tx({
            id: "t2",
            date: "2024-01-20",
            amount: -50000,
            memo: "Groceries",
            cleared: "uncleared",
            approved: false,
            account_id: "acc-2",
            category_id: "cat-2",
            payee_id: "payee-2",
          }),
          tx({
            id: "t3",
            date: "2024-02-01",
            amount: -100000,
            memo: null,
            cleared: "reconciled",
            approved: true,
            account_id: "acc-1",
            category_id: "cat-1",
            payee_id: "payee-1",
          }),
          tx({ id: "deleted", deleted: true }),
        ],
      },
    });
  });

  it("excludes deleted transactions", async () => {
    const result = await client.searchTransactions("b", {});
    expect(result.find((t) => t.id === "deleted")).toBeUndefined();
  });

  it("filters by until_date", async () => {
    const result = await client.searchTransactions("b", {
      until_date: "2024-01-15",
    });
    expect(result.every((t) => t.date <= "2024-01-15")).toBe(true);
  });

  it("filters by account_id", async () => {
    const result = await client.searchTransactions("b", {
      account_id: "acc-1",
    });
    expect(result.every((t) => t.account_id === "acc-1")).toBe(true);
  });

  it("filters by category_id", async () => {
    // When category_id is in the query, it uses getTransactionsByCategory endpoint
    mockApi.transactions.getTransactionsByCategory.mockResolvedValue({
      data: {
        transactions: [
          { ...tx({ id: "t1", category_id: "cat-1" }), type: "transaction" },
        ],
      },
    });

    const result = await client.searchTransactions("b", {
      category_id: "cat-1",
    });
    expect(result.every((t) => t.category_id === "cat-1")).toBe(true);
  });

  it("filters by payee_id", async () => {
    mockApi.transactions.getTransactionsByPayee.mockResolvedValue({
      data: {
        transactions: [
          { ...tx({ id: "t1", payee_id: "payee-1" }), type: "transaction" },
        ],
      },
    });

    const result = await client.searchTransactions("b", {
      payee_id: "payee-1",
    });
    expect(result.every((t) => t.payee_id === "payee-1")).toBe(true);
  });

  it("filters by amount_min (converted to milliunits)", async () => {
    const result = await client.searchTransactions("b", {
      amount_min: -50,
    });
    // -50 → -50000 milliunits. Only amounts >= -50000 should pass
    expect(result.every((t) => t.amount >= -50000)).toBe(true);
    expect(result.find((t) => t.id === "t3")).toBeUndefined(); // -100000 excluded
  });

  it("filters by amount_max (converted to milliunits)", async () => {
    const result = await client.searchTransactions("b", {
      amount_max: -50,
    });
    // -50 → -50000 milliunits. Only amounts <= -50000 should pass
    expect(result.every((t) => t.amount <= -50000)).toBe(true);
    expect(result.find((t) => t.id === "t1")).toBeUndefined(); // -10000 excluded
  });

  it("filters by memo_contains case-insensitively", async () => {
    const result = await client.searchTransactions("b", {
      memo_contains: "COFFEE",
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("handles memo_contains when transaction memo is null", async () => {
    const result = await client.searchTransactions("b", {
      memo_contains: "anything",
    });
    // t3 has null memo — should be excluded, not crash
    expect(result.find((t) => t.id === "t3")).toBeUndefined();
  });

  it("filters by cleared: true (not uncleared)", async () => {
    const result = await client.searchTransactions("b", {
      cleared: true,
    });
    expect(result.every((t) => t.cleared !== "uncleared")).toBe(true);
    expect(result.find((t) => t.id === "t2")).toBeUndefined();
  });

  it("filters by cleared: false (uncleared)", async () => {
    const result = await client.searchTransactions("b", {
      cleared: false,
    });
    expect(result.every((t) => t.cleared === "uncleared")).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("filters by approved", async () => {
    const result = await client.searchTransactions("b", {
      approved: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t2");
  });

  it("composes multiple filters with AND logic", async () => {
    // account_id triggers getTransactionsByAccount endpoint
    mockApi.transactions.getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({
            id: "t1",
            date: "2024-01-10",
            amount: -10000,
            memo: "Coffee",
            cleared: "cleared",
            approved: true,
            account_id: "acc-1",
          }),
          tx({
            id: "t3",
            date: "2024-02-01",
            amount: -100000,
            memo: null,
            cleared: "reconciled",
            approved: true,
            account_id: "acc-1",
          }),
          tx({
            id: "t4",
            date: "2024-02-05",
            amount: -20000,
            cleared: "uncleared",
            account_id: "acc-1",
          }),
        ],
      },
    });

    const result = await client.searchTransactions("b", {
      account_id: "acc-1",
      cleared: true,
    });
    // acc-1 + cleared (not "uncleared"): t1, t3
    expect(result).toHaveLength(2);
    expect(
      result.every(
        (t) => t.account_id === "acc-1" && t.cleared !== "uncleared",
      ),
    ).toBe(true);
  });
});

describe("searchTransactions — sorting", () => {
  beforeEach(() => {
    mockApi.transactions.getTransactions.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "t1", date: "2024-01-10" }),
          tx({ id: "t2", date: "2024-01-20" }),
          tx({ id: "t3", date: "2024-01-05" }),
        ],
      },
    });
  });

  it("defaults to date_desc", async () => {
    const result = await client.searchTransactions("b", {});
    expect(result.map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
  });

  it("sorts by date_asc", async () => {
    const result = await client.searchTransactions("b", {
      sort: "date_asc",
    });
    expect(result.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
  });
});

describe("searchTransactions — limit", () => {
  beforeEach(() => {
    const transactions = Array.from({ length: 60 }, (_, i) =>
      tx({ id: `t${i}`, date: `2024-01-${String(i + 1).padStart(2, "0")}` }),
    );
    mockApi.transactions.getTransactions.mockResolvedValue({
      data: { transactions },
    });
  });

  it("defaults to 50 results", async () => {
    const result = await client.searchTransactions("b", {});
    expect(result).toHaveLength(50);
  });

  it("respects custom limit", async () => {
    const result = await client.searchTransactions("b", { limit: 5 });
    expect(result).toHaveLength(5);
  });

  it("returns all when limit is 0", async () => {
    const result = await client.searchTransactions("b", { limit: 0 });
    expect(result).toHaveLength(60);
  });
});

describe("transaction cache local filtering", () => {
  it("always uses getTransactions (general endpoint) to populate cache", async () => {
    mockApi.transactions.getTransactions.mockResolvedValue({
      data: {
        transactions: [
          tx({
            id: "t1",
            account_id: "acc-1",
            category_id: "cat-1",
            payee_id: "payee-1",
          }),
          tx({
            id: "t2",
            account_id: "acc-2",
            category_id: "cat-2",
            payee_id: "payee-2",
          }),
        ],
        server_knowledge: 1,
      },
    });

    await client.searchTransactions("b", { account_id: "acc-1" });

    expect(mockApi.transactions.getTransactions).toHaveBeenCalled();
    expect(
      mockApi.transactions.getTransactionsByAccount,
    ).not.toHaveBeenCalled();
  });

  it("filters locally by account_id, category_id, payee_id from cache", async () => {
    mockApi.transactions.getTransactions.mockResolvedValue({
      data: {
        transactions: [
          tx({
            id: "t1",
            account_id: "acc-1",
            category_id: "cat-1",
            payee_id: "payee-1",
          }),
          tx({
            id: "t2",
            account_id: "acc-2",
            category_id: "cat-2",
            payee_id: "payee-2",
          }),
        ],
        server_knowledge: 1,
      },
    });

    const byAccount = await client.searchTransactions("b", {
      account_id: "acc-1",
      limit: 500,
    });
    expect(byAccount).toHaveLength(1);
    expect(byAccount[0].id).toBe("t1");

    // Second query uses cache (no new API call)
    const byPayee = await client.searchTransactions("b", {
      payee_id: "payee-2",
      limit: 500,
    });
    expect(byPayee).toHaveLength(1);
    expect(byPayee[0].id).toBe("t2");

    // Only one API call was made (for the initial cache population)
    expect(mockApi.transactions.getTransactions).toHaveBeenCalledTimes(1);
  });

  it("filters locally by type: uncategorized and unapproved", async () => {
    mockApi.transactions.getTransactions.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "t1", category_id: null, approved: true }),
          tx({ id: "t2", category_id: "cat-1", approved: false }),
          tx({ id: "t3", category_id: "cat-2", approved: true }),
        ],
        server_knowledge: 1,
      },
    });

    const uncategorized = await client.searchTransactions("b", {
      type: "uncategorized",
      limit: 500,
    });
    expect(uncategorized.map((t) => t.id)).toEqual(["t1"]);

    const unapproved = await client.searchTransactions("b", {
      type: "unapproved",
      limit: 500,
    });
    expect(unapproved.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("delta-aware caching", () => {
  it("first call passes undefined as server_knowledge", async () => {
    mockApi.accounts.getAccounts.mockResolvedValue({
      data: { accounts: [], server_knowledge: 10 },
    });

    await client.getAccounts("b");

    expect(mockApi.accounts.getAccounts).toHaveBeenCalledWith("b", undefined);
  });

  it("second call within TTL returns cached data without API call", async () => {
    mockApi.accounts.getAccounts.mockResolvedValue({
      data: { accounts: [account({ id: "a1" })], server_knowledge: 10 },
    });

    await client.getAccounts("b");
    const result = await client.getAccounts("b");

    // Only one API call — second was served from cache
    expect(mockApi.accounts.getAccounts).toHaveBeenCalledTimes(1);
    expect(result.map((a) => a.id)).toContain("a1");
  });

  it("stale cache triggers delta refresh with prior server_knowledge", async () => {
    mockApi.accounts.getAccounts.mockResolvedValue({
      data: { accounts: [], server_knowledge: 10 },
    });

    await client.getAccounts("b");

    // Force stale via syncBudgetData
    await client.syncBudgetData("b");

    expect(mockApi.accounts.getAccounts).toHaveBeenNthCalledWith(2, "b", 10);
  });

  it("delta response adds new items and removes deleted", async () => {
    mockApi.accounts.getAccounts
      .mockResolvedValueOnce({
        data: {
          accounts: [
            account({ id: "a1", name: "A" }),
            account({ id: "a2", name: "B" }),
          ],
          server_knowledge: 1,
        },
      })
      .mockResolvedValueOnce({
        data: {
          accounts: [
            account({ id: "a2", deleted: true }),
            account({ id: "a3", name: "C" }),
          ],
          server_knowledge: 2,
        },
      });

    await client.getAccounts("b", { includeClosed: true });

    // Force stale to trigger delta refresh on second call
    await client.syncBudgetData("b");

    const result = await client.getAccounts("b", { includeClosed: true });

    const ids = result.map((a) => a.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("a3");
    expect(ids).not.toContain("a2");
  });

  it("caches are per-budget", async () => {
    mockApi.accounts.getAccounts.mockResolvedValue({
      data: { accounts: [], server_knowledge: 1 },
    });

    await client.getAccounts("budget-1");
    await client.getAccounts("budget-2");

    // Both calls should pass undefined (separate caches)
    expect(mockApi.accounts.getAccounts).toHaveBeenNthCalledWith(
      1,
      "budget-1",
      undefined,
    );
    expect(mockApi.accounts.getAccounts).toHaveBeenNthCalledWith(
      2,
      "budget-2",
      undefined,
    );
  });
});

describe("cache staleness after mutations", () => {
  it("marks payees and categories stale after creating transactions (preserves SK for delta)", async () => {
    // Warm up caches
    mockApi.payees.getPayees.mockResolvedValue({
      data: { payees: [], server_knowledge: 5 },
    });
    mockApi.categories.getCategories.mockResolvedValue({
      data: { category_groups: [], server_knowledge: 5 },
    });

    await client.getPayees("b");
    await client.getCategories("b");

    // Create transaction triggers stale marking (not full invalidation)
    mockApi.transactions.createTransactions.mockResolvedValue({
      data: { transactions: [] },
    });
    await client.createTransactions("b", [
      { account_id: "a", date: "2024-01-01", amount: 10 },
    ]);

    // Next call should pass SK=5 (preserved for delta refresh), not undefined
    mockApi.payees.getPayees.mockResolvedValue({
      data: { payees: [], server_knowledge: 6 },
    });
    mockApi.categories.getCategories.mockResolvedValue({
      data: { category_groups: [], server_knowledge: 6 },
    });

    await client.getPayees("b");
    await client.getCategories("b");

    expect(mockApi.payees.getPayees).toHaveBeenNthCalledWith(2, "b", 5);
    expect(mockApi.categories.getCategories).toHaveBeenNthCalledWith(2, "b", 5);
  });
});

describe("getAccounts — filtering", () => {
  beforeEach(() => {
    mockApi.accounts.getAccounts.mockResolvedValue({
      data: {
        accounts: [
          account({
            id: "a1",
            name: "Checking",
            type: "checking",
            on_budget: true,
            closed: false,
          }),
          account({
            id: "a2",
            name: "Savings",
            type: "savings",
            on_budget: true,
            closed: false,
          }),
          account({
            id: "a3",
            name: "Credit",
            type: "creditCard",
            on_budget: true,
            closed: true,
          }),
          account({
            id: "a4",
            name: "Tracking",
            type: "otherAsset",
            on_budget: false,
            closed: false,
          }),
          account({ id: "a5", name: "Deleted", deleted: true }),
        ],
        server_knowledge: 1,
      },
    });
  });

  it("excludes deleted accounts", async () => {
    const result = await client.getAccounts("b", { includeClosed: true });
    expect(result.find((a) => a.id === "a5")).toBeUndefined();
  });

  it("excludes closed accounts by default", async () => {
    const result = await client.getAccounts("b");
    expect(result.find((a) => a.id === "a3")).toBeUndefined();
  });

  it("includes closed accounts when includeClosed is true", async () => {
    const result = await client.getAccounts("b", { includeClosed: true });
    expect(result.find((a) => a.id === "a3")).toBeDefined();
  });

  it("filters by type", async () => {
    const result = await client.getAccounts("b", { type: "checking" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a1");
  });

  it("filters by onBudget", async () => {
    const result = await client.getAccounts("b", { onBudget: false });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a4");
  });

  it("sorts results alphabetically by name", async () => {
    const result = await client.getAccounts("b", { includeClosed: true });
    const names = result.map((a) => a.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("getScheduledTransactions — filtering", () => {
  beforeEach(() => {
    mockApi.scheduledTransactions.getScheduledTransactions.mockResolvedValue({
      data: {
        scheduled_transactions: [
          scheduledTx({
            id: "s1",
            date_next: "2024-03-01",
            account_id: "acc-1",
            category_id: "cat-1",
          }),
          scheduledTx({
            id: "s2",
            date_next: "2024-01-01",
            account_id: "acc-2",
            category_id: "cat-2",
          }),
          scheduledTx({
            id: "s3",
            date_next: "2024-02-01",
            account_id: "acc-1",
            category_id: "cat-2",
          }),
          scheduledTx({ id: "deleted", deleted: true }),
        ],
        server_knowledge: 1,
      },
    });
  });

  it("excludes deleted scheduled transactions", async () => {
    const result = await client.getScheduledTransactions("b");
    expect(result.find((s) => s.id === "deleted")).toBeUndefined();
  });

  it("filters by accountId", async () => {
    const result = await client.getScheduledTransactions("b", {
      accountId: "acc-1",
    });
    expect(result.every((s) => s.account_id === "acc-1")).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("filters by categoryId", async () => {
    const result = await client.getScheduledTransactions("b", {
      categoryId: "cat-2",
    });
    expect(result.every((s) => s.category_id === "cat-2")).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("sorts by date_next ascending", async () => {
    const result = await client.getScheduledTransactions("b");
    const dates = result.map((s) => s.date_next);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("getBudgetSummary", () => {
  beforeEach(() => {
    mockApi.accounts.getAccounts.mockResolvedValue({
      data: {
        accounts: [
          account({
            id: "a1",
            name: "Checking",
            type: "checking",
            balance: 500000,
          }),
          account({
            id: "a2",
            name: "Savings",
            type: "savings",
            balance: 1000000,
          }),
          account({
            id: "a3",
            name: "Credit",
            type: "creditCard",
            balance: -200000,
          }),
        ],
        server_knowledge: 1,
      },
    });
    mockApi.months.getPlanMonth.mockResolvedValue({
      data: {
        month: {
          month: "2024-01-01",
          income: 600000,
          budgeted: 500000,
          activity: -400000,
          to_be_budgeted: 100000,
          age_of_money: 30,
          categories: [
            { id: "c1", balance: 10000, hidden: false, deleted: false },
            { id: "c2", balance: -5000, hidden: false, deleted: false },
            { id: "c3", balance: -3000, hidden: true, deleted: false },
            { id: "c4", balance: -1000, hidden: false, deleted: true },
          ],
        },
      },
    });
  });

  it("computes net worth as sum of all account balances", async () => {
    const summary = await client.getBudgetSummary("b");
    // 500000 + 1000000 + (-200000) = 1300000
    expect(summary.net_worth_milliunits).toBe(1300000);
    expect(summary.net_worth).toBe(1300);
  });

  it("counts overspent categories (balance < 0, not hidden, not deleted)", async () => {
    const summary = await client.getBudgetSummary("b");
    // c2 is overspent (balance < 0, not hidden, not deleted)
    // c3 is hidden, c4 is deleted — excluded
    expect(summary.overspent_category_count).toBe(1);
  });

  it("groups accounts by type with count and total_balance", async () => {
    const summary = await client.getBudgetSummary("b");
    const byType = summary.account_summary_by_type;

    const checking = byType.find(
      (e: { type: string }) => e.type === "checking",
    );
    expect(checking).toBeDefined();
    expect(checking?.count).toBe(1);
    expect(checking?.total_balance_milliunits).toBe(500000);

    const savings = byType.find((e: { type: string }) => e.type === "savings");
    expect(savings).toBeDefined();
    expect(savings?.count).toBe(1);
    expect(savings?.total_balance).toBe(1000);
  });

  it("returns month summary fields", async () => {
    const summary = await client.getBudgetSummary("b");
    expect(summary.income).toBe(600);
    expect(summary.budgeted).toBe(500);
    expect(summary.activity).toBe(-400);
    expect(summary.to_be_budgeted).toBe(100);
    expect(summary.age_of_money).toBe(30);
  });
});

describe("getCategories with month parameter", () => {
  beforeEach(() => {
    // Base category tree (fetched without month)
    mockApi.categories.getCategories.mockResolvedValue({
      data: {
        category_groups: [
          {
            id: "g1",
            name: "Everyday",
            hidden: false,
            deleted: false,
            categories: [
              {
                id: "c1",
                name: "Groceries",
                hidden: false,
                deleted: false,
                budgeted: 0,
                activity: 0,
                balance: 0,
              },
              {
                id: "c2",
                name: "Hidden Cat",
                hidden: true,
                deleted: false,
                budgeted: 0,
                activity: 0,
                balance: 0,
              },
            ],
          },
          {
            id: "g-deleted",
            name: "Deleted Group",
            hidden: false,
            deleted: true,
            categories: [],
          },
        ],
        server_knowledge: 1,
      },
    });
    // Month-specific data
    mockApi.months.getPlanMonth.mockResolvedValue({
      data: {
        month: {
          month: "2024-03-01",
          income: 0,
          budgeted: 0,
          activity: 0,
          to_be_budgeted: 0,
          age_of_money: null,
          categories: [
            {
              id: "c1",
              name: "Groceries",
              hidden: false,
              deleted: false,
              budgeted: 50000,
              activity: -30000,
              balance: 20000,
            },
            {
              id: "c2",
              name: "Hidden Cat",
              hidden: true,
              deleted: false,
              budgeted: 10000,
              activity: -5000,
              balance: 5000,
            },
          ],
        },
      },
    });
  });

  it("overlays month-specific data onto category tree", async () => {
    const groups = await client.getCategories("b", {
      month: "2024-03-01",
      includeHidden: true,
    });

    const groceries = groups[0].categories.find((c) => c.id === "c1");
    expect(groceries?.budgeted).toBe(50000);
    expect(groceries?.activity).toBe(-30000);
  });

  it("excludes deleted groups", async () => {
    const groups = await client.getCategories("b", {
      month: "2024-03-01",
      includeHidden: true,
    });

    expect(groups.find((g) => g.id === "g-deleted")).toBeUndefined();
  });

  it("filters hidden categories when includeHidden is false", async () => {
    const groups = await client.getCategories("b", {
      month: "2024-03-01",
      includeHidden: false,
    });

    const cats = groups[0].categories;
    expect(cats.find((c) => c.id === "c2")).toBeUndefined();
    expect(cats.find((c) => c.id === "c1")).toBeDefined();
  });

  it("filters by groupId when provided", async () => {
    const groups = await client.getCategories("b", {
      month: "2024-03-01",
      groupId: "g1",
      includeHidden: true,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("g1");
  });
});
