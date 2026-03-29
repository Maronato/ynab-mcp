import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import {
  endOfMonth,
  futureDateStr,
  LAST_MONTH,
  NEXT_MONTH,
  seedStandardBudget,
  TWO_MONTHS_AGO,
} from "./seed.js";

/** First day of a month `monthsFromNow` months in the future (YYYY-MM-DD). */
function futureMonthStr(monthsFromNow: number): string {
  return futureDateStr(monthsFromNow, 1);
}

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({
    seed: seedStandardBudget,
  });
});

afterEach(async () => {
  await harness.close();
});

describe("search_transactions", () => {
  it("returns seeded transactions with default query", async () => {
    const result = (await harness.callTool("search_transactions", {
      queries: [{}],
    })) as {
      budget_id: string;
      result_sets: Array<{
        query_index: number;
        count: number;
        transactions: Array<{
          id: string;
          amount: number;
          amount_display: string;
        }>;
      }>;
    };

    expect(result).toHaveProperty("budget_id");
    expect(result.result_sets).toHaveLength(1);
    // Default limit is 50, so all 10 seed transactions should be returned
    const rs = result.result_sets[0];
    expect(rs.count).toBe(rs.transactions.length);
    expect(rs.count).toBeGreaterThanOrEqual(10);

    // Every returned transaction should have amount and amount_display
    for (const tx of rs.transactions) {
      expect(tx).toHaveProperty("id");
      expect(typeof tx.amount).toBe("number");
      expect(typeof tx.amount_display).toBe("string");
    }
  });

  it("filters by since_date", async () => {
    const result = (await harness.callTool("search_transactions", {
      queries: [{ since_date: LAST_MONTH }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ date: string }>;
      }>;
    };

    const txs = result.result_sets[0].transactions;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.date >= LAST_MONTH).toBe(true);
    }
    // Cross-check: no transactions before the filter date
    const beforeLastMonth = endOfMonth(TWO_MONTHS_AGO);
    const jan = (
      (await harness.callTool("search_transactions", {
        queries: [{ until_date: beforeLastMonth }],
      })) as { result_sets: Array<{ count: number }> }
    ).result_sets[0].count;
    // since_date count + jan count should equal total seed count
    const all = (
      (await harness.callTool("search_transactions", {
        queries: [{}],
      })) as { result_sets: Array<{ count: number }> }
    ).result_sets[0].count;
    expect(result.result_sets[0].count + jan).toBe(all);
  });

  it("filters by payee_name_contains", async () => {
    const result = (await harness.callTool("search_transactions", {
      queries: [{ payee_name_contains: "landlord" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ payee_name: string }>;
      }>;
    };

    const txs = result.result_sets[0].transactions;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.payee_name.toLowerCase()).toContain("landlord");
    }
  });

  it("filters by category_name_contains", async () => {
    const result = (await harness.callTool("search_transactions", {
      queries: [{ category_name_contains: "dining" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ category_name: string }>;
      }>;
    };

    const txs = result.result_sets[0].transactions;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.category_name.toLowerCase()).toContain("dining");
    }
  });

  it("filters by amount_min and amount_max", async () => {
    const result = (await harness.callTool("search_transactions", {
      queries: [{ amount_min: -90.0, amount_max: -30.0 }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ amount: number }>;
      }>;
    };

    const txs = result.result_sets[0].transactions;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.amount).toBeGreaterThanOrEqual(-90.0);
      expect(tx.amount).toBeLessThanOrEqual(-30.0);
    }
  });
});

describe("create_transactions", () => {
  it("creates a single transaction and finds it via search", async () => {
    const before = (await harness.callTool("search_transactions", {
      queries: [{ since_date: NEXT_MONTH }],
    })) as { result_sets: Array<{ count: number }> };

    // Get account balance before creation
    const accountsBefore = (await harness.callTool("get_accounts", {})) as {
      accounts: Array<{ id: string; balance: number }>;
    };
    const checkingBefore = accountsBefore.accounts.find(
      (a) => a.id === "acct-checking",
    )!;

    const createResult = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 1),
          amount: -25.5,
          payee_name: "Coffee Shop",
          category_id: "cat-dining",
          memo: "Morning coffee",
        },
      ],
    })) as {
      created_count: number;
      transactions: Array<{
        id: string;
        amount: number;
        amount_display: string;
      }>;
      undo_history_ids: string[];
    };

    expect(createResult.created_count).toBe(1);
    expect(createResult.transactions).toHaveLength(1);
    expect(createResult.transactions[0]).toHaveProperty("id");
    expect(createResult.transactions[0].amount).toBe(-25.5);
    expect(createResult.transactions[0].amount_display).toBe("-$25.50");

    // Search to verify it appears — count should have increased by 1
    const after = (await harness.callTool("search_transactions", {
      queries: [{ since_date: NEXT_MONTH }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ memo: string; amount: number }>;
      }>;
    };

    expect(after.result_sets[0].count).toBe(before.result_sets[0].count + 1);
    expect(after.result_sets[0].transactions[0].memo).toBe("Morning coffee");
    expect(after.result_sets[0].transactions[0].amount).toBe(-25.5);

    // Verify account balance decreased by the transaction amount
    const accountsAfter = (await harness.callTool("get_accounts", {})) as {
      accounts: Array<{ id: string; balance: number }>;
    };
    const checkingAfter = accountsAfter.accounts.find(
      (a) => a.id === "acct-checking",
    )!;
    expect(checkingAfter.balance).toBe(checkingBefore.balance - 25.5);
  });

  it("creates a split transaction with subtransactions", async () => {
    const result = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 2),
          amount: -100.0,
          payee_name: "Supermarket",
          subtransactions: [
            { amount: -60.0, category_id: "cat-groceries", memo: "Food" },
            { amount: -40.0, category_id: "cat-dining", memo: "Snacks" },
          ],
        },
      ],
    })) as {
      created_count: number;
      transactions: Array<{
        amount: number;
        amount_display: string;
        is_split: boolean;
        subtransactions: Array<{
          amount: number;
          amount_display: string;
          memo: string;
        }>;
      }>;
    };

    expect(result.created_count).toBe(1);
    const tx = result.transactions[0];
    expect(tx.is_split).toBe(true);
    expect(tx.amount).toBe(-100.0);
    expect(tx.amount_display).toBe("-$100.00");
    expect(tx.subtransactions).toHaveLength(2);
    // Verify sub amounts are in currency units
    const subAmounts = tx.subtransactions
      .map((s) => s.amount)
      .sort((a, b) => a - b);
    expect(subAmounts).toEqual([-60.0, -40.0]);
  });

  it("returns undo_history_ids", async () => {
    const result = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 3),
          amount: -10.0,
        },
      ],
    })) as { undo_history_ids: string[] };

    expect(result.undo_history_ids).toBeDefined();
    expect(Array.isArray(result.undo_history_ids)).toBe(true);
    expect(result.undo_history_ids.length).toBeGreaterThan(0);
  });

  it("returns formatted transaction data with correct amount", async () => {
    const result = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 4),
          amount: -42.99,
          payee_name: "Hardware Store",
          category_id: "cat-groceries",
        },
      ],
    })) as {
      transactions: Array<{
        id: string;
        date: string;
        amount: number;
        amount_display: string;
        account_name: string;
        category_name: string;
        is_split: boolean;
      }>;
    };

    const tx = result.transactions[0];
    expect(tx).toHaveProperty("id");
    expect(tx.date).toBe(futureDateStr(1, 4));
    // Tool input is currency units (-42.99), output should also be currency units
    expect(tx.amount).toBe(-42.99);
    expect(tx.amount_display).toBe("-$42.99");
    expect(tx.account_name).toBe("Checking");
    expect(tx.category_name).toBe("Groceries");
    expect(tx.is_split).toBe(false);
  });
});

describe("update_transactions", () => {
  it("updates memo and amount, verifiable via search", async () => {
    // Create a transaction first
    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 5),
          amount: -30.0,
          memo: "Original memo",
        },
      ],
    })) as { transactions: Array<{ id: string }> };

    const txId = created.transactions[0].id;

    // Update it
    const updateResult = (await harness.callTool("update_transactions", {
      transactions: [
        {
          transaction_id: txId,
          memo: "Updated memo",
          amount: -45.0,
        },
      ],
    })) as {
      results: Array<{
        status: string;
        transaction: {
          memo: string;
          amount: number;
          amount_display: string;
        };
      }>;
      undo_history_ids: string[];
    };

    expect(updateResult.results[0].status).toBe("updated");
    expect(updateResult.results[0].transaction.memo).toBe("Updated memo");
    expect(updateResult.results[0].transaction.amount).toBe(-45.0);
    expect(updateResult.results[0].transaction.amount_display).toBe("-$45.00");

    // Verify via search — original memo gone, updated memo present
    const searchOld = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "Original memo" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchOld.result_sets[0].count).toBe(0);

    const search = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "Updated memo" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ amount: number }>;
      }>;
    };

    expect(search.result_sets[0].count).toBe(1);
    expect(search.result_sets[0].transactions[0].amount).toBe(-45.0);
  });

  it("returns undo_history_ids", async () => {
    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 6),
          amount: -10.0,
        },
      ],
    })) as { transactions: Array<{ id: string }> };

    const result = (await harness.callTool("update_transactions", {
      transactions: [
        {
          transaction_id: created.transactions[0].id,
          memo: "test",
        },
      ],
    })) as { undo_history_ids: string[] };

    expect(result.undo_history_ids).toBeDefined();
    expect(result.undo_history_ids.length).toBeGreaterThan(0);
  });
});

describe("delete_transactions", () => {
  it("deletes a transaction so search no longer finds it", async () => {
    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 7),
          amount: -20.0,
          memo: "To be deleted",
        },
      ],
    })) as { transactions: Array<{ id: string }> };

    const txId = created.transactions[0].id;

    // Confirm it exists before delete
    const beforeDelete = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "To be deleted" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(beforeDelete.result_sets[0].count).toBe(1);

    // Get account balance before deletion
    const accountsBefore = (await harness.callTool("get_accounts", {})) as {
      accounts: Array<{ id: string; balance: number }>;
    };
    const checkingBefore = accountsBefore.accounts.find(
      (a) => a.id === "acct-checking",
    )!;

    const deleteResult = (await harness.callTool("delete_transactions", {
      transaction_ids: [txId],
    })) as {
      results: Array<{ status: string; transaction_id: string }>;
      undo_history_ids: string[];
    };

    expect(deleteResult.results[0].status).toBe("deleted");
    expect(deleteResult.results[0].transaction_id).toBe(txId);

    // Verify gone from search
    const afterDelete = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "To be deleted" }],
    })) as { result_sets: Array<{ count: number }> };

    expect(afterDelete.result_sets[0].count).toBe(0);

    // Verify account balance restored (outflow of -20.0 reversed = +20.0)
    const accountsAfter = (await harness.callTool("get_accounts", {})) as {
      accounts: Array<{ id: string; balance: number }>;
    };
    const checkingAfter = accountsAfter.accounts.find(
      (a) => a.id === "acct-checking",
    )!;
    expect(checkingAfter.balance).toBe(checkingBefore.balance + 20.0);
  });

  it("returns undo_history_ids", async () => {
    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(1, 8),
          amount: -5.0,
        },
      ],
    })) as { transactions: Array<{ id: string }> };

    const result = (await harness.callTool("delete_transactions", {
      transaction_ids: [created.transactions[0].id],
    })) as { undo_history_ids: string[] };

    expect(result.undo_history_ids).toBeDefined();
    expect(result.undo_history_ids.length).toBeGreaterThan(0);
  });
});

describe("batch operations", () => {
  it("creates, updates, and deletes in batch, verifies final state", async () => {
    // Baseline
    const baseline = (await harness.callTool("search_transactions", {
      queries: [{ since_date: futureMonthStr(2) }],
    })) as { result_sets: Array<{ count: number }> };

    // Create 3 transactions
    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(2, 1),
          amount: -10.0,
          memo: "Batch A",
        },
        {
          account_id: "acct-checking",
          date: futureDateStr(2, 2),
          amount: -20.0,
          memo: "Batch B",
        },
        {
          account_id: "acct-checking",
          date: futureDateStr(2, 3),
          amount: -30.0,
          memo: "Batch C",
        },
      ],
    })) as {
      created_count: number;
      transactions: Array<{ id: string; amount: number }>;
    };

    expect(created.created_count).toBe(3);
    expect(created.transactions).toHaveLength(3);
    expect(created.transactions[0].amount).toBe(-10.0);
    expect(created.transactions[1].amount).toBe(-20.0);
    expect(created.transactions[2].amount).toBe(-30.0);

    const [idA, idB, idC] = created.transactions.map((t) => t.id);

    // Update 2 of them
    const updated = (await harness.callTool("update_transactions", {
      transactions: [
        { transaction_id: idA, memo: "Batch A Updated" },
        { transaction_id: idB, memo: "Batch B Updated" },
      ],
    })) as { results: Array<{ status: string }> };

    expect(updated.results).toHaveLength(2);
    expect(updated.results[0].status).toBe("updated");
    expect(updated.results[1].status).toBe("updated");

    // Delete 1
    const deleted = (await harness.callTool("delete_transactions", {
      transaction_ids: [idC],
    })) as { results: Array<{ status: string }> };

    expect(deleted.results[0].status).toBe("deleted");

    // Verify final state: baseline + 2 (3 created, 1 deleted)
    const search = (await harness.callTool("search_transactions", {
      queries: [{ since_date: futureMonthStr(2) }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ memo: string }>;
      }>;
    };

    expect(search.result_sets[0].count).toBe(baseline.result_sets[0].count + 2);
    const memos = search.result_sets[0].transactions.map((t) => t.memo);
    expect(memos).toContain("Batch A Updated");
    expect(memos).toContain("Batch B Updated");
    expect(memos).not.toContain("Batch C");
  });
});

describe("error handling", () => {
  it("search with invalid budget_id returns error", async () => {
    await expect(
      harness.callTool("search_transactions", {
        budget_id: "nonexistent-budget",
        queries: [{}],
      }),
    ).rejects.toThrow();
  });

  it("create transaction with missing required fields returns error", async () => {
    await expect(
      harness.callTool("create_transactions", {
        transactions: [{ memo: "no account or date or amount" }],
      }),
    ).rejects.toThrow();
  });
});
