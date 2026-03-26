import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { formatCurrency, milliunitsToCurrency } from "../ynab/format.js";

const getAccountsSchema = z.object({
  budget_id: z.string().optional(),
  type: z.string().optional(),
  on_budget: z.boolean().optional(),
  include_closed: z.boolean().optional(),
});

export function registerAccountTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_accounts",
    {
      title: "Get Accounts",
      description:
        "Get accounts with optional filtering by type, on-budget flag, and closed state.",
      inputSchema: getAccountsSchema,
    },
    async (input) => {
      try {
        const [accounts, settings] = await Promise.all([
          context.ynabClient.getAccounts(input.budget_id, {
            type: input.type,
            onBudget: input.on_budget,
            includeClosed: input.include_closed,
          }),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        return jsonToolResult({
          count: accounts.length,
          accounts: accounts.map((account) => ({
            id: account.id,
            name: account.name,
            type: account.type,
            on_budget: account.on_budget,
            closed: account.closed,
            balance: milliunitsToCurrency(account.balance),
            balance_display: formatCurrency(
              account.balance,
              settings.currency_format,
            ),
            cleared_balance: milliunitsToCurrency(account.cleared_balance),
            cleared_balance_display: formatCurrency(
              account.cleared_balance,
              settings.currency_format,
            ),
            uncleared_balance: milliunitsToCurrency(account.uncleared_balance),
            uncleared_balance_display: formatCurrency(
              account.uncleared_balance,
              settings.currency_format,
            ),
          })),
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error ? error.message : "Failed to get accounts.",
        );
      }
    },
  );
}
