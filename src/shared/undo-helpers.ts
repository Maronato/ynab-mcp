import type { UndoEngine } from "../undo/engine.js";
import type { UndoEntry, UndoOperationType } from "../undo/types.js";
import { isAmbiguousWriteOutcome } from "../ynab/errors.js";

interface UndoEntryInput {
  operation: UndoOperationType;
  description: string;
  undo_action: UndoEntry["undo_action"];
}

interface IdMapping {
  sourceEntityId: string;
  targetEntityId: string;
}

/**
 * Run a write operation bracketed by a pending-operation marker.
 *
 * The marker is cleared on success and on definitive failures (the API
 * rejected the request), but deliberately left in place — with an
 * explanatory note — when the outcome is ambiguous (e.g. the request timed
 * out mid-flight). `list_undo_history` surfaces leftover markers, so an
 * interrupted write that may have been applied without an undo entry stays
 * visible instead of vanishing silently.
 */
export async function withPendingOperation<T>(
  engine: UndoEngine,
  budgetId: string,
  description: string,
  operation: () => Promise<T>,
): Promise<T> {
  const pendingId = await engine.markPending(budgetId, description);
  try {
    const result = await operation();
    await engine.clearPending(budgetId, pendingId);
    return result;
  } catch (error) {
    if (isAmbiguousWriteOutcome(error)) {
      try {
        await engine.annotatePending(
          budgetId,
          pendingId,
          "A YNAB API request timed out during this operation. The write may " +
            "have been applied without an undo entry being recorded — verify " +
            "the budget's current state before retrying.",
        );
      } catch {
        // Annotation is best-effort; the leftover marker is the signal.
      }
    } else {
      await engine.clearPending(budgetId, pendingId);
    }
    throw error;
  }
}

export async function recordUndoAndGetIds(
  engine: UndoEngine,
  budgetId: string,
  entries: UndoEntryInput[],
  idMappings?: IdMapping[],
): Promise<string[]> {
  if (entries.length === 0) return [];
  const recorded = await engine.recordEntries(budgetId, entries, idMappings);
  return recorded.map((entry) => entry.id);
}
