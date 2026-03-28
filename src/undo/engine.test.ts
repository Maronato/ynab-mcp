import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockUndoEntry } from "../test-utils.js";
import { snapshotTransaction } from "../ynab/format.js";
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
    replaceTransaction: vi
      .fn()
      .mockResolvedValue({ transaction: { id: "new-tx-1" }, previousId: "" }),
    deleteScheduledTransaction: vi.fn().mockResolvedValue(null),
    updateScheduledTransaction: vi.fn().mockResolvedValue({}),
    createScheduledTransaction: vi.fn().mockResolvedValue({ id: "new-stx-1" }),
    setCategoryBudget: vi.fn().mockResolvedValue({}),
  };
}

let mockStore: ReturnType<typeof createMockStore>;
let mockClient: ReturnType<typeof createMockClient>;
let engine: UndoEngine;
const CURRENT_SESSION_ID = "session-1";
const OTHER_SESSION_ID = "other-session";

beforeEach(() => {
  mockStore = createMockStore();
  mockClient = createMockClient();
  engine = new UndoEngine(mockClient as never, mockStore as never);
});

describe("recordEntries", () => {
  it("creates entries with correct format and calls store.appendEntries", async () => {
    const result = await engine.recordEntries(
      "budget-1",
      [
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
      ],
      CURRENT_SESSION_ID,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toMatch(/^budget-1::\d+::.+$/);
    expect(result[0].session_id).toBe(CURRENT_SESSION_ID);
    expect(result[0].status).toBe("active");
    expect(result[0].budget_id).toBe("budget-1");
    expect(mockStore.appendEntries).toHaveBeenCalledOnce();
  });

  it("returns early when no entries are provided", async () => {
    const result = await engine.recordEntries(
      "budget-1",
      [],
      CURRENT_SESSION_ID,
    );

    expect(result).toEqual([]);
    expect(mockStore.appendEntries).not.toHaveBeenCalled();
  });
});

describe("listHistory", () => {
  it("delegates to store.listEntries with correct params", async () => {
    await engine.listHistory("budget-1", CURRENT_SESSION_ID, 10, true);

    expect(mockStore.listEntries).toHaveBeenCalledWith("budget-1", {
      sessionId: CURRENT_SESSION_ID,
      limit: 10,
      includeUndone: true,
      includeAllSessions: false,
    });
  });

  it("can include entries from all sessions", async () => {
    await engine.listHistory("budget-1", CURRENT_SESSION_ID, 10, true, true);

    expect(mockStore.listEntries).toHaveBeenCalledWith("budget-1", {
      sessionId: CURRENT_SESSION_ID,
      limit: 10,
      includeUndone: true,
      includeAllSessions: true,
    });
  });
});

describe("undoOperations — entry resolution", () => {
  it("returns an error for entry IDs that cannot be parsed", async () => {
    const result = await engine.undoOperations(
      ["invalid-id"],
      CURRENT_SESSION_ID,
      false,
    );

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

    const result = await engine.undoOperations(
      ["budget-1::123::abc"],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("not found");
  });

  it("returns skipped status for already-undone entries", async () => {
    const undoneEntry = createMockUndoEntry({ status: "undone" });
    mockStore.getEntriesByIds.mockResolvedValue([undoneEntry]);

    const result = await engine.undoOperations(
      [undoneEntry.id],
      CURRENT_SESSION_ID,
      false,
    );

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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      true,
    );

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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

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

describe("undoOperations — split transaction undo", () => {
  it("re-creates a deleted split transaction with subtransactions", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "create",
        entity_type: "transaction",
        entity_id: "tx-split",
        expected_state: {},
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 50000,
          payee_id: "payee-1",
          category_id: "split-cat-id",
          memo: "Split purchase",
          cleared: "cleared",
          approved: true,
          flag_color: null,
          subtransactions: [
            { amount: 30000, category_id: "cat-1", payee_id: null, memo: null },
            {
              amount: 20000,
              category_id: "cat-2",
              payee_id: null,
              memo: "sub memo",
            },
          ],
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue(null);
    mockClient.createTransactions.mockResolvedValue([{ id: "tx-new" }]);

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

    expect(mockClient.createTransactions).toHaveBeenCalledWith("budget-1", [
      expect.objectContaining({
        account_id: "acc-1",
        amount: 50,
        category_id: undefined,
        subtransactions: [
          { amount: 30, category_id: "cat-1", payee_id: null, memo: null },
          {
            amount: 20,
            category_id: "cat-2",
            payee_id: null,
            memo: "sub memo",
          },
        ],
      }),
    ]);
  });

  it("reverts a split back to non-split via replaceTransaction", async () => {
    // Faithfully models the production replace flow:
    // - entity_id is the ORIGINAL transaction ID ("tx-original")
    // - expected_state.id is the REPLACED transaction ID ("tx-replaced")
    //   because snapshotTransaction(after) captures the new ID
    // - ID mapping: "tx-original" -> "tx-replaced"
    // The undo engine must handle the ID mismatch between
    // expected_state.id and entity_id during conflict detection.
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-original",
        expected_state: {
          id: "tx-replaced",
          amount: 50000,
          category_id: "split-cat-id",
          subtransactions: [
            { amount: 30000, category_id: "cat-1", payee_id: null, memo: null },
            { amount: 20000, category_id: "cat-2", payee_id: null, memo: null },
          ],
        },
        restore_state: {
          id: "tx-original",
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 50000,
          category_id: "cat-1",
          memo: "Before split",
          cleared: "cleared",
          approved: true,
          flag_color: null,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockStore.resolveMappedId.mockResolvedValue("tx-replaced");
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-replaced",
      amount: 50000,
      category_id: "split-cat-id",
      subtransactions: [
        { amount: 30000, category_id: "cat-1" },
        { amount: 20000, category_id: "cat-2" },
      ],
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-replaced",
      amount: 50000,
      category_id: "split-cat-id",
      subtransactions: [
        { amount: 30000, category_id: "cat-1", payee_id: null, memo: null },
        { amount: 20000, category_id: "cat-2", payee_id: null, memo: null },
      ],
    });
    mockClient.replaceTransaction.mockResolvedValue({
      transaction: { id: "tx-recreated" },
      previousId: "tx-replaced",
    });

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("undone");
    expect(result.results[0].message).toContain("replace");
    expect(mockClient.replaceTransaction).toHaveBeenCalledWith(
      "budget-1",
      "tx-replaced",
      expect.objectContaining({
        account_id: "acc-1",
        amount: 50,
        category_id: "cat-1",
        memo: "Before split",
      }),
    );
    const replacement = mockClient.replaceTransaction.mock.calls[0][2];
    expect(replacement.subtransactions).toBeUndefined();
    expect(mockStore.updateIdMappings).toHaveBeenCalledWith(
      "budget-1",
      "tx-original",
      "tx-recreated",
    );
  });

  it("reverts a split to a different split via replaceTransaction", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-original",
        expected_state: {
          id: "tx-after-replace",
          amount: 50000,
          subtransactions: [
            {
              amount: 30000,
              category_id: "cat-new",
              payee_id: null,
              memo: null,
            },
          ],
        },
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 50000,
          category_id: "split-cat",
          cleared: "cleared",
          approved: true,
          subtransactions: [
            {
              amount: 20000,
              category_id: "cat-old-1",
              payee_id: null,
              memo: null,
            },
            {
              amount: 30000,
              category_id: "cat-old-2",
              payee_id: null,
              memo: null,
            },
          ],
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockStore.resolveMappedId.mockResolvedValue("tx-after-replace");
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-after-replace",
      amount: 50000,
      subtransactions: [{ amount: 30000, category_id: "cat-new" }],
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-after-replace",
      amount: 50000,
      subtransactions: [
        { amount: 30000, category_id: "cat-new", payee_id: null, memo: null },
      ],
    });
    mockClient.replaceTransaction.mockResolvedValue({
      transaction: { id: "tx-restored" },
      previousId: "tx-after-replace",
    });

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("undone");
    expect(mockClient.replaceTransaction).toHaveBeenCalled();
    const replacement = mockClient.replaceTransaction.mock.calls[0][2];
    expect(replacement.subtransactions).toHaveLength(2);
    expect(replacement.category_id).toBeUndefined();
  });

  it("does not false-conflict when API returns subtransactions in different order", async () => {
    // Simulate real production flow: the expected_state was created by
    // snapshotTransaction at record time (order: cat-a, cat-b from the API).
    // At undo time, the API returns the same subtransactions in a different
    // order (cat-b, cat-a). The real snapshotTransaction sorts them, so
    // both snapshots should be identical despite the API ordering difference.
    const apiResponseAtRecordTime = {
      id: "tx-split",
      account_id: "acc-1",
      date: "2024-01-01",
      amount: -80000,
      category_id: "split-cat",
      memo: null,
      cleared: "cleared" as const,
      approved: true,
      flag_color: null,
      subtransactions: [
        {
          amount: -50000,
          category_id: "cat-a",
          payee_id: null,
          memo: null,
          deleted: false,
        },
        {
          amount: -30000,
          category_id: "cat-b",
          payee_id: null,
          memo: null,
          deleted: false,
        },
      ],
    };
    const expectedState = snapshotTransaction(apiResponseAtRecordTime);

    const apiResponseAtUndoTime = {
      ...apiResponseAtRecordTime,
      subtransactions: [
        {
          amount: -30000,
          category_id: "cat-b",
          payee_id: null,
          memo: null,
          deleted: false,
        },
        {
          amount: -50000,
          category_id: "cat-a",
          payee_id: null,
          memo: null,
          deleted: false,
        },
      ],
    };

    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-split",
        expected_state: expectedState,
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: -80000,
          category_id: "cat-single",
          cleared: "cleared",
          approved: true,
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue(apiResponseAtUndoTime);
    mockClient.snapshotTransaction.mockImplementation((tx) =>
      snapshotTransaction(tx as Parameters<typeof snapshotTransaction>[0]),
    );
    mockClient.replaceTransaction.mockResolvedValue({
      transaction: { id: "tx-restored" },
      previousId: "tx-split",
    });

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("undone");
    expect(result.summary.conflicts).toBe(0);
  });

  it("uses replaceTransaction even when only non-frozen fields differ on a split", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-split",
        expected_state: {
          id: "tx-split",
          amount: 50000,
          memo: "New memo",
          subtransactions: [
            { amount: 50000, category_id: "cat-1", payee_id: null, memo: null },
          ],
        },
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 50000,
          memo: "Old memo",
          cleared: "cleared",
          approved: true,
          subtransactions: [
            { amount: 50000, category_id: "cat-1", payee_id: null, memo: null },
          ],
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-split",
      amount: 50000,
      memo: "New memo",
      subtransactions: [{ amount: 50000, category_id: "cat-1" }],
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-split",
      amount: 50000,
      memo: "New memo",
      subtransactions: [
        { amount: 50000, category_id: "cat-1", payee_id: null, memo: null },
      ],
    });
    mockClient.replaceTransaction.mockResolvedValue({
      transaction: { id: "tx-replaced" },
      previousId: "tx-split",
    });

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

    expect(mockClient.replaceTransaction).toHaveBeenCalled();
    expect(mockClient.updateTransactions).not.toHaveBeenCalled();
  });

  it("uses regular updateTransactions for non-split undo", async () => {
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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

    expect(mockClient.updateTransactions).toHaveBeenCalled();
    expect(mockClient.replaceTransaction).not.toHaveBeenCalled();
  });

  it("includes subtransactions when restoring a non-split to split via regular update", async () => {
    // After an un-split (split -> non-split), undoing should restore the split.
    // The current transaction is non-split (expected_state has no subtransactions),
    // so the undo takes the regular update path. The restore_state has
    // subtransactions, which must be passed through to the API so it converts
    // the non-split back into a split.
    const entry = createMockUndoEntry({
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-unsplit",
        expected_state: {
          id: "tx-unsplit",
          amount: 80000,
          category_id: "cat-groceries",
        },
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 80000,
          category_id: "split-cat",
          cleared: "cleared",
          approved: true,
          subtransactions: [
            {
              amount: 50000,
              category_id: "cat-groceries",
              payee_id: null,
              memo: "groceries",
            },
            {
              amount: 30000,
              category_id: "cat-entertainment",
              payee_id: null,
              memo: "entertainment",
            },
          ],
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-unsplit",
      amount: 80000,
      category_id: "cat-groceries",
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-unsplit",
      amount: 80000,
      category_id: "cat-groceries",
    });

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

    expect(mockClient.updateTransactions).toHaveBeenCalled();
    expect(mockClient.replaceTransaction).not.toHaveBeenCalled();

    const updateCall = mockClient.updateTransactions.mock.calls[0][1][0];
    expect(updateCall.subtransactions).toBeDefined();
    expect(updateCall.subtransactions).toHaveLength(2);
    expect(updateCall.subtransactions[0]).toEqual({
      amount: 50,
      category_id: "cat-groceries",
      payee_id: null,
      memo: "groceries",
    });
  });

  it("does not include subtransactions when restoring a non-split transaction", async () => {
    const entry = createMockUndoEntry({
      undo_action: {
        type: "create",
        entity_type: "transaction",
        entity_id: "tx-simple",
        expected_state: {},
        restore_state: {
          account_id: "acc-1",
          date: "2024-01-01",
          amount: 5000,
          category_id: "cat-1",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockResolvedValue(null);
    mockClient.createTransactions.mockResolvedValue([{ id: "tx-new" }]);

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

    const createCall = mockClient.createTransactions.mock.calls[0][1][0];
    expect(createCall.subtransactions).toBeUndefined();
    expect(createCall.category_id).toBe("cat-1");
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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

    expect(mockClient.setCategoryBudget).toHaveBeenCalledWith("budget-1", {
      category_id: "cat-1",
      month: "2024-01-01",
      budgeted: 50, // 50000 / 1000
    });
  });
});

describe("undoOperations — cross-session behavior", () => {
  it("returns conflict for a different session when force is false", async () => {
    const entry = createMockUndoEntry({
      session_id: OTHER_SESSION_ID,
      undo_action: {
        type: "delete",
        entity_type: "transaction",
        entity_id: "tx-1",
        expected_state: { id: "tx-1" },
        restore_state: {},
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("conflict");
    expect(result.results[0].message).toContain("belongs to session");
    expect(mockClient.deleteTransaction).not.toHaveBeenCalled();
  });

  it("no prefix for same session", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].message).not.toMatch(/^\[cross-session\]/);
  });

  it("prefixes message with [cross-session] when force=true", async () => {
    const entry = createMockUndoEntry({
      session_id: OTHER_SESSION_ID,
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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      true,
    );

    expect(result.results[0].message).toMatch(/^\[cross-session\] /);
  });
});

describe("undoOperations — error handling", () => {
  it("returns error status when applyUndo throws an Error", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("API down");
  });

  it("extracts message from non-Error thrown values", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("string error");
  });

  it("extracts detail from YNAB-style error objects", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
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
    mockClient.deleteTransaction.mockRejectedValue({
      error: { id: "409", name: "conflict", detail: "Resource conflict" },
    });

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("Resource conflict");
  });

  it("returns error status when resolveMappedId throws", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockStore.resolveMappedId.mockRejectedValue(new Error("Store read failed"));

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("Store read failed");
  });

  it("returns error status when getCurrentState throws", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockClient.getTransactionById.mockRejectedValue(
      new Error("API unreachable"),
    );

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("API unreachable");
  });
});

describe("undoOperations — ID normalization after re-creation", () => {
  it("does not conflict when entity ID changed via mapping", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "tx-original",
        expected_state: { id: "tx-original", amount: 5000 },
        restore_state: {
          id: "tx-original",
          amount: 3000,
          account_id: "acc-1",
          date: "2024-01-01",
        },
      },
    });
    mockStore.getEntriesByIds.mockResolvedValue([entry]);
    mockStore.resolveMappedId.mockResolvedValue("tx-remapped");
    mockClient.getTransactionById.mockResolvedValue({
      id: "tx-remapped",
      amount: 5000,
    });
    mockClient.snapshotTransaction.mockReturnValue({
      id: "tx-remapped",
      amount: 5000,
    });

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("undone");
    expect(mockClient.updateTransactions).toHaveBeenCalledWith(
      "budget-1",
      expect.arrayContaining([
        expect.objectContaining({ transaction_id: "tx-remapped" }),
      ]),
    );
  });
});

describe("undoOperations — summary and markEntriesUndone", () => {
  it("produces correct summary with mixed results", async () => {
    const undoneEntry = createMockUndoEntry({
      id: "budget-1::1::undone",
      session_id: CURRENT_SESSION_ID,
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
      session_id: CURRENT_SESSION_ID,
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
      CURRENT_SESSION_ID,
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
      session_id: CURRENT_SESSION_ID,
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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

    expect(mockStore.markEntriesUndone).toHaveBeenCalledWith("budget-1", [
      entry.id,
    ]);
  });

  it("does not call markEntriesUndone when nothing was undone", async () => {
    mockStore.getEntriesByIds.mockResolvedValue([undefined]);

    await engine.undoOperations(
      ["budget-1::1::notfound"],
      CURRENT_SESSION_ID,
      false,
    );

    expect(mockStore.markEntriesUndone).not.toHaveBeenCalled();
  });
});

describe("undoOperations — ID resolution", () => {
  it("uses resolveMappedId before API calls", async () => {
    mockStore.resolveMappedId.mockResolvedValue("resolved-tx-id");

    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
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

    await engine.undoOperations([entry.id], CURRENT_SESSION_ID, false);

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
      session_id: CURRENT_SESSION_ID,
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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("string value");
  });

  it("asNumber throws for non-numeric strings", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("numeric");
  });

  it("asNumber accepts numeric strings", async () => {
    const entry = createMockUndoEntry({
      session_id: CURRENT_SESSION_ID,
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

    const result = await engine.undoOperations(
      [entry.id],
      CURRENT_SESSION_ID,
      false,
    );

    expect(result.results[0].status).toBe("undone");
    expect(mockClient.updateTransactions).toHaveBeenCalledWith("budget-1", [
      expect.objectContaining({ amount: 3 }),
    ]);
  });
});
