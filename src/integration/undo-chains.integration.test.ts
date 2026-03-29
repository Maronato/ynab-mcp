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
  harness = await createIntegrationHarness({ seed: seedStandardBudget });
});

afterEach(async () => {
  await harness.close();
});

describe("create -> undo (delete)", () => {
  it("creates a transaction and undoes it", async () => {
    const skBefore = harness.state.serverKnowledge;

    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -50.0,
          category_id: "cat-groceries",
          memo: "Test grocery",
        },
      ],
    })) as {
      created_count: number;
      transactions: Array<{ id: string; amount: number }>;
      undo_history_ids: string[];
    };

    expect(created.created_count).toBe(1);
    expect(created.undo_history_ids).toHaveLength(1);
    expect(created.transactions[0].amount).toBe(-50.0);

    // Server knowledge should have increased after create
    expect(harness.state.serverKnowledge).toBeGreaterThan(skBefore);

    // Verify the transaction exists
    const searchBefore = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Test grocery" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchBefore.result_sets[0].count).toBe(1);

    // Undo the create (should delete it)
    const undoResult = (await harness.callTool("undo_operations", {
      undo_history_ids: created.undo_history_ids,
    })) as { results: Array<{ status: string }>; summary: { undone: number } };

    expect(undoResult.summary.undone).toBe(1);
    expect(undoResult.results[0].status).toBe("undone");

    // Verify the transaction is gone
    const searchAfter = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Test grocery" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchAfter.result_sets[0].count).toBe(0);
  });
});

describe("create -> update -> undo update -> undo create", () => {
  it("chains undo operations correctly", async () => {
    // 1. Create a transaction
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -25.0,
          category_id: "cat-dining",
          memo: "Chain test",
        },
      ],
    })) as {
      transactions: Array<{ id: string; amount: string }>;
      undo_history_ids: string[];
    };

    const txId = created.transactions[0].id;
    const createUndoId = created.undo_history_ids[0];

    // 2. Update its amount
    const updated = (await harness.callTool("update_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          transaction_id: txId,
          amount: -75.0,
        },
      ],
    })) as {
      results: Array<{
        status: string;
        current_transaction_id: string;
        transaction: { amount: string };
      }>;
      undo_history_ids: string[];
    };

    expect(updated.results[0].status).toBe("updated");
    const updateUndoId = updated.undo_history_ids[0];

    // 3. Undo the update -- should revert to original amount
    const undoUpdate = (await harness.callTool("undo_operations", {
      undo_history_ids: [updateUndoId],
    })) as { summary: { undone: number } };
    expect(undoUpdate.summary.undone).toBe(1);

    // Verify amount reverted
    const searchReverted = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Chain test" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ amount: number }>;
      }>;
    };
    expect(searchReverted.result_sets[0].count).toBe(1);
    expect(searchReverted.result_sets[0].transactions[0].amount).toBe(-25.0);

    // 4. Undo the create -- should delete the transaction
    const undoCreate = (await harness.callTool("undo_operations", {
      undo_history_ids: [createUndoId],
    })) as { summary: { undone: number } };
    expect(undoCreate.summary.undone).toBe(1);

    // Verify the transaction is gone
    const searchGone = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Chain test" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchGone.result_sets[0].count).toBe(0);
  });
});

describe("list undo history", () => {
  it("shows create entry with correct operation type", async () => {
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -30.0,
          category_id: "cat-transport",
          memo: "History test",
        },
      ],
    })) as { undo_history_ids: string[] };

    const history = (await harness.callTool("list_undo_history", {
      budget_id: "budget-1",
    })) as {
      entries: Array<{
        id: string;
        operation: string;
        description: string;
        status: string;
      }>;
    };

    const entry = history.entries.find(
      (e) => e.id === created.undo_history_ids[0],
    );
    expect(entry).toBeDefined();
    expect(entry?.operation).toBe("create_transaction");
    expect(entry?.description).toContain("Created transaction");
    expect(entry?.status).toBe("active");
  });
});

describe("batch undo", () => {
  it("undoes multiple creates in a single call", async () => {
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -10.0,
          category_id: "cat-groceries",
          memo: "Batch A",
        },
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -20.0,
          category_id: "cat-dining",
          memo: "Batch B",
        },
      ],
    })) as {
      created_count: number;
      undo_history_ids: string[];
    };

    expect(created.created_count).toBe(2);
    expect(created.undo_history_ids).toHaveLength(2);

    // Undo both in a single call
    const undoResult = (await harness.callTool("undo_operations", {
      undo_history_ids: created.undo_history_ids,
    })) as { summary: { undone: number } };
    expect(undoResult.summary.undone).toBe(2);

    // Verify both are gone
    const searchA = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Batch A" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchA.result_sets[0].count).toBe(0);

    const searchB = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Batch B" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchB.result_sets[0].count).toBe(0);
  });
});

describe("scheduled transaction undo", () => {
  it("creates and undoes a scheduled transaction", async () => {
    const created = (await harness.callTool("create_scheduled_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(2, 1),
          amount: -100.0,
          category_id: "cat-utilities",
          frequency: "monthly",
          memo: "Scheduled undo test",
        },
      ],
    })) as {
      created_count: number;
      transactions: Array<{ id: string }>;
      undo_history_ids: string[];
    };

    expect(created.created_count).toBe(1);
    expect(created.undo_history_ids).toHaveLength(1);

    const stxId = created.transactions[0].id;

    // Verify it exists
    const before = (await harness.callTool("get_scheduled_transactions", {
      budget_id: "budget-1",
    })) as { transactions: Array<{ id: string }> };
    const found = before.transactions.some((t) => t.id === stxId);
    expect(found).toBe(true);

    // Undo the creation (should delete it)
    const undoResult = (await harness.callTool("undo_operations", {
      undo_history_ids: created.undo_history_ids,
    })) as { summary: { undone: number } };
    expect(undoResult.summary.undone).toBe(1);

    // Verify it's gone
    const after = (await harness.callTool("get_scheduled_transactions", {
      budget_id: "budget-1",
    })) as { transactions: Array<{ id: string }> };
    const stillFound = after.transactions.some((t) => t.id === stxId);
    expect(stillFound).toBe(false);
  });
});

describe("category budget undo", () => {
  it("sets a category budget and undoes it", async () => {
    // Get the original budgeted amount
    const monthBefore = (await harness.callTool("get_monthly_budget", {
      budget_id: "budget-1",
      month: CURRENT_MONTH,
    })) as {
      groups: Array<{
        categories: Array<{ id: string; budgeted: number }>;
      }>;
    };

    let originalBudgeted: number | undefined;
    for (const group of monthBefore.groups) {
      for (const cat of group.categories) {
        if (cat.id === "cat-groceries") {
          originalBudgeted = cat.budgeted;
          break;
        }
      }
    }
    expect(originalBudgeted).toBeDefined();

    // Set a new budget amount
    const setResult = (await harness.callTool("set_category_budgets", {
      budget_id: "budget-1",
      assignments: [
        {
          category_id: "cat-groceries",
          month: CURRENT_MONTH,
          budgeted: 999.0,
        },
      ],
    })) as {
      results: Array<{ status: string; updated_budgeted: number }>;
      undo_history_ids: string[];
    };

    expect(setResult.results[0].status).toBe("updated");
    expect(setResult.results[0].updated_budgeted).toBe(999.0);
    expect(setResult.undo_history_ids).toHaveLength(1);

    // Undo the budget change
    const undoResult = (await harness.callTool("undo_operations", {
      undo_history_ids: setResult.undo_history_ids,
    })) as { summary: { undone: number } };
    expect(undoResult.summary.undone).toBe(1);

    // Verify it reverted
    const monthAfter = (await harness.callTool("get_monthly_budget", {
      budget_id: "budget-1",
      month: CURRENT_MONTH,
    })) as {
      groups: Array<{
        categories: Array<{ id: string; budgeted: number }>;
      }>;
    };

    let revertedBudgeted: number | undefined;
    for (const group of monthAfter.groups) {
      for (const cat of group.categories) {
        if (cat.id === "cat-groceries") {
          revertedBudgeted = cat.budgeted;
          break;
        }
      }
    }
    expect(revertedBudgeted).toBe(originalBudgeted);
  });
});
