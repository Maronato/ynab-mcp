import { randomUUID } from "node:crypto";
import { matchesExpectedState } from "../shared/object.js";
import type { YnabClient } from "../ynab/client.js";
import { extractErrorMessage } from "../ynab/errors.js";
import { milliunitsToCurrency } from "../ynab/format.js";
import type { UndoStore } from "./store.js";
import type {
  UndoConflict,
  UndoEntry,
  UndoExecutionResult,
  UndoOperationType,
  UndoSessionScope,
} from "./types.js";

interface RecordUndoEntryInput {
  operation: UndoOperationType;
  description: string;
  undo_action: UndoEntry["undo_action"];
}

interface UndoResult {
  results: UndoExecutionResult[];
  summary: {
    undone: number;
    conflicts: number;
    skipped: number;
    errors: number;
  };
}

export class UndoEngine {
  private readonly sessionId: string;

  constructor(
    private readonly client: YnabClient,
    private readonly store: UndoStore,
  ) {
    this.sessionId = randomUUID();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  async recordEntries(
    budgetId: string,
    entries: RecordUndoEntryInput[],
  ): Promise<UndoEntry[]> {
    const timestamp = new Date().toISOString();
    const createdEntries: UndoEntry[] = entries.map((entry) => ({
      id: `${budgetId}::${Date.now()}::${randomUUID().slice(0, 8)}`,
      session_id: this.sessionId,
      budget_id: budgetId,
      timestamp,
      operation: entry.operation,
      description: entry.description,
      undo_action: entry.undo_action,
      status: "active",
    }));

    await this.store.appendEntries(budgetId, createdEntries);
    return createdEntries;
  }

  async listHistory(
    budgetId: string,
    sessionScope: UndoSessionScope,
    limit: number,
    includeUndone = false,
  ): Promise<UndoEntry[]> {
    return this.store.listEntries(budgetId, {
      sessionScope,
      sessionId: this.sessionId,
      limit,
      includeUndone,
    });
  }

  async undoOperations(
    entryIds: string[],
    force: boolean,
  ): Promise<UndoResult> {
    const groupedByBudget = new Map<
      string,
      Array<{ entryId: string; index: number }>
    >();
    const indexedResults: Array<{
      index: number;
      result: UndoExecutionResult;
    }> = [];

    for (const [index, entryId] of entryIds.entries()) {
      const budgetId = this.extractBudgetId(entryId);
      if (!budgetId) {
        indexedResults.push({
          index,
          result: {
            entry_id: entryId,
            status: "error",
            message:
              "Invalid undo entry ID. Expected format '<budget_id>::<timestamp>::<suffix>'.",
          },
        });
        continue;
      }

      const existing = groupedByBudget.get(budgetId) ?? [];
      existing.push({ entryId, index });
      groupedByBudget.set(budgetId, existing);
    }

    for (const [budgetId, groupedEntries] of groupedByBudget.entries()) {
      const entries = await this.store.getEntriesByIds(
        budgetId,
        groupedEntries.map(({ entryId }) => entryId),
      );
      const successfullyUndone: string[] = [];

      for (let index = 0; index < groupedEntries.length; index += 1) {
        const { entryId, index: originalIndex } = groupedEntries[index];
        const entry = entries[index];

        if (!entry) {
          indexedResults.push({
            index: originalIndex,
            result: {
              entry_id: entryId,
              status: "error",
              message: "Undo entry not found.",
            },
          });
          continue;
        }

        if (entry.status !== "active") {
          indexedResults.push({
            index: originalIndex,
            result: {
              entry_id: entry.id,
              status: "skipped",
              message: "Undo entry is already undone.",
            },
          });
          continue;
        }

        const execution = await this.undoSingleEntry(entry, force);
        indexedResults.push({
          index: originalIndex,
          result: execution,
        });

        if (execution.status === "undone") {
          successfullyUndone.push(entry.id);
        }
      }

      if (successfullyUndone.length > 0) {
        await this.store.markEntriesUndone(budgetId, successfullyUndone);
      }
    }

    const results = indexedResults
      .sort((left, right) => left.index - right.index)
      .map(({ result }) => result);

    const summary = {
      undone: results.filter((result) => result.status === "undone").length,
      conflicts: results.filter((result) => result.status === "conflict")
        .length,
      skipped: results.filter((result) => result.status === "skipped").length,
      errors: results.filter((result) => result.status === "error").length,
    };

    return {
      results,
      summary,
    };
  }

  private extractBudgetId(entryId: string): string | null {
    const firstSeparatorIndex = entryId.indexOf("::");
    if (firstSeparatorIndex <= 0) {
      return null;
    }

    const secondSeparatorIndex = entryId.indexOf("::", firstSeparatorIndex + 2);
    if (
      secondSeparatorIndex <= firstSeparatorIndex + 2 ||
      secondSeparatorIndex + 2 >= entryId.length
    ) {
      return null;
    }

    return entryId.slice(0, firstSeparatorIndex);
  }

  private async undoSingleEntry(
    entry: UndoEntry,
    force: boolean,
  ): Promise<UndoExecutionResult> {
    const fromDifferentSession = entry.session_id !== this.sessionId;
    const sessionPrefix = fromDifferentSession ? "[cross-session] " : "";

    try {
      const resolvedEntityId = await this.store.resolveMappedId(
        entry.budget_id,
        entry.undo_action.entity_id,
      );

      const currentState = await this.getCurrentState(entry, resolvedEntityId);

      // When an entity was re-created with a new ID (after undoing a delete),
      // the snapshot's `id` won't match the original in expected_state.
      // Normalize so conflict detection compares content, not generated IDs.
      if (
        currentState &&
        resolvedEntityId !== entry.undo_action.entity_id &&
        "id" in currentState
      ) {
        currentState.id = entry.undo_action.entity_id;
      }

      const conflict = this.detectConflict(entry, currentState);

      if (conflict && !force) {
        return {
          entry_id: entry.id,
          status: "conflict",
          message: `${sessionPrefix}${conflict.reason}`,
          conflict,
        };
      }

      const message = await this.applyUndo(entry, resolvedEntityId);
      return {
        entry_id: entry.id,
        status: "undone",
        message: `${sessionPrefix}${message}`,
      };
    } catch (error) {
      return {
        entry_id: entry.id,
        status: "error",
        message: `${sessionPrefix}${extractErrorMessage(error, "Failed to apply undo operation.")}`,
      };
    }
  }

  private detectConflict(
    entry: UndoEntry,
    currentState: Record<string, unknown> | null,
  ): UndoConflict | null {
    const expectedState = entry.undo_action.expected_state;

    if (entry.undo_action.type === "create") {
      if (currentState) {
        return {
          entry_id: entry.id,
          reason:
            "Entity currently exists, but undo expects it to be absent before recreation.",
          expected_state: expectedState,
          current_state: currentState,
          restore_state: entry.undo_action.restore_state,
        };
      }

      return null;
    }

    if (!currentState) {
      return {
        entry_id: entry.id,
        reason: "Entity no longer exists.",
        expected_state: expectedState,
        current_state: null,
        restore_state: entry.undo_action.restore_state,
      };
    }

    if (
      !matchesExpectedState(
        expectedState,
        currentState as Record<string, unknown>,
      )
    ) {
      return {
        entry_id: entry.id,
        reason:
          "Entity has changed since the operation was recorded. Use force=true to apply anyway.",
        expected_state: expectedState,
        current_state: currentState,
        restore_state: entry.undo_action.restore_state,
      };
    }

    return null;
  }

  private async applyUndo(
    entry: UndoEntry,
    resolvedEntityId: string,
  ): Promise<string> {
    if (entry.undo_action.entity_type === "transaction") {
      return this.applyTransactionUndo(entry, resolvedEntityId);
    }

    if (entry.undo_action.entity_type === "scheduled_transaction") {
      return this.applyScheduledTransactionUndo(entry, resolvedEntityId);
    }

    return this.applyCategoryBudgetUndo(entry);
  }

  private async applyTransactionUndo(
    entry: UndoEntry,
    resolvedEntityId: string,
  ): Promise<string> {
    const restore = entry.undo_action.restore_state;

    if (entry.undo_action.type === "delete") {
      await this.client.deleteTransaction(entry.budget_id, resolvedEntityId);
      return "Deleted transaction as undo action.";
    }

    if (entry.undo_action.type === "update") {
      await this.client.updateTransactions(entry.budget_id, [
        {
          transaction_id: resolvedEntityId,
          account_id: asOptionalString(restore.account_id),
          date: asOptionalString(restore.date),
          amount:
            restore.amount !== undefined
              ? milliunitsToCurrency(asNumber(restore.amount))
              : undefined,
          payee_id: asOptionalNullableString(restore.payee_id),
          category_id: asOptionalNullableString(restore.category_id),
          memo: asOptionalNullableString(restore.memo),
          cleared: asOptionalString(restore.cleared) as
            | "cleared"
            | "uncleared"
            | "reconciled"
            | undefined,
          approved: asOptionalBoolean(restore.approved),
          flag_color: asOptionalNullableString(restore.flag_color),
        },
      ]);

      return "Updated transaction to restore prior state.";
    }

    const created = await this.client.createTransactions(entry.budget_id, [
      {
        account_id: asRequiredString(restore.account_id),
        date: asRequiredString(restore.date),
        amount: milliunitsToCurrency(asNumber(restore.amount)),
        payee_id: asOptionalNullableString(restore.payee_id),
        category_id: asOptionalNullableString(restore.category_id),
        memo: asOptionalNullableString(restore.memo),
        cleared: asOptionalString(restore.cleared) as
          | "cleared"
          | "uncleared"
          | "reconciled"
          | undefined,
        approved: asOptionalBoolean(restore.approved),
        flag_color: asOptionalNullableString(restore.flag_color),
      },
    ]);

    const recreated = created[0];
    if (recreated) {
      await this.store.updateIdMappings(
        entry.budget_id,
        entry.undo_action.entity_id,
        recreated.id,
      );
    }

    return "Re-created deleted transaction.";
  }

  private async applyScheduledTransactionUndo(
    entry: UndoEntry,
    resolvedEntityId: string,
  ): Promise<string> {
    const restore = entry.undo_action.restore_state;

    if (entry.undo_action.type === "delete") {
      await this.client.deleteScheduledTransaction(
        entry.budget_id,
        resolvedEntityId,
      );
      return "Deleted scheduled transaction as undo action.";
    }

    if (entry.undo_action.type === "update") {
      const expected = entry.undo_action.expected_state;
      const frequencyChanged = restore.frequency !== expected.frequency;
      await this.client.updateScheduledTransaction(entry.budget_id, {
        scheduled_transaction_id: resolvedEntityId,
        account_id: asOptionalString(restore.account_id),
        date: asOptionalString(restore.date),
        amount:
          restore.amount !== undefined
            ? milliunitsToCurrency(asNumber(restore.amount))
            : undefined,
        payee_id: asOptionalNullableString(restore.payee_id),
        category_id: asOptionalNullableString(restore.category_id),
        memo: asOptionalNullableString(restore.memo),
        frequency: frequencyChanged
          ? (asOptionalString(restore.frequency) as
              | "never"
              | "daily"
              | "weekly"
              | "monthly"
              | "yearly"
              | undefined)
          : undefined,
        flag_color: asOptionalNullableString(restore.flag_color),
      });

      return "Updated scheduled transaction to restore prior state.";
    }

    const recreated = await this.client.createScheduledTransaction(
      entry.budget_id,
      {
        account_id: asRequiredString(restore.account_id),
        date: asRequiredString(restore.date),
        amount: milliunitsToCurrency(asNumber(restore.amount)),
        payee_id: asOptionalNullableString(restore.payee_id),
        category_id: asOptionalNullableString(restore.category_id),
        memo: asOptionalNullableString(restore.memo),
        frequency: asRequiredString(restore.frequency) as
          | "never"
          | "daily"
          | "weekly"
          | "monthly"
          | "yearly",
        flag_color: asOptionalNullableString(restore.flag_color),
      },
    );

    await this.store.updateIdMappings(
      entry.budget_id,
      entry.undo_action.entity_id,
      recreated.id,
    );

    return "Re-created deleted scheduled transaction.";
  }

  private async applyCategoryBudgetUndo(entry: UndoEntry): Promise<string> {
    const restore = entry.undo_action.restore_state;
    await this.client.setCategoryBudget(entry.budget_id, {
      category_id: asRequiredString(restore.category_id),
      month: asRequiredString(restore.month),
      budgeted: milliunitsToCurrency(asNumber(restore.budgeted)),
    });
    return "Restored category budget amount.";
  }

  private async getCurrentState(
    entry: UndoEntry,
    resolvedEntityId: string,
  ): Promise<Record<string, unknown> | null> {
    if (entry.undo_action.entity_type === "transaction") {
      const transaction = await this.client.getTransactionById(
        entry.budget_id,
        resolvedEntityId,
      );

      if (!transaction) {
        return null;
      }

      return this.client.snapshotTransaction(transaction);
    }

    if (entry.undo_action.entity_type === "scheduled_transaction") {
      const transaction = await this.client.getScheduledTransactionById(
        entry.budget_id,
        resolvedEntityId,
      );

      if (!transaction) {
        return null;
      }

      return this.client.snapshotScheduledTransaction(transaction);
    }

    const categoryId = asRequiredString(
      entry.undo_action.restore_state.category_id,
    );
    const month = asRequiredString(entry.undo_action.restore_state.month);
    const category = await this.client.getMonthCategoryById(
      entry.budget_id,
      month,
      categoryId,
    );

    if (!category) {
      return null;
    }

    return {
      category_id: category.id,
      month,
      budgeted: category.budgeted,
    };
  }
}

function asOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return String(value);
}

function asOptionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return String(value);
}

function asRequiredString(value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error("Expected a string value but received null or undefined.");
  }

  return String(value);
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return Boolean(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  throw new Error("Expected numeric value for undo state.");
}
