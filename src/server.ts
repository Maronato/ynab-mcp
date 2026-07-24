import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PayeeProfileAnalyzer } from "./analysis/payee-profiles.js";
import type { AppContext } from "./context.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";
import { UndoEngine } from "./undo/engine.js";
import { UndoStore } from "./undo/store.js";
import { YnabClient } from "./ynab/client.js";
import { extractErrorMessage } from "./ynab/errors.js";

export interface CreateServerOptions {
  accessToken: string;
  dataDirectory: string;
  endpointUrl?: string;
  version?: string;
  readOnly?: boolean;
  cacheTtlMs?: number;
  pastMonthCacheTtlMs?: number;
  undoHistoryLimit?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export function createYnabMcpServer(options: CreateServerOptions): {
  server: McpServer;
  context: AppContext;
} {
  const ynabClient = new YnabClient(options.accessToken, options.endpointUrl, {
    readOnly: options.readOnly,
    cacheTtlMs: options.cacheTtlMs,
    pastMonthCacheTtlMs: options.pastMonthCacheTtlMs,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  });
  const undoStore = new UndoStore(
    options.dataDirectory,
    options.undoHistoryLimit,
  );
  const undoEngine = new UndoEngine(ynabClient, undoStore);

  // A split-deletion workaround transaction whose cleanup delete failed
  // stays in the budget; record it as an undoable create so it surfaces in
  // undo history and can be removed with undo_operations.
  ynabClient.setOrphanedCleanupRecorder({
    recordOrphanedCleanupTransaction: async (budgetId, transaction, error) => {
      await undoEngine.recordEntries(budgetId, [
        {
          operation: "create_transaction",
          description:
            `Temporary -0.01 cleanup transaction ${transaction.id} (from the ` +
            "split-deletion workaround) could not be deleted and remains in " +
            "the budget. Undo this entry to remove it. Reason: " +
            extractErrorMessage(error),
          undo_action: {
            type: "delete",
            entity_type: "transaction",
            entity_id: transaction.id,
            expected_state: ynabClient.snapshotTransaction(transaction),
            restore_state: {},
          },
        },
      ]);
    },
  });

  const server = new McpServer(
    {
      name: "ynab-mcp-server",
      version: options.version ?? "0.0.0",
    },
    {
      instructions:
        "Tools for working with the user's YNAB (You Need A Budget) data: " +
        "reading and searching accounts, transactions, categories, targets, and " +
        "scheduled transactions; batch-creating/updating/deleting transactions " +
        "and scheduled transactions; assigning budget amounts and targets; " +
        "spending analysis (aggregation, time series, income vs expense, " +
        "recurring-charge and anomaly detection); the money-movement audit feed " +
        "showing how budgeted amounts changed; a one-call budget health " +
        "snapshot; and undo for every write. Amounts are plain currency units " +
        "(never milliunits). Every write returns undo_history_ids usable with " +
        "undo_operations. Read the ynab://knowledge/* resources for YNAB " +
        "methodology (credit cards, targets, overspending, reconciliation) " +
        "before giving budgeting advice. The YNAB API allows 200 requests/hour; " +
        "some batch tools cost one request per item and say so in their " +
        "descriptions.",
    },
  );

  const payeeProfileAnalyzer = new PayeeProfileAnalyzer(ynabClient);

  const context: AppContext = {
    ynabClient,
    undoEngine,
    payeeProfileAnalyzer,
  };

  registerTools(server, context);
  registerResources(server);
  registerPrompts(server);

  return {
    server,
    context,
  };
}
