import type { UndoEngine } from "../undo/engine.js";
import type { UndoEntry, UndoOperationType } from "../undo/types.js";

interface UndoEntryInput {
  operation: UndoOperationType;
  description: string;
  undo_action: UndoEntry["undo_action"];
}

interface IdMapping {
  sourceEntityId: string;
  targetEntityId: string;
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
