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
 * Passed to a {@link withPendingOperation} callback so batched tools —
 * which catch per-item errors and fold them into result rows instead of
 * letting them escape — can still flag an ambiguous outcome.
 */
export interface AmbiguityTracker {
  /** Report a caught per-item error; ambiguous ones keep the marker. */
  note(error: unknown): void;
}

const AMBIGUOUS_OUTCOME_NOTE =
  "A YNAB API request failed with an unknown outcome (timeout or dropped " +
  "connection) during this operation. A write may have been applied without " +
  "an undo entry being recorded — verify the budget's current state before " +
  "retrying.";

/**
 * Run a write operation bracketed by a pending-operation marker.
 *
 * The marker is cleared on success and on definitive failures (the API
 * rejected the request), but deliberately left in place — with an
 * explanatory note — when the outcome is ambiguous: the operation threw an
 * ambiguous error, or the callback reported one via the tracker (batched
 * tools catch per-item errors, so those never escape the callback).
 * `list_undo_history` surfaces leftover markers, so an interrupted write
 * that may have been applied without an undo entry stays visible instead
 * of vanishing silently.
 *
 * Marker cleanup is best-effort on every path: a bookkeeping failure must
 * neither mask the operation's real error nor fail an operation that
 * succeeded (an uncleared marker only over-warns, and expires later).
 */
export async function withPendingOperation<T>(
  engine: UndoEngine,
  budgetId: string,
  description: string,
  operation: (ambiguity: AmbiguityTracker) => Promise<T>,
): Promise<T> {
  const pendingId = await engine.markPending(budgetId, description);
  let sawAmbiguous = false;
  const ambiguity: AmbiguityTracker = {
    note(error: unknown) {
      if (isAmbiguousWriteOutcome(error)) sawAmbiguous = true;
    },
  };

  const settleMarker = async (escaped?: unknown): Promise<void> => {
    try {
      if (
        sawAmbiguous ||
        (escaped !== undefined && isAmbiguousWriteOutcome(escaped))
      ) {
        await engine.annotatePending(
          budgetId,
          pendingId,
          AMBIGUOUS_OUTCOME_NOTE,
        );
      } else {
        await engine.clearPending(budgetId, pendingId);
      }
    } catch {
      // Best-effort; the leftover marker is the signal, never the failure.
    }
  };

  try {
    const result = await operation(ambiguity);
    await settleMarker();
    return result;
  } catch (error) {
    await settleMarker(error);
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
