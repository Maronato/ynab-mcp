import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PayeeProfileAnalyzer } from "./analysis/payee-profiles.js";
import type { AppContext } from "./context.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";
import { UndoEngine } from "./undo/engine.js";
import { UndoStore } from "./undo/store.js";
import { YnabClient } from "./ynab/client.js";

export interface CreateServerOptions {
  accessToken: string;
  dataDirectory: string;
  endpointUrl?: string;
  version?: string;
  readOnly?: boolean;
  cacheTtlMs?: number;
  pastMonthCacheTtlMs?: number;
  undoHistoryLimit?: number;
}

export function createYnabMcpServer(options: CreateServerOptions): {
  server: McpServer;
  context: AppContext;
} {
  const ynabClient = new YnabClient(options.accessToken, options.endpointUrl, {
    readOnly: options.readOnly,
    cacheTtlMs: options.cacheTtlMs,
    pastMonthCacheTtlMs: options.pastMonthCacheTtlMs,
  });
  const undoStore = new UndoStore(
    options.dataDirectory,
    options.undoHistoryLimit,
  );
  const undoEngine = new UndoEngine(ynabClient, undoStore);

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
        "snapshot; and undo for every write. Tool inputs always take plain " +
        "currency units, never milliunits, and outputs report them the same " +
        "way (a few analysis totals add raw milliunits alongside). Every " +
        "write returns undo_history_ids usable with undo_operations. Read the ynab://knowledge/* resources for YNAB " +
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
