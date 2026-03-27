import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { snapshotTransaction } from "../ynab/format.js";
import { UndoEngine } from "./engine.js";
import { UndoStore } from "./store.js";

/**
 * Mock YNAB client that uses the real snapshotTransaction implementation
 * so that snapshots behave identically to production (including the `id`
 * field that changes when a transaction is re-created).
 */
function createMockClient() {
  return {
    getTransactionById: vi.fn(),
    getScheduledTransactionById: vi.fn(),
    getMonthCategoryById: vi.fn(),
    snapshotTransaction: vi.fn(
      (tx: Parameters<typeof snapshotTransaction>[0]) =>
        snapshotTransaction(tx),
    ),
    snapshotScheduledTransaction: vi.fn(),
    deleteTransaction: vi.fn().mockResolvedValue(null),
    updateTransactions: vi.fn().mockResolvedValue([]),
    createTransactions: vi.fn().mockResolvedValue([]),
    deleteScheduledTransaction: vi.fn().mockResolvedValue(null),
    updateScheduledTransaction: vi.fn().mockResolvedValue({}),
    createScheduledTransaction: vi.fn().mockResolvedValue({ id: "new" }),
    setCategoryBudget: vi.fn().mockResolvedValue({}),
  };
}

describe("lifecycle: create → update → delete → undo delete → undo update → undo create", () => {
  const budgetId = "budget-lifecycle";
  const recreatedId = "tx-recreated-xyz789";

  let tempDir: string;
  let store: UndoStore;
  let mockClient: ReturnType<typeof createMockClient>;
  let engine: UndoEngine;

  const afterCreate = {
    id: "tx-original",
    account_id: "acc-1",
    date: "2024-06-15",
    amount: -50000,
    payee_id: "payee-1",
    category_id: "cat-1",
    memo: "Coffee shop",
    cleared: "uncleared" as const,
    approved: true,
    flag_color: null as string | null,
  };

  const afterUpdate = {
    ...afterCreate,
    amount: -75000,
    memo: "Coffee + pastry",
    category_id: "cat-2",
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ynab-undo-lifecycle-"));
    store = new UndoStore(tempDir);
    mockClient = createMockClient();
    engine = new UndoEngine(mockClient as never, store);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("full undo chain works through ID remapping after re-creation", async () => {
    // ----- Record the three operations -----

    const [createEntry] = await engine.recordEntries(budgetId, [
      {
        operation: "create_transaction",
        description: "Created transaction.",
        undo_action: {
          type: "delete",
          entity_type: "transaction",
          entity_id: "tx-original",
          expected_state: snapshotTransaction(afterCreate),
          restore_state: {},
        },
      },
    ]);

    const [updateEntry] = await engine.recordEntries(budgetId, [
      {
        operation: "update_transaction",
        description: "Updated transaction.",
        undo_action: {
          type: "update",
          entity_type: "transaction",
          entity_id: "tx-original",
          expected_state: snapshotTransaction(afterUpdate),
          restore_state: snapshotTransaction(afterCreate),
        },
      },
    ]);

    const [deleteEntry] = await engine.recordEntries(budgetId, [
      {
        operation: "delete_transaction",
        description: "Deleted transaction.",
        undo_action: {
          type: "create",
          entity_type: "transaction",
          entity_id: "tx-original",
          expected_state: {},
          restore_state: snapshotTransaction(afterUpdate),
        },
      },
    ]);

    // Verify all three entries are stored and active
    const historyBefore = await engine.listHistory(budgetId, "current", 10);
    expect(historyBefore).toHaveLength(3);
    expect(historyBefore.every((e) => e.status === "active")).toBe(true);

    // ----- Undo Step 1: Undo the DELETE (re-creates the transaction) -----
    //
    // YNAB quirk: the re-created transaction gets a brand-new ID.
    // The engine must store an ID mapping so subsequent undos can find it.

    mockClient.getTransactionById.mockResolvedValueOnce(null);
    mockClient.createTransactions.mockResolvedValueOnce([{ id: recreatedId }]);

    const undoDelete = await engine.undoOperations([deleteEntry.id], false);

    expect(undoDelete.results[0].status).toBe("undone");
    expect(undoDelete.results[0].message).toContain("Re-created");
    expect(undoDelete.summary).toMatchObject({ undone: 1, errors: 0 });

    // Verify the restore payload (amounts converted from milliunits to currency)
    expect(mockClient.createTransactions).toHaveBeenCalledWith(budgetId, [
      expect.objectContaining({
        account_id: "acc-1",
        date: "2024-06-15",
        amount: -75,
        payee_id: "payee-1",
        category_id: "cat-2",
        memo: "Coffee + pastry",
      }),
    ]);

    // Verify the ID mapping was persisted in the real store
    const resolvedAfterDelete = await store.resolveMappedId(
      budgetId,
      "tx-original",
    );
    expect(resolvedAfterDelete).toBe(recreatedId);

    // ----- Undo Step 2: Undo the UPDATE (restores pre-update values) -----
    //
    // The engine must:
    //   1. Resolve "tx-original" → recreatedId through the mapping
    //   2. Fetch the current state at the new ID
    //   3. Normalize the ID in the snapshot so conflict detection passes
    //   4. Update the transaction at the new ID with the original values

    mockClient.getTransactionById.mockResolvedValueOnce({
      ...afterUpdate,
      id: recreatedId,
    });

    const undoUpdate = await engine.undoOperations([updateEntry.id], false);

    expect(undoUpdate.results[0].status).toBe("undone");
    expect(undoUpdate.results[0].message).toContain("Updated transaction");

    // Verify the engine fetched by the remapped ID
    expect(mockClient.getTransactionById).toHaveBeenLastCalledWith(
      budgetId,
      recreatedId,
    );

    // Verify the update was applied to the remapped ID with the original values
    expect(mockClient.updateTransactions).toHaveBeenCalledWith(budgetId, [
      expect.objectContaining({
        transaction_id: recreatedId,
        account_id: "acc-1",
        date: "2024-06-15",
        amount: -50,
        payee_id: "payee-1",
        category_id: "cat-1",
        memo: "Coffee shop",
        cleared: "uncleared",
        approved: true,
        flag_color: null,
      }),
    ]);

    // ----- Undo Step 3: Undo the CREATE (deletes the transaction) -----
    //
    // After the previous undo restored the original values, the transaction
    // at recreatedId should match the "after create" snapshot. The engine must
    // resolve the mapping and delete by the new ID.

    mockClient.getTransactionById.mockResolvedValueOnce({
      ...afterCreate,
      id: recreatedId,
    });

    const undoCreate = await engine.undoOperations([createEntry.id], false);

    expect(undoCreate.results[0].status).toBe("undone");
    expect(undoCreate.results[0].message).toContain("Deleted transaction");

    expect(mockClient.deleteTransaction).toHaveBeenCalledWith(
      budgetId,
      recreatedId,
    );

    // ----- Verify final state -----

    const historyAfter = await engine.listHistory(
      budgetId,
      "current",
      10,
      true,
    );
    expect(historyAfter).toHaveLength(3);
    expect(historyAfter.every((e) => e.status === "undone")).toBe(true);
  });

  it("undo chain detects real conflicts when entity content changed externally", async () => {
    const [, updateEntry] = await Promise.all([
      engine.recordEntries(budgetId, [
        {
          operation: "create_transaction",
          description: "Created.",
          undo_action: {
            type: "delete",
            entity_type: "transaction",
            entity_id: "tx-original",
            expected_state: snapshotTransaction(afterCreate),
            restore_state: {},
          },
        },
      ]),
      engine.recordEntries(budgetId, [
        {
          operation: "update_transaction",
          description: "Updated.",
          undo_action: {
            type: "update",
            entity_type: "transaction",
            entity_id: "tx-original",
            expected_state: snapshotTransaction(afterUpdate),
            restore_state: snapshotTransaction(afterCreate),
          },
        },
      ]),
    ]);

    // The transaction still exists at the original ID but its amount was
    // changed externally (e.g., by the user in the YNAB app).
    mockClient.getTransactionById.mockResolvedValueOnce({
      ...afterUpdate,
      amount: -99000,
    });

    const result = await engine.undoOperations([updateEntry[0].id], false);

    expect(result.results[0].status).toBe("conflict");
    expect(result.results[0].message).toContain("force=true");
    expect(result.results[0].conflict).toBeDefined();
    expect(result.results[0].conflict?.current_state).toMatchObject({
      amount: -99000,
    });
  });

  it("undo chain skips already-undone entries", async () => {
    const [deleteEntry] = await engine.recordEntries(budgetId, [
      {
        operation: "delete_transaction",
        description: "Deleted.",
        undo_action: {
          type: "create",
          entity_type: "transaction",
          entity_id: "tx-original",
          expected_state: {},
          restore_state: snapshotTransaction(afterUpdate),
        },
      },
    ]);

    // Undo once
    mockClient.getTransactionById.mockResolvedValueOnce(null);
    mockClient.createTransactions.mockResolvedValueOnce([{ id: recreatedId }]);
    await engine.undoOperations([deleteEntry.id], false);

    // Attempt to undo the same entry again
    const result = await engine.undoOperations([deleteEntry.id], false);

    expect(result.results[0].status).toBe("skipped");
    expect(result.results[0].message).toContain("already undone");
  });
});
