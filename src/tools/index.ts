import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { registerAccountTools } from "./accounts.js";
import { registerAnalysisTools } from "./analysis.js";
import { registerAnomalyTools } from "./anomalies.js";
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

/** Tools that mutate YNAB data (or replay mutations, like undo). */
const WRITE_TOOLS = new Set([
  "create_transactions",
  "update_transactions",
  "delete_transactions",
  "set_category_budgets",
  "set_category_targets",
  "create_scheduled_transactions",
  "update_scheduled_transactions",
  "delete_scheduled_transactions",
  "undo_operations",
]);

/**
 * In read-only mode write tools are not registered at all, so MCP clients
 * only ever see tools they can actually use. The client layer additionally
 * refuses writes (belt and suspenders).
 */
function withWriteToolFilter(server: McpServer, readOnly: boolean): McpServer {
  if (!readOnly) return server;
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, ...rest: unknown[]) => {
          if (WRITE_TOOLS.has(name)) return undefined;
          return (target.registerTool as (...args: unknown[]) => unknown).call(
            target,
            name,
            ...rest,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function registerTools(rawServer: McpServer, context: AppContext): void {
  const server = withWriteToolFilter(rawServer, context.ynabClient.readOnly);
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
  registerRecurringTools(server, context);
  registerAnomalyTools(server, context);
}
