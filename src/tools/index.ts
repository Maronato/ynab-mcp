import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { registerAccountTools } from "./accounts.js";
import { registerAnalysisTools } from "./analysis.js";
import { registerAnomalyTools } from "./anomalies.js";
import { registerBreakdownTools } from "./breakdown.js";
import { registerBudgetTools } from "./budgets.js";
import { registerCategoryTools } from "./categories.js";
import { registerHealthTools } from "./health.js";
import { registerIncomeExpenseTools } from "./income-expense.js";
import { registerRecurringTools } from "./recurring.js";
import { registerScheduledTransactionTools } from "./scheduled.js";
import { registerSmartTools } from "./smart.js";
import { registerTargetTools } from "./targets.js";
import { registerTransactionTools } from "./transactions.js";
import { registerTrendTools } from "./trends.js";
import { registerUndoTools } from "./undo.js";

export function registerTools(server: McpServer, context: AppContext): void {
  registerBudgetTools(server, context);
  registerAccountTools(server, context);
  registerTransactionTools(server, context);
  registerCategoryTools(server, context);
  registerAnalysisTools(server, context);
  registerScheduledTransactionTools(server, context);
  registerSmartTools(server, context);
  registerTargetTools(server, context);
  registerUndoTools(server, context);
  registerHealthTools(server, context);
  registerTrendTools(server, context);
  registerIncomeExpenseTools(server, context);
  registerBreakdownTools(server, context);
  registerRecurringTools(server, context);
  registerAnomalyTools(server, context);
}
