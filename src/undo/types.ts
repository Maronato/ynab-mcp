export type UndoOperationType =
  | "create_transaction"
  | "update_transaction"
  | "delete_transaction"
  | "create_scheduled_transaction"
  | "update_scheduled_transaction"
  | "delete_scheduled_transaction"
  | "set_category_budget";

type UndoActionType = "delete" | "update" | "create";

type UndoEntityType =
  | "transaction"
  | "scheduled_transaction"
  | "category_budget";

export interface UndoAction {
  type: UndoActionType;
  entity_type: UndoEntityType;
  entity_id: string;
  expected_state: Record<string, unknown>;
  restore_state: Record<string, unknown>;
}

export interface UndoEntry {
  id: string;
  budget_id: string;
  timestamp: string;
  operation: UndoOperationType;
  description: string;
  undo_action: UndoAction;
  status: "active" | "undone";
}

export interface UndoHistoryFile {
  entries: UndoEntry[];
  id_mappings: Record<string, string>;
}

export interface UndoConflict {
  entry_id: string;
  reason: string;
  expected_state: Record<string, unknown>;
  current_state: Record<string, unknown> | null;
  restore_state: Record<string, unknown>;
}

export interface UndoExecutionResult {
  entry_id: string;
  status: "undone" | "conflict" | "skipped" | "error";
  message: string;
  conflict?: UndoConflict;
}
