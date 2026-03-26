import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { formatCurrency } from "../ynab/format.js";

const budgetIdSchema = z.object({
  budget_id: z.string().optional(),
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
          error instanceof Error ? error.message : "Failed to list budgets.",
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
          account_summary_by_type: summary.account_summary_by_type.map((entry) => ({
            ...entry,
            total_balance_display: formatCurrency(
              entry.total_balance_milliunits,
              settings.currency_format,
            ),
          })),
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to get budget summary.",
        );
      }
    },
  );
}
