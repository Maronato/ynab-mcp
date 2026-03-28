import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import { formatCurrency } from "../ynab/format.js";

const budgetIdSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
});

export function registerBudgetTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "list_budgets",
    {
      title: "List Budgets",
      description: "List available YNAB budgets with key metadata.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const budgets = await context.ynabClient.listBudgets();
        return jsonToolResult({
          budgets: budgets.map((budget) => ({
            id: budget.id,
            name: budget.name,
            last_modified_on: budget.last_modified_on ?? null,
            first_month: budget.first_month ?? null,
            last_month: budget.last_month ?? null,
          })),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to list budgets."),
        );
      }
    },
  );

  server.registerTool(
    "get_budget_summary",
    {
      title: "Get Budget Summary",
      description:
        "Get a high-level budget snapshot (net worth, current month totals, overspending, account totals).",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: budgetIdSchema,
    },
    async ({ budget_id: budgetId }) => {
      try {
        const [summary, settings] = await Promise.all([
          context.ynabClient.getBudgetSummary(budgetId),
          context.ynabClient.getBudgetSettings(budgetId),
        ]);

        return jsonToolResult({
          ...summary,
          net_worth_display: formatCurrency(
            summary.net_worth_milliunits,
            settings.currency_format,
          ),
          income_display: formatCurrency(
            summary.income_milliunits,
            settings.currency_format,
          ),
          budgeted_display: formatCurrency(
            summary.budgeted_milliunits,
            settings.currency_format,
          ),
          activity_display: formatCurrency(
            summary.activity_milliunits,
            settings.currency_format,
          ),
          to_be_budgeted_display: formatCurrency(
            summary.to_be_budgeted_milliunits,
            settings.currency_format,
          ),
          account_summary_by_type: summary.account_summary_by_type.map(
            (entry) => ({
              ...entry,
              total_balance_display: formatCurrency(
                entry.total_balance_milliunits,
                settings.currency_format,
              ),
            }),
          ),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to get budget summary."),
        );
      }
    },
  );

  server.registerTool(
    "sync_budget_data",
    {
      title: "Sync Budget Data",
      description:
        "Force a fresh sync of all cached budget data (accounts, categories, payees, transactions, scheduled transactions) " +
        "from the YNAB API. Use this when you suspect external changes (e.g., bank imports, mobile app edits) " +
        "that may not be reflected yet. Costs up to 5 API requests against the 200/hour rate limit.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: budgetIdSchema,
    },
    async ({ budget_id: budgetId }) => {
      try {
        const deltas = await context.ynabClient.syncBudgetData(budgetId);
        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(budgetId),
          message: "Budget data synced successfully.",
          changes: deltas,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to sync budget data."),
        );
      }
    },
  );
}
