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

describe("write tools are hidden in read-only mode", () => {
  const writeTools = [
    "create_transactions",
    "update_transactions",
    "delete_transactions",
    "set_category_budgets",
    "set_category_targets",
    "create_scheduled_transactions",
    "update_scheduled_transactions",
    "delete_scheduled_transactions",
    "undo_operations",
  ];

  it("write tools are not listed", async () => {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const tool of writeTools) {
      expect(names).not.toContain(tool);
    }
    // Read tools remain available
    expect(names).toContain("search_transactions");
    expect(names).toContain("list_undo_history");
  });

  it("calling an unregistered write tool is rejected and data is unchanged", async () => {
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
    ).rejects.toThrow();

    await expect(
      harness.callTool("delete_transactions", {
        transaction_ids: ["tx-1"],
      }),
    ).rejects.toThrow();

    await expect(
      harness.callTool("set_category_budgets", {
        assignments: [
          {
            category_id: "cat-groceries",
            month: CURRENT_MONTH,
            budgeted: 500.0,
          },
        ],
      }),
    ).rejects.toThrow();

    await expect(
      harness.callTool("create_scheduled_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: futureDateStr(2, 1),
            amount: -100.0,
            frequency: "monthly",
          },
        ],
      }),
    ).rejects.toThrow();

    // The seeded transaction is untouched
    const after = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "January rent" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ id: string }>;
      }>;
    };
    expect(after.result_sets[0].count).toBe(1);
    expect(after.result_sets[0].transactions[0].id).toBe("tx-1");
  });
});

describe("read operations succeed in read-only mode", () => {
  it("search_transactions returns seeded data", async () => {
    const result = (await harness.callTool("search_transactions", {
      queries: [{ limit: 5 }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ amount: number }>;
      }>;
    };

    expect(result.result_sets[0].count).toBeGreaterThan(0);
    // Verify returned transactions have proper formatting
    for (const tx of result.result_sets[0].transactions) {
      expect(typeof tx.amount).toBe("number");
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
