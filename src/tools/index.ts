import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { registerAccountTools } from "./accounts.js";
import { registerAnalysisTools } from "./analysis.js";
import { registerBudgetTools } from "./budgets.js";
import { registerCategoryTools } from "./categories.js";
import { registerScheduledTransactionTools } from "./scheduled.js";
import { registerTransactionTools } from "./transactions.js";
import { registerUndoTools } from "./undo.js";

export function registerTools(server: McpServer, context: AppContext): void {
  registerBudgetTools(server, context);
  registerAccountTools(server, context);
  registerTransactionTools(server, context);
  registerCategoryTools(server, context);
  registerAnalysisTools(server, context);
  registerScheduledTransactionTools(server, context);
  registerUndoTools(server, context);
}
