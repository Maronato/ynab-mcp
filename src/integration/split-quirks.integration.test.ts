import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import { dateStr, seedStandardBudget } from "./seed.js";

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({ seed: seedStandardBudget });
});

afterEach(async () => {
  await harness.close();
});

describe("split transaction creation", () => {
  it("creates a split with subtransactions and resolves category names", async () => {
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -100.0,
          memo: "Split test",
          subtransactions: [
            { amount: -60.0, category_id: "cat-groceries" },
            { amount: -40.0, category_id: "cat-dining" },
          ],
        },
      ],
    })) as {
      created_count: number;
      transactions: Array<{
        id: string;
        subtransactions: Array<{
          amount: number;
          category_name: string;
          category_id: string;
        }>;
      }>;
    };

    expect(created.created_count).toBe(1);
    const tx = created.transactions[0];
    expect(tx.subtransactions).toHaveLength(2);

    // Verify amounts
    const amounts = tx.subtransactions
      .map((s) => s.amount)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([-60.0, -40.0]);

    // Verify category names are resolved
    const catNames = tx.subtransactions.map((s) => s.category_name).sort();
    expect(catNames).toEqual(["Dining Out", "Groceries"]);

    // Verify via search
    const search = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Split test" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{
          subtransactions: Array<{ amount: number }>;
        }>;
      }>;
    };
    expect(search.result_sets[0].count).toBe(1);
    expect(search.result_sets[0].transactions[0].subtransactions).toHaveLength(
      2,
    );
  });
});

describe("split subtransaction amount validation", () => {
  it("rejects a split where subtransaction amounts do not sum to parent", async () => {
    await expect(
      harness.callTool("create_transactions", {
        budget_id: "budget-1",
        transactions: [
          {
            account_id: "acct-checking",
            date: dateStr(0, 15),
            amount: -100.0,
            memo: "Bad split",
            subtransactions: [
              { amount: -60.0, category_id: "cat-groceries" },
              { amount: -30.0, category_id: "cat-dining" },
              // Sums to -90, parent is -100 — mismatch
            ],
          },
        ],
      }),
    ).rejects.toThrow(/subtransaction amounts must sum to parent amount/i);
  });
});

describe("split frozen fields on update", () => {
  it("updates category_id on a split via replace (new ID)", async () => {
    // Create a split
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -80.0,
          memo: "Frozen field test",
          subtransactions: [
            { amount: -50.0, category_id: "cat-groceries" },
            { amount: -30.0, category_id: "cat-dining" },
          ],
        },
      ],
    })) as {
      transactions: Array<{ id: string }>;
    };

    const originalId = created.transactions[0].id;

    // Update category_id on the parent -- triggers replace
    const updated = (await harness.callTool("update_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          transaction_id: originalId,
          category_id: "cat-transport",
        },
      ],
    })) as {
      results: Array<{
        status: string;
        transaction_id: string;
        current_transaction_id: string;
        transaction: {
          category_id: string;
          category_name: string;
          amount: number;
          memo: string;
        };
      }>;
    };

    expect(updated.results[0].status).toBe("updated");
    // Replace gives a new ID
    const newId = updated.results[0].current_transaction_id;
    expect(newId).toBeDefined();
    expect(newId).not.toBe(originalId);
    // Verify the category actually changed
    expect(updated.results[0].transaction.category_id).toBe("cat-transport");
    expect(updated.results[0].transaction.category_name).toBe("Transportation");
    // Other fields should be preserved
    expect(updated.results[0].transaction.amount).toBe(-80.0);
    expect(updated.results[0].transaction.memo).toBe("Frozen field test");
  });
});

describe("subtransaction modification triggers replace", () => {
  it("updates subtransactions array via replace", async () => {
    // Create a split
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -90.0,
          memo: "Sub modify test",
          subtransactions: [
            { amount: -50.0, category_id: "cat-groceries" },
            { amount: -40.0, category_id: "cat-dining" },
          ],
        },
      ],
    })) as {
      transactions: Array<{ id: string }>;
    };

    const originalId = created.transactions[0].id;

    // Update with new subtransactions
    const updated = (await harness.callTool("update_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          transaction_id: originalId,
          subtransactions: [
            { amount: -30.0, category_id: "cat-transport" },
            { amount: -60.0, category_id: "cat-utilities" },
          ],
        },
      ],
    })) as {
      results: Array<{
        status: string;
        current_transaction_id: string;
        transaction: {
          subtransactions: Array<{
            amount: number;
            category_name: string;
          }>;
        };
      }>;
    };

    expect(updated.results[0].status).toBe("updated");
    // New ID due to replace
    expect(updated.results[0].current_transaction_id).not.toBe(originalId);

    // Verify the new subtransactions — both amounts and categories changed
    const newTx = updated.results[0].transaction;
    expect(newTx.subtransactions).toHaveLength(2);
    const subAmounts = newTx.subtransactions
      .map((s) => s.amount)
      .sort((a, b) => a - b);
    expect(subAmounts).toEqual([-60.0, -30.0]);
    const subCategoryNames = newTx.subtransactions
      .map((s) => s.category_name)
      .sort();
    expect(subCategoryNames).toEqual(["Transportation", "Utilities"]);
  });
});

describe("split deletion", () => {
  it("deletes a split transaction and categories remain accessible", async () => {
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -70.0,
          memo: "Split delete test",
          subtransactions: [
            { amount: -40.0, category_id: "cat-groceries" },
            { amount: -30.0, category_id: "cat-dining" },
          ],
        },
      ],
    })) as {
      transactions: Array<{ id: string }>;
    };

    const txId = created.transactions[0].id;

    // Delete it
    const deleted = (await harness.callTool("delete_transactions", {
      budget_id: "budget-1",
      transaction_ids: [txId],
    })) as {
      results: Array<{ status: string }>;
    };
    expect(deleted.results[0].status).toBe("deleted");

    // Verify it's gone
    const search = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Split delete test" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(search.result_sets[0].count).toBe(0);

    // Verify category data is still accessible after split deletion
    // (phantom budget activity quirk — categories should not be corrupted)
    const categories = (await harness.callTool("list_categories", {
      budget_id: "budget-1",
    })) as {
      groups: Array<{
        categories: Array<{ id: string; name: string }>;
      }>;
    };
    const allCats = categories.groups.flatMap((g) => g.categories);
    const groceries = allCats.find((c) => c.id === "cat-groceries");
    const dining = allCats.find((c) => c.id === "cat-dining");
    expect(groceries).toBeDefined();
    expect(groceries?.name).toBe("Groceries");
    expect(dining).toBeDefined();
    expect(dining?.name).toBe("Dining Out");
  });
});

describe("undo after split replace", () => {
  it("creates, updates (replace), then undoes the update", async () => {
    // 1. Create a split
    const created = (await harness.callTool("create_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -120.0,
          memo: "Undo replace test",
          subtransactions: [
            { amount: -70.0, category_id: "cat-groceries" },
            { amount: -50.0, category_id: "cat-dining" },
          ],
        },
      ],
    })) as {
      transactions: Array<{ id: string }>;
      undo_history_ids: string[];
    };

    const originalId = created.transactions[0].id;

    // 2. Update subtransactions (triggers replace, new ID)
    const updated = (await harness.callTool("update_transactions", {
      budget_id: "budget-1",
      transactions: [
        {
          transaction_id: originalId,
          subtransactions: [
            { amount: -80.0, category_id: "cat-transport" },
            { amount: -40.0, category_id: "cat-utilities" },
          ],
        },
      ],
    })) as {
      results: Array<{ current_transaction_id: string }>;
      undo_history_ids: string[];
    };

    const replacedId = updated.results[0].current_transaction_id;
    expect(replacedId).not.toBe(originalId);

    // 3. Check undo history contains the update
    const history = (await harness.callTool("list_undo_history", {
      budget_id: "budget-1",
    })) as {
      entries: Array<{ id: string; operation: string }>;
    };
    const updateEntry = history.entries.find(
      (e) => e.id === updated.undo_history_ids[0],
    );
    expect(updateEntry).toBeDefined();
    expect(updateEntry?.operation).toBe("update_transaction");

    // 4. Undo the update -- should restore original subtransactions
    // This uses force=true because the undo engine may need to replace again
    const undoResult = (await harness.callTool("undo_operations", {
      undo_history_ids: updated.undo_history_ids,
      force: true,
    })) as {
      results: Array<{ status: string }>;
      summary: { undone: number };
    };
    expect(undoResult.summary.undone).toBe(1);

    // 5. Verify the restored transaction has original subtransactions
    const search = (await harness.callTool("search_transactions", {
      budget_id: "budget-1",
      queries: [{ memo_contains: "Undo replace test" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{
          id: string;
          subtransactions: Array<{
            amount: number;
            category_name: string;
          }>;
        }>;
      }>;
    };

    expect(search.result_sets[0].count).toBe(1);
    const restored = search.result_sets[0].transactions[0];
    // May have yet another new ID due to re-replace
    expect(restored.subtransactions).toHaveLength(2);
    const restoredAmounts = restored.subtransactions
      .map((s) => s.amount)
      .sort((a, b) => a - b);
    expect(restoredAmounts).toEqual([-70.0, -50.0]);
  });
});
