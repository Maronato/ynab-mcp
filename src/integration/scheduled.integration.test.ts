import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import { futureDateStr, seedStandardBudget } from "./seed.js";

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({ seed: seedStandardBudget });
});

afterEach(async () => {
  await harness.close();
});

describe("scheduled transactions CRUD", () => {
  it("creates, updates, and deletes a scheduled transaction with undo history", async () => {
    // Baseline: count scheduled transactions before
    const baseline = (await harness.callTool(
      "get_scheduled_transactions",
      {},
    )) as { count: number };

    // Create
    const created = (await harness.callTool("create_scheduled_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(2, 1),
          amount: -100.0,
          frequency: "monthly",
          payee_name: "Landlord",
          category_id: "cat-rent",
          memo: "Monthly rent",
        },
      ],
    })) as {
      created_count: number;
      transactions: Array<{
        id: string;
        amount: number;
        amount_display: string;
        frequency: string;
        category_name: string;
      }>;
      undo_history_ids: string[];
    };

    expect(created.created_count).toBe(1);
    expect(created.transactions).toHaveLength(1);
    expect(created.transactions[0].amount).toBe(-100.0);
    expect(created.transactions[0].amount_display).toBe("-$100.00");
    expect(created.transactions[0].frequency).toBe("monthly");
    expect(created.transactions[0].category_name).toBe("Rent/Mortgage");
    expect(created.undo_history_ids).toHaveLength(1);

    const stxId = created.transactions[0].id;

    // Update amount
    const updated = (await harness.callTool("update_scheduled_transactions", {
      transactions: [
        {
          scheduled_transaction_id: stxId,
          amount: -120.0,
        },
      ],
    })) as {
      results: Array<{
        status: string;
        transaction?: { amount: number; amount_display: string };
      }>;
      undo_history_ids: string[];
    };

    expect(updated.results[0].status).toBe("updated");
    expect(updated.results[0].transaction?.amount).toBe(-120.0);
    expect(updated.results[0].transaction?.amount_display).toBe("-$120.00");
    expect(updated.undo_history_ids).toHaveLength(1);

    // Delete
    const deleted = (await harness.callTool("delete_scheduled_transactions", {
      scheduled_transaction_ids: [stxId],
    })) as {
      results: Array<{ status: string }>;
      undo_history_ids: string[];
    };

    expect(deleted.results[0].status).toBe("deleted");
    expect(deleted.undo_history_ids).toHaveLength(1);

    // Verify count returned to baseline
    const afterDelete = (await harness.callTool(
      "get_scheduled_transactions",
      {},
    )) as { count: number; transactions: Array<{ id: string }> };
    expect(afterDelete.count).toBe(baseline.count);
    const found = afterDelete.transactions.find((t) => t.id === stxId);
    expect(found).toBeUndefined();
  });
});

describe("frequency validation", () => {
  it("accepts valid frequency 'monthly'", async () => {
    const result = (await harness.callTool("create_scheduled_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: futureDateStr(3, 1),
          amount: -50.0,
          frequency: "monthly",
          category_id: "cat-groceries",
        },
      ],
    })) as { created_count: number };

    expect(result.created_count).toBe(1);
  });

  it("rejects invalid frequency 'everyOtherWeek'", async () => {
    await expect(
      harness.callTool("create_scheduled_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: futureDateStr(3, 1),
            amount: -50.0,
            frequency: "everyOtherWeek",
            category_id: "cat-groceries",
          },
        ],
      }),
    ).rejects.toThrow();
  });
});
