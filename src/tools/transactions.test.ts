import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockTransaction,
} from "../test-utils.js";
import { registerTransactionTools } from "./transactions.js";

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
  tools = captureToolHandlers(registerTransactionTools, ctx) as Record<
    string,
    ToolHandler
  >;

  ctx.ynabClient.getNameLookup.mockResolvedValue({
    accountById: new Map([["acc-1", "Checking"]]),
    categoryById: new Map([
      [
        "cat-1",
        { name: "Groceries", group_id: "group-1", group_name: "Everyday" },
      ],
    ]),
    payeeById: new Map([["payee-1", "Store"]]),
  });
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: {},
  });
});

describe("create_transactions", () => {
  it("returns created transactions and undo_history_ids", async () => {
    const created = [createMockTransaction({ id: "new-1", amount: -50000 })];
    ctx.ynabClient.createTransactions.mockResolvedValue(created);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "undo-1" }]);

    const handler = tools.create_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          { account_id: "acc-1", date: "2024-01-15", amount: -50 },
        ],
      }),
    );

    expect(result.created_count).toBe(1);
    expect(result.undo_history_ids).toEqual(["undo-1"]);
  });

  it("builds undo entries with type 'delete' and correct entity_id", async () => {
    const created = [createMockTransaction({ id: "new-1", amount: -50000 })];
    ctx.ynabClient.createTransactions.mockResolvedValue(created);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.create_transactions;
    await handler({
      transactions: [{ account_id: "acc-1", date: "2024-01-15", amount: -50 }],
    });

    const entries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(entries[0].undo_action.type).toBe("delete");
    expect(entries[0].undo_action.entity_type).toBe("transaction");
    expect(entries[0].undo_action.entity_id).toBe("new-1");
  });

  it("populates payee_name for newly created payees not in lookup", async () => {
    const created = [
      createMockTransaction({
        id: "new-1",
        amount: -50000,
        payee_id: "payee-new",
      }),
    ];
    ctx.ynabClient.createTransactions.mockResolvedValue(created);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "undo-1" }]);

    const handler = tools.create_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          {
            account_id: "acc-1",
            date: "2024-01-15",
            amount: -50,
            payee_name: "New Store",
          },
        ],
      }),
    );

    expect(result.transactions[0].payee_id).toBe("payee-new");
    expect(result.transactions[0].payee_name).toBe("New Store");
  });

  it("returns error result on API failure", async () => {
    ctx.ynabClient.createTransactions.mockRejectedValue(new Error("API error"));

    const handler = tools.create_transactions;
    const result = await handler({
      transactions: [{ account_id: "acc-1", date: "2024-01-15", amount: -50 }],
    });

    expect(result.isError).toBe(true);
  });

  it("passes session_id through to undo recording", async () => {
    const created = [createMockTransaction({ id: "new-1", amount: -50000 })];
    ctx.ynabClient.createTransactions.mockResolvedValue(created);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "undo-1" }]);

    const handler = tools.create_transactions;
    const result = parseResult(
      await handler({
        session_id: "session-abc",
        transactions: [
          { account_id: "acc-1", date: "2024-01-15", amount: -50 },
        ],
      }),
    );

    expect(ctx.undoEngine.recordEntries.mock.calls[0][2]).toBe("session-abc");
    expect(result.session_id).toBe("session-abc");
  });

  it("defaults session_id to shared when omitted", async () => {
    const created = [createMockTransaction({ id: "new-1", amount: -50000 })];
    ctx.ynabClient.createTransactions.mockResolvedValue(created);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "undo-1" }]);

    const handler = tools.create_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          { account_id: "acc-1", date: "2024-01-15", amount: -50 },
        ],
      }),
    );

    expect(ctx.undoEngine.recordEntries.mock.calls[0][2]).toBe("shared");
    expect(result.session_id).toBe("shared");
  });
});

describe("update_transactions", () => {
  it("prefetches existing transactions and builds undo snapshots", async () => {
    const before = createMockTransaction({
      id: "tx-1",
      amount: -30000,
      memo: "Old",
    });
    const after = createMockTransaction({
      id: "tx-1",
      amount: -50000,
      memo: "New",
    });

    ctx.ynabClient.getTransactionById.mockResolvedValue(before);
    ctx.ynabClient.updateTransactions.mockResolvedValue([after]);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.update_transactions;
    const result = parseResult(
      await handler({
        transactions: [{ transaction_id: "tx-1", memo: "New" }],
      }),
    );

    expect(result.results[0].status).toBe("updated");

    const undoEntries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(undoEntries[0].undo_action.type).toBe("update");
    expect(undoEntries[0].undo_action.expected_state).toEqual(after);
    expect(undoEntries[0].undo_action.restore_state).toEqual(before);
  });

  it("skips missing transactions with per-item error", async () => {
    ctx.ynabClient.getTransactionById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        createMockTransaction({ id: "tx-2", amount: -10000 }),
      );
    ctx.ynabClient.updateTransactions.mockResolvedValue([
      createMockTransaction({ id: "tx-2", amount: -20000 }),
    ]);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.update_transactions;
    const result = parseResult(
      await handler({
        transactions: [
          { transaction_id: "tx-missing", memo: "X" },
          { transaction_id: "tx-2", memo: "Y" },
        ],
      }),
    );

    const errorResult = result.results.find(
      (r: { transaction_id: string }) => r.transaction_id === "tx-missing",
    );
    expect(errorResult.status).toBe("error");
    expect(errorResult.message).toContain("not found");

    const updatedResult = result.results.find(
      (r: { transaction_id: string }) => r.transaction_id === "tx-2",
    );
    expect(updatedResult.status).toBe("updated");
  });

  it("does not record undo entries when all updates fail", async () => {
    ctx.ynabClient.getTransactionById.mockResolvedValue(null);

    const handler = tools.update_transactions;
    await handler({
      transactions: [{ transaction_id: "tx-missing", memo: "X" }],
    });

    expect(ctx.undoEngine.recordEntries).not.toHaveBeenCalled();
  });
});

describe("delete_transactions", () => {
  it("snapshots before deleting and builds create undo entries", async () => {
    const before = createMockTransaction({ id: "tx-1", amount: -50000 });
    ctx.ynabClient.getTransactionById.mockResolvedValue(before);
    ctx.ynabClient.deleteTransaction.mockResolvedValue({ id: "tx-1" });
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.delete_transactions;
    const result = parseResult(await handler({ transaction_ids: ["tx-1"] }));

    expect(result.results[0].status).toBe("deleted");

    const undoEntries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(undoEntries[0].undo_action.type).toBe("create");
    expect(undoEntries[0].undo_action.entity_type).toBe("transaction");
    expect(undoEntries[0].undo_action.restore_state).toEqual(before);
  });

  it("reports error when transaction not found", async () => {
    ctx.ynabClient.getTransactionById.mockResolvedValue(null);

    const handler = tools.delete_transactions;
    const result = parseResult(
      await handler({ transaction_ids: ["tx-missing"] }),
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("not found");
  });

  it("reports error when delete API returns null", async () => {
    const before = createMockTransaction({ id: "tx-1" });
    ctx.ynabClient.getTransactionById.mockResolvedValue(before);
    ctx.ynabClient.deleteTransaction.mockResolvedValue(null);

    const handler = tools.delete_transactions;
    const result = parseResult(await handler({ transaction_ids: ["tx-1"] }));

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("failed");
  });

  it("does not record undo when no deletes succeed", async () => {
    ctx.ynabClient.getTransactionById.mockResolvedValue(null);

    const handler = tools.delete_transactions;
    await handler({ transaction_ids: ["tx-missing"] });

    expect(ctx.undoEngine.recordEntries).not.toHaveBeenCalled();
  });

  it("continues after an item delete throws", async () => {
    const before1 = createMockTransaction({ id: "tx-1" });
    const before2 = createMockTransaction({ id: "tx-2" });
    ctx.ynabClient.getTransactionById
      .mockResolvedValueOnce(before1)
      .mockResolvedValueOnce(before2);
    ctx.ynabClient.deleteTransaction
      .mockResolvedValueOnce({ id: "tx-1" })
      .mockRejectedValueOnce(new Error("Delete exploded"));
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.delete_transactions;
    const result = parseResult(
      await handler({ transaction_ids: ["tx-1", "tx-2"] }),
    );

    expect(result.results[0].status).toBe("deleted");
    expect(result.results[1].status).toBe("error");
    expect(result.results[1].message).toContain("Delete exploded");
    expect(result.undo_history_ids).toEqual(["u1"]);
  });
});
