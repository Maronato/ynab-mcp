import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockUndoEntry } from "../test-utils.js";
import { UndoEngine } from "./engine.js";
import type { UndoEntry } from "./types.js";

// --- Mock factories ---

function createMockStore() {
  return {
    appendEntries: vi
      .fn<(budgetId: string, entries: UndoEntry[]) => Promise<void>>()
      .mockResolvedValue(undefined),
    listEntries: vi.fn().mockResolvedValue([]),
    getEntriesByIds: vi.fn().mockResolvedValue([]),
    markEntriesUndone: vi.fn().mockResolvedValue(undefined),
    resolveMappedId: vi
      .fn<(budgetId: string, entityId: string) => Promise<string>>()
      .mockImplementation((_b, entityId) => Promise.resolve(entityId)),
    updateIdMappings: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockClient() {
  return {
    getTransactionById: vi.fn().mockResolvedValue(null),
    getScheduledTransactionById: vi.fn().mockResolvedValue(null),
    getMonthCategoryById: vi.fn().mockResolvedValue(null),
    snapshotTransaction: vi.fn((tx: Record<string, unknown>) => tx),
    snapshotScheduledTransaction: vi.fn((tx: Record<string, unknown>) => tx),
    deleteTransaction: vi.fn().mockResolvedValue(null),
    updateTransactions: vi.fn().mockResolvedValue([]),
    createTransactions: vi.fn().mockResolvedValue([{ id: "new-tx-1" }]),
    deleteScheduledTransaction: vi.fn().mockResolvedValue(null),
    updateScheduledTransaction: vi.fn().mockResolvedValue({}),
    createScheduledTransaction: vi.fn().mockResolvedValue({ id: "new-stx-1" }),
    setCategoryBudget: vi.fn().mockResolvedValue({}),
  };
}

let mockStore: ReturnType<typeof createMockStore>;
let mockClient: ReturnType<typeof createMockClient>;
let engine: UndoEngine;

beforeEach(() => {
  mockStore = createMockStore();
  mockClient = createMockClient();
  engine = new UndoEngine(mockClient as never, mockStore as never);
});

describe("recordEntries", () => {
  it("creates entries with correct format and calls store.appendEntries", async () => {
    const result = await engine.recordEntries("budget-1", [
      {
        operation: "update_transaction",
        description: "Updated tx.",
        undo_action: {
          type: "update",
          entity_type: "transaction",
          entity_id: "tx-1",
          expected_state: {},
          restore_state: {},
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toMatch(/^budget-1::\d+::.+$/);
    expect(result[0].session_id).toBe(engine.getSessionId());
    expect(result[0].status).toBe("active");
    expect(result[0].budget_id).toBe("budget-1");
    expect(mockStore.appendEntries).toHaveBeenCalledOnce();
  });
});

describe("listHistory", () => {
  it("delegates to store.listEntries with correct params", async () => {
    await engine.listHistory("budget-1", "current", 10, true);

    expect(mockStore.listEntries).toHaveBeenCalledWith("budget-1", {
      sessionScope: "current",
      sessionId: engine.getSessionId(),
      limit: 10,
      includeUndone: true,
    });
  });
});

describe("undoOperations — entry resolution", () => {
  it("returns an error for entry IDs that cannot be parsed", async () => {
    const result = await engine.undoOperations(["invalid-id"], false);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      entry_id: "invalid-id",
      status: "error",
    });
    expect(result.results[0].message).toContain("Invalid undo entry ID");
    expect(result.summary.errors).toBe(1);
  });

  it("returns error status for entries not found in store", async () => {
    mockStore.getEntriesByIds.mockResolvedValue([undefined]);

    const result = await engine.undoOperations(["budget-1::123::abc"], false);

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("not found");
  });

  it("returns skipped status for already-undone entries", async () => {
    const undoneEntry = createMockUndoEntry({ status: "undone" });
    mockStore.getEntriesByIds.mockResolvedValue([undoneEntry]);

    const result = await engine.undoOperations([undoneEntry.id], false);

    expect(result.results[0].status).toBe("skipped");
    expect(result.results[0].message).toContain("already undone");
  });
});

describe("undoOperations — conflict detection for 'create' undo type", () => {
  it("returns conflict when entity exists for create undo", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "create",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: {},
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 5000,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    // Entity currently exists
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-1",
      amount: 5000,
    });

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("conflict");
    expect(result.results[0].message).toContain("currently exists");
  });

  it("no conflict when entity does not exist for create undo", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "create",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: {},
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 5000,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue(null);

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("undone");
  });
});

describe("undoOperations — conflict detection for update/delete undo types", () => {
  it("returns conflict when entity no longer exists", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1", amount: 5000 },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue(null);

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("conflict");
    expect(result.results[0].message).toContain("no longer exists");
  });

  it("returns conflict when entity state does not match", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1", amount: 5000 },
        restore_state: { id: "tx-1", amount: 3000 },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-1",
      amount: 9999,
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-1",
      amount: 9999,
    });

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("conflict");
    expect(result.results[0].message).toContain("force=true");
  });

  it("no conflict when entity matches expected state", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1", amount: 5000 },
        restore_state: {
          id: "tx-1",
          amount: 3000,
          account_id: "acc-1",
          date: "2024-01-01",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-1",
      amount: 5000,
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-1",
      amount: 5000,
    });

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("undone");
  });
});

describe("undoOperations — force mode", () => {
  it("bypasses conflict when force is true", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1", amount: 5000 },
        restore_state: {
          id: "tx-1",
          amount: 3000,
          account_id: "acc-1",
          date: "2024-01-01",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-1",
      amount: 9999,
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-1",
      amount: 9999,
    });

    const result = await engine.undoOperations([entry.id], true);

    expect(result.results[0].status).toBe("undone");
    expect(mockClient.updateTransactions).toHaveBeenCalled();
  });
});

describe("undoOperations — transaction undo application", () => {
  it("calls deleteTransaction for delete undo type", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1", amount: 5000 },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-1",
      amount: 5000,
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-1",
      amount: 5000,
    });

    await engine.undoOperations([entry.id], false);

    expect(mockClient.deleteTransaction).toHaveBeenCalledWith(
      "budget-1",
      "tx-1",
    );
  });

  it("calls updateTransactions for update undo type with converted fields", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1", amount: 5000 },
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 3000,
          payee_id: null,
          category_id: "cat-1",
          memo: "Test",
          cleared: "cleared",
          approved: true,
          flag_color: null,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-1",
      amount: 5000,
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-1",
      amount: 5000,
    });

    await engine.undoOperations([entry.id], false);

    expect(mockClient.updateTransactions).toHaveBeenCalledWith("budget-1", [
      expect.objectContaining({
        transaction_id: "tx-1",
        account_id: "acc-1",
        date: "2024-01-01",
        amount: 3, // 3000 / 1000
        payee_id: null,
        category_id: "cat-1",
        memo: "Test",
        cleared: "cleared",
        approved: true,
        flag_color: null,
      }),
    ]);
  });

  it("calls createTransactions and updateIdMappings for create undo type", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "create",
        entity_type: "transaction",
        entity_id: "tx-deleted",
        expected_state: {},
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 5000,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue(null);
    mockClient.createTransactions.mockResolvedValue([{ id: "tx-new" }]);

    await engine.undoOperations([entry.id], false);

    expect(mockClient.createTransactions).toHaveBeenCalledWith("budget-1", [
      expect.objectContaining({ account_id: "acc-1", amount: 5 }),
    ]);
    expect(mockStore.updateIdMappings).toHaveBeenCalledWith(
      "budget-1",
      "tx-deleted",
      "tx-new",
    );
  });
});

describe("undoOperations — scheduled transaction undo", () => {
  it("calls deleteScheduledTransaction for delete type", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "delete",
        entity_type: "scheduled_transaction",
        entity_id: "stx-1",
        expected_state: { id: "stx-1" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getScheduledTransactionById.mockResolvedValue({ id: "stx-1" });
    mockClient.snapshotScheduledTransaction.mockReturnValue({ id: "stx-1" });

    await engine.undoOperations([entry.id], false);

    expect(mockClient.deleteScheduledTransaction).toHaveBeenCalledWith(
      "budget-1",
      "stx-1",
    );
  });

  it("calls updateScheduledTransaction for update type", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "scheduled_transaction",
        entity_id: "stx-1",
        expected_state: { id: "stx-1", amount: 5000 },
        restore_state: {
          account_id: "acc-1",
          date: "2024-02-01",
          amount: 3000,
          frequency: "monthly",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getScheduledTransactionById.mockResolvedValue({
      id: "stx-1",
      amount: 5000,
    });
    mockClient.snapshotScheduledTransaction.mockReturnValue({
      id: "stx-1",
      amount: 5000,
    });

    await engine.undoOperations([entry.id], false);

    expect(mockClient.updateScheduledTransaction).toHaveBeenCalledWith(
      "budget-1",
      expect.objectContaining({
        scheduled_transaction_id: "stx-1",
        amount: 3,
        frequency: "monthly",
      }),
    );
  });

  it("calls createScheduledTransaction and updateIdMappings for create type", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "create",
        entity_type: "scheduled_transaction",
        entity_id: "stx-deleted",
        expected_state: {},
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 5000,
          frequency: "weekly",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getScheduledTransactionById.mockResolvedValue(null);
    mockClient.createScheduledTransaction.mockResolvedValue({ id: "stx-new" });

    await engine.undoOperations([entry.id], false);

    expect(mockClient.createScheduledTransaction).toHaveBeenCalledWith(
      "budget-1",
      expect.objectContaining({ account_id: "acc-1", frequency: "weekly" }),
    );
    expect(mockStore.updateIdMappings).toHaveBeenCalledWith(
      "budget-1",
      "stx-deleted",
      "stx-new",
    );
  });
});

describe("undoOperations — category budget undo", () => {
  it("calls setCategoryBudget with restore_state fields", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "category_budget",
        entity_id: "cat-1",
        expected_state: {
          category_id: "cat-1",
          month: "2024-01-01",
          budgeted: 100000,
        },
        restore_state: {
          category_id: "cat-1",
          month: "2024-01-01",
          budgeted: 50000,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getMonthCategoryById.mockResolvedValue({
      id: "cat-1",
      budgeted: 100000,
    });

    await engine.undoOperations([entry.id], false);

    expect(mockClient.setCategoryBudget).toHaveBeenCalledWith("budget-1", {
      category_id: "cat-1",
      month: "2024-01-01",
      budgeted: 50, // 50000 / 1000
    });
  });
});

describe("undoOperations — cross-session annotation", () => {
  it("prefixes message with [cross-session] for different session", async () => {
    const entry = createMockUndoEntry({
      session_id: "other-session",
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "tx-1" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "tx-1" });

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].message).toMatch(/^\[cross-session\] /);
  });

  it("no prefix for same session", async () => {
    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "tx-1" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "tx-1" });

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].message).not.toMatch(/^\[cross-session\]/);
  });
});

describe("undoOperations — error handling", () => {
  it("returns error status when applyUndo throws an Error", async () => {
    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "tx-1" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "tx-1" });
    mockClient.deleteTransaction.mockRejectedValue(new Error("API down"));

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("API down");
  });

  it("returns generic message when applyUndo throws a non-Error", async () => {
    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "tx-1" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "tx-1" });
    mockClient.deleteTransaction.mockRejectedValue("string error");

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain(
      "Failed to apply undo operation.",
    );
  });
});

describe("undoOperations — summary and markEntriesUndone", () => {
  it("produces correct summary with mixed results", async () => {
    const undoneEntry = createMockUndoEntry({
      id: "budget-1::1::undone",
      session_id: engine.getSessionId(),
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {},
      },
    });
    const conflictEntry = createMockUndoEntry({
      id: "budget-1::2::conflict",
      session_id: engine.getSessionId(),
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-2",
        expected_state: { id: "tx-2", amount: 1000 },
        restore_state: {
          id: "tx-2",
          amount: 500,
          account_id: "a",
          date: "2024-01-01",
        },
      },
    });
    const skippedEntry = createMockUndoEntry({
      id: "budget-1::3::skipped",
      status: "undone",
    });

    mockStore.getEntriesByIds.mockResolvedValue([
      undoneEntry,
      conflictEntry,
      skippedEntry,
    ]);

    // tx-1: exists, matches → undone
    mockClient.getTransactionById
      .mockResolvedValueOnce({ id: "tx-1" })
      .mockResolvedValueOnce({ id: "tx-2", amount: 9999 });
    mockClient.snapshotTransaction
      .mockReturnValueOnce({ id: "tx-1" })
      .mockReturnValueOnce({ id: "tx-2", amount: 9999 });

    const result = await engine.undoOperations(
      ["budget-1::1::undone", "budget-1::2::conflict", "budget-1::3::skipped"],
      false,
    );

    expect(result.summary).toEqual({
      undone: 1,
      conflicts: 1,
      skipped: 1,
      errors: 0,
    });
  });

  it("only passes undone IDs to markEntriesUndone", async () => {
    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "tx-1" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "tx-1" });

    await engine.undoOperations([entry.id], false);

    expect(mockStore.markEntriesUndone).toHaveBeenCalledWith("budget-1", [
      entry.id,
    ]);
  });

  it("does not call markEntriesUndone when nothing was undone", async () => {
    mockStore.getEntriesByIds.mockResolvedValue([undefined]);

    await engine.undoOperations(["budget-1::1::notfound"], false);

    expect(mockStore.markEntriesUndone).not.toHaveBeenCalled();
  });
});

describe("undoOperations — ID resolution", () => {
  it("uses resolveMappedId before API calls", async () => {
    mockStore.resolveMappedId.mockResolvedValue("resolved-tx-id");

    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "original-tx-id",
        expected_state: { id: "original-tx-id" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "resolved-tx-id" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "original-tx-id" });

    await engine.undoOperations([entry.id], false);

    expect(mockStore.resolveMappedId).toHaveBeenCalledWith(
      "budget-1",
      "original-tx-id",
    );
    expect(mockClient.getTransactionById).toHaveBeenCalledWith(
      "budget-1",
      "resolved-tx-id",
    );
    expect(mockClient.deleteTransaction).toHaveBeenCalledWith(
      "budget-1",
      "resolved-tx-id",
    );
  });
});

describe("type coercion (tested indirectly)", () => {
  it("asRequiredString throws for null restore_state field", async () => {
    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "create",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: {},
        restore_state: {
          account_id: null, // should throw
          date: "2024-01-01",
          amount: 5000,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue(null);

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("string value");
  });

  it("asNumber throws for non-numeric strings", async () => {
    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {
          amount: "not-a-number",
          account_id: "acc-1",
          date: "2024-01-01",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "tx-1" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "tx-1" });

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("numeric");
  });

  it("asNumber accepts numeric strings", async () => {
    const entry = createMockUndoEntry({
      session_id: engine.getSessionId(),
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {
          amount: "3000",
          account_id: "acc-1",
          date: "2024-01-01",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({ id: "tx-1" });
    mockClient.snapshotTransaction.mockReturnValue({ id: "tx-1" });

    const result = await engine.undoOperations([entry.id], false);

    expect(result.results[0].status).toBe("undone");
    expect(mockClient.updateTransactions).toHaveBeenCalledWith("budget-1", [
      expect.objectContaining({ amount: 3 }),
    ]);
  });
});
