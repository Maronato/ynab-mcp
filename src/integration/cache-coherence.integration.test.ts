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

describe("delta sync after mutation", () => {
  it("new transaction appears in search after creation", async () => {
    // Record serverKnowledge before mutation
    const skBefore = harness.state.serverKnowledge;

    // Initial search triggers full cache load
    const before = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "delta-test" }],
    })) as { result_sets: Array<{ count: number }> };

    expect(before.result_sets[0].count).toBe(0);

    // Create a transaction
    await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -25.0,
          memo: "delta-test",
          category_id: "cat-groceries",
        },
      ],
    });

    // Verify serverKnowledge increased — proves delta sync tracking works
    expect(harness.state.serverKnowledge).toBeGreaterThan(skBefore);

    // Search again — new transaction should appear
    const after = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "delta-test" }],
    })) as { result_sets: Array<{ count: number }> };

    expect(after.result_sets[0].count).toBe(1);
  });
});

describe("delta sync with deleted transactions", () => {
  it("deleted transaction disappears from search and server_knowledge increases", async () => {
    // 1. Create a transaction
    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -15.0,
          memo: "delta-delete-test",
          category_id: "cat-groceries",
        },
      ],
    })) as { transactions: Array<{ id: string }> };

    const txId = created.transactions[0].id;

    // 2. Note the server_knowledge after creation
    const skAfterCreate = harness.state.serverKnowledge;

    // Verify it exists via search
    const searchBefore = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "delta-delete-test" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchBefore.result_sets[0].count).toBe(1);

    // 3. Delete the transaction
    await harness.callTool("delete_transactions", {
      transaction_ids: [txId],
    });

    // 5. Verify state.serverKnowledge increased after deletion
    expect(harness.state.serverKnowledge).toBeGreaterThan(skAfterCreate);

    // 4. Search again — the deleted transaction should NOT appear
    const searchAfter = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "delta-delete-test" }],
    })) as { result_sets: Array<{ count: number }> };
    expect(searchAfter.result_sets[0].count).toBe(0);
  });
});

describe("cross-entity refresh", () => {
  it("accounts remain accessible after transaction creation", async () => {
    // Load accounts cache
    const accountsBefore = (await harness.callTool("get_accounts", {})) as {
      count: number;
      accounts: Array<{ id: string; name: string }>;
    };

    expect(accountsBefore.count).toBeGreaterThan(0);
    const checkingBefore = accountsBefore.accounts.find(
      (a) => a.id === "acct-checking",
    );
    expect(checkingBefore).toBeDefined();

    // Create a transaction on one of the accounts
    await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: dateStr(0, 15),
          amount: -10.0,
          category_id: "cat-groceries",
        },
      ],
    });

    // Get accounts again — should still work (cache coherent)
    const accountsAfter = (await harness.callTool("get_accounts", {})) as {
      count: number;
      accounts: Array<{ id: string; name: string }>;
    };

    // Same accounts exist — no account was created or deleted
    expect(accountsAfter.count).toBe(accountsBefore.count);
    const checkingAfter = accountsAfter.accounts.find(
      (a) => a.id === "acct-checking",
    );
    expect(checkingAfter).toBeDefined();
    expect(checkingAfter?.name).toBe("Checking");
  });
});

describe("multiple mutations", () => {
  it("all created transactions appear in search with increasing server knowledge", async () => {
    const skStart = harness.state.serverKnowledge;

    // Create 3 transactions one by one
    for (let i = 1; i <= 3; i++) {
      await harness.callTool("create_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: dateStr(0, 15),
            amount: -10.0 * i,
            memo: `multi-test-${i}`,
            category_id: "cat-groceries",
          },
        ],
      });
    }

    // Server knowledge should have increased for each mutation
    expect(harness.state.serverKnowledge).toBeGreaterThan(skStart);

    // Search — all 3 should appear
    const result = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "multi-test" }],
    })) as {
      result_sets: Array<{
        count: number;
        transactions: Array<{ memo: string; amount: number }>;
      }>;
    };

    expect(result.result_sets[0].count).toBe(3);
    // Verify each transaction has the expected amount
    const txsByMemo = new Map(
      result.result_sets[0].transactions.map((t) => [t.memo, t]),
    );
    expect(txsByMemo.get("multi-test-1")?.amount).toBe(-10.0);
    expect(txsByMemo.get("multi-test-2")?.amount).toBe(-20.0);
    expect(txsByMemo.get("multi-test-3")?.amount).toBe(-30.0);
  });
});
