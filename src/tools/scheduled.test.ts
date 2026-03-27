import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockScheduledTransaction,
} from "../test-utils.js";
import { registerScheduledTransactionTools } from "./scheduled.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let tools: Record<string, ToolHandler>;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  ctx = createMockContext();
  tools = captureToolHandlers(registerScheduledTransactionTools, ctx) as Record<
    string,
    ToolHandler
  >;

  ctx.ynabClient.getNameLookup.mockResolvedValue({
    accountById: new Map([["acc-1", "Checking"]]),
    categoryById: new Map([["cat-1", "Groceries"]]),
    payeeById: new Map([["payee-1", "Store"]]),
  });
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: {},
  });
});

describe("create_scheduled_transactions", () => {
  it("creates via individual API calls and records undo entries", async () => {
    const created = createMockScheduledTransaction({
      id: "stx-new",
      amount: -50000,
    });
    ctx.ynabClient.createScheduledTransaction.mockResolvedValue(created);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.create_scheduled_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          {
            account_id: "acc-1",
            date: "2024-01-01",
            amount: -50,
            frequency: "monthly",
          },
        ],
      }),
    );

    expect(result.created_count).toBe(1);
    expect(result.undo_history_ids).toEqual(["u1"]);

    const entries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(entries[0].undo_action.type).toBe("delete");
    expect(entries[0].undo_action.entity_type).toBe("scheduled_transaction");
  });

  it("populates payee_name for newly created payees not in lookup", async () => {
    const created = createMockScheduledTransaction({
      id: "stx-new",
      amount: -50000,
      payee_id: "payee-new",
    });
    ctx.ynabClient.createScheduledTransaction.mockResolvedValue(created);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.create_scheduled_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          {
            account_id: "acc-1",
            date: "2024-01-01",
            amount: -50,
            frequency: "monthly",
            payee_name: "New Store",
          },
        ],
      }),
    );

    expect(result.transactions[0].payee_id).toBe("payee-new");
    expect(result.transactions[0].payee_name).toBe("New Store");
  });

  it("makes new payee visible to subsequent iterations in the same batch", async () => {
    const created1 = createMockScheduledTransaction({
      id: "stx-1",
      amount: -50000,
      payee_id: "payee-new",
    });
    const created2 = createMockScheduledTransaction({
      id: "stx-2",
      amount: -60000,
      payee_id: "payee-new",
    });
    ctx.ynabClient.createScheduledTransaction
      .mockResolvedValueOnce(created1)
      .mockResolvedValueOnce(created2);
    ctx.undoEngine.recordEntries.mockResolvedValue([
      { id: "u1" },
      { id: "u2" },
    ]);

    const handler = tools.create_scheduled_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          {
            account_id: "acc-1",
            date: "2024-01-01",
            amount: -50,
            frequency: "monthly",
            payee_name: "New Store",
          },
          {
            account_id: "acc-1",
            date: "2024-02-01",
            amount: -60,
            frequency: "monthly",
            payee_name: "New Store",
          },
        ],
      }),
    );

    expect(result.transactions[0].payee_name).toBe("New Store");
    expect(result.transactions[1].payee_name).toBe("New Store");
  });

  it("preserves successful creates when a later item fails", async () => {
    const created = createMockScheduledTransaction({
      id: "stx-new",
      amount: -50000,
    });
    ctx.ynabClient.createScheduledTransaction
      .mockResolvedValueOnce(created)
      .mockRejectedValueOnce(new Error("API down"));
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.create_scheduled_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          {
            account_id: "acc-1",
            date: "2024-01-01",
            amount: -50,
            frequency: "monthly",
          },
          {
            account_id: "acc-1",
            date: "2024-02-01",
            amount: -60,
            frequency: "monthly",
          },
        ],
      }),
    );

    expect(result.created_count).toBe(1);
    expect(result.transactions).toHaveLength(1);
    expect(result.undo_history_ids).toEqual(["u1"]);
    expect(result.results[0].status).toBe("created");
    expect(result.results[1].status).toBe("error");
    expect(result.results[1].message).toContain("API down");
  });
});

describe("update_scheduled_transactions", () => {
  it("prefetches existing and passes before to update call", async () => {
    const before = createMockScheduledTransaction({
      id: "stx-1",
      amount: -30000,
    });
    const after = createMockScheduledTransaction({
      id: "stx-1",
      amount: -50000,
    });
    ctx.ynabClient.getScheduledTransactionById.mockResolvedValue(before);
    ctx.ynabClient.updateScheduledTransaction.mockResolvedValue(after);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.update_scheduled_transactions;
    const result = parseResult(
      await handler({
        transactions: [{ scheduled_transaction_id: "stx-1", amount: -50 }],
      }),
    );

    expect(result.results[0].status).toBe("updated");

    // Verify before was passed as prefetched existing
    expect(ctx.ynabClient.updateScheduledTransaction).toHaveBeenCalledWith(
      "budget-1",
      expect.objectContaining({ scheduled_transaction_id: "stx-1" }),
      before,
    );
  });

  it("skips missing scheduled transactions with error", async () => {
    ctx.ynabClient.getScheduledTransactionById.mockResolvedValue(null);

    const handler = tools.update_scheduled_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          { scheduled_transaction_id: "stx-missing", amount: -50 },
        ],
      }),
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("not found");
  });

  it("builds undo entries with snapshotScheduledTransaction", async () => {
    const before = createMockScheduledTransaction({ id: "stx-1" });
    const after = createMockScheduledTransaction({
      id: "stx-1",
      amount: -99000,
    });
    ctx.ynabClient.getScheduledTransactionById.mockResolvedValue(before);
    ctx.ynabClient.updateScheduledTransaction.mockResolvedValue(after);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.update_scheduled_transactions;
    await handler({
      transactions: [{ scheduled_transaction_id: "stx-1", amount: -99 }],
    });

    const entries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(entries[0].undo_action.type).toBe("update");
    expect(entries[0].undo_action.entity_type).toBe("scheduled_transaction");
    // snapshotScheduledTransaction maps date_first → date and drops date_next
    expect(entries[0].undo_action.expected_state.date).toBe("2024-01-01");
    expect(entries[0].undo_action.expected_state.date_first).toBeUndefined();
    expect(entries[0].undo_action.restore_state.date).toBe("2024-01-01");
  });

  it("continues after an item update throws", async () => {
    const before1 = createMockScheduledTransaction({ id: "stx-1" });
    const before2 = createMockScheduledTransaction({ id: "stx-2" });
    const after1 = createMockScheduledTransaction({
      id: "stx-1",
      amount: -70000,
    });
    ctx.ynabClient.getScheduledTransactionById
      .mockResolvedValueOnce(before1)
      .mockResolvedValueOnce(before2);
    ctx.ynabClient.updateScheduledTransaction
      .mockResolvedValueOnce(after1)
      .mockRejectedValueOnce(new Error("Update exploded"));
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.update_scheduled_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          { scheduled_transaction_id: "stx-1", amount: -70 },
          { scheduled_transaction_id: "stx-2", amount: -80 },
        ],
      }),
    );

    expect(result.results[0].status).toBe("updated");
    expect(result.results[1].status).toBe("error");
    expect(result.results[1].message).toContain("Update exploded");
    expect(result.undo_history_ids).toEqual(["u1"]);
  });
});

describe("delete_scheduled_transactions", () => {
  it("snapshots before deleting and builds create undo entry", async () => {
    const before = createMockScheduledTransaction({ id: "stx-1" });
    ctx.ynabClient.getScheduledTransactionById.mockResolvedValue(before);
    ctx.ynabClient.deleteScheduledTransaction.mockResolvedValue({
      id: "stx-1",
    });
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.delete_scheduled_transactions;
    const result = parseResult(
      await handler({ scheduled_transaction_ids: ["stx-1"] }),
    );

    expect(result.results[0].status).toBe("deleted");

    const entries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(entries[0].undo_action.type).toBe("create");
    // snapshotScheduledTransaction maps date_first → date
    expect(entries[0].undo_action.restore_state.date).toBe("2024-01-01");
    expect(entries[0].undo_action.restore_state.id).toBe("stx-1");
  });

  it("reports per-item error when not found or delete fails", async () => {
    ctx.ynabClient.getScheduledTransactionById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createMockScheduledTransaction({ id: "stx-2" }));
    ctx.ynabClient.deleteScheduledTransaction.mockResolvedValue(null);

    const handler = tools.delete_scheduled_transactions;
    const result = parseResult(
      await handler({
        scheduled_transaction_ids: ["stx-missing", "stx-2"],
      }),
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("not found");
    expect(result.results[1].status).toBe("error");
    expect(result.results[1].message).toContain("failed");
  });

  it("continues after an item delete throws", async () => {
    ctx.ynabClient.getScheduledTransactionById
      .mockResolvedValueOnce(createMockScheduledTransaction({ id: "stx-1" }))
      .mockResolvedValueOnce(createMockScheduledTransaction({ id: "stx-2" }));
    ctx.ynabClient.deleteScheduledTransaction
      .mockResolvedValueOnce({ id: "stx-1" })
      .mockRejectedValueOnce(new Error("Delete exploded"));
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.delete_scheduled_transactions;
    const result = parseResult(
      await handler({
        scheduled_transaction_ids: ["stx-1", "stx-2"],
      }),
    );

    expect(result.results[0].status).toBe("deleted");
    expect(result.results[1].status).toBe("error");
    expect(result.results[1].message).toContain("Delete exploded");
    expect(result.undo_history_ids).toEqual(["u1"]);
  });
});
