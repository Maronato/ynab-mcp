import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import {
  CURRENT_MONTH,
  dateStr,
  futureDateStr,
  seedStandardBudget,
} from "./seed.js";

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({
    readOnly: true,
    seed: seedStandardBudget,
  });
});

afterEach(async () => {
  await harness.close();
});

describe("write operations fail in read-only mode", () => {
  it("create_transactions fails", async () => {
    await expect(
      harness.callTool("create_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: dateStr(0, 15),
            amount: -25.0,
            category_id: "cat-groceries",
          },
        ],
      }),
    ).rejects.toThrow(/read-only/i);
  });

  it("update_transactions fails and data is unchanged", async () => {
    // Get original transaction data before the rejected update
    const beforeUpdate = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "January rent" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ id: string; amount: number; memo: string }>;
      }>;
    };
    expect(beforeUpdate.result_sets[0].count).toBe(1);
    const originalTx = beforeUpdate.result_sets[0].transactions[0];

    await expect(
      harness.callTool("update_transactions", {
        transactions: [
          {
            transaction_id: "tx-1",
            amount: -200.0,
          },
        ],
      }),
    ).rejects.toThrow(/read-only/i);

    // Verify the transaction data is unchanged after the rejected update
    const afterUpdate = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "January rent" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ id: string; amount: number; memo: string }>;
      }>;
    };
    expect(afterUpdate.result_sets[0].count).toBe(1);
    const unchangedTx = afterUpdate.result_sets[0].transactions[0];
    expect(unchangedTx.id).toBe(originalTx.id);
    expect(unchangedTx.amount).toBe(originalTx.amount);
    expect(unchangedTx.memo).toBe(originalTx.memo);
  });

  it("delete_transactions fails and transaction still exists", async () => {
    const result = (await harness.callTool("delete_transactions", {
      transaction_ids: ["tx-1"],
    })) as { results: Array<{ status: string; message?: string }> };

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toMatch(/read-only/i);

    // Verify the transaction still exists after the rejected delete
    const afterDelete = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "January rent" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ id: string }>;
      }>;
    };
    expect(afterDelete.result_sets[0].count).toBe(1);
    expect(afterDelete.result_sets[0].transactions[0].id).toBe("tx-1");
  });

  it("set_category_budgets fails", async () => {
    const result = (await harness.callTool("set_category_budgets", {
      assignments: [
        {
          category_id: "cat-groceries",
          month: CURRENT_MONTH,
          budgeted: 500.0,
        },
      ],
    })) as { results: Array<{ status: string; message?: string }> };

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toMatch(/read-only/i);
  });

  it("create_scheduled_transactions fails", async () => {
    const result = (await harness.callTool("create_scheduled_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(2, 1),
          amount: -100.0,
          frequency: "monthly",
        },
      ],
    })) as { results: Array<{ status: string; message?: string }> };

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toMatch(/read-only/i);
  });
});

describe("read operations succeed in read-only mode", () => {
  it("search_transactions returns seeded data", async () => {
    const result = (await harness.callTool("search_transactions", {
      queries: [{ limit: 5 }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ amount: number; amount_display: string }>;
      }>;
    };

    expect(result.result_sets[0].count).toBeGreaterThan(0);
    // Verify returned transactions have proper formatting
    for (const tx of result.result_sets[0].transactions) {
      expect(typeof tx.amount).toBe("number");
      expect(typeof tx.amount_display).toBe("string");
    }
  });

  it("list_categories returns seeded groups", async () => {
    const result = (await harness.callTool("list_categories", {})) as {
      groups: Array<{
        id: string;
        name: string;
        categories: Array<{ id: string; name: string }>;
      }>;
    };

    expect(result.groups.length).toBeGreaterThan(0);
    // Verify seeded category names are present
    const allCatNames = result.groups.flatMap((g) =>
      g.categories.map((c) => c.name),
    );
    expect(allCatNames).toContain("Groceries");
    expect(allCatNames).toContain("Rent/Mortgage");
  });

  it("get_accounts returns seeded accounts", async () => {
    const result = (await harness.callTool("get_accounts", {})) as {
      count: number;
      accounts: Array<{ id: string; name: string }>;
    };

    expect(result.count).toBeGreaterThan(0);
    const names = result.accounts.map((a) => a.name);
    expect(names).toContain("Checking");
  });

  it("list_budgets returns data", async () => {
    const result = (await harness.callTool("list_budgets", {})) as {
      budgets: Array<{ id: string; name: string }>;
    };

    expect(result.budgets.length).toBeGreaterThan(0);
    expect(result.budgets[0].name).toBe("My Budget");
  });
});
