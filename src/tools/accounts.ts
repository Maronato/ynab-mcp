import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import { asMilliunits, milliunitsToCurrency } from "../ynab/format.js";

const getAccountsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  type: z
    .enum([
      "checking",
      "savings",
      "cash",
      "creditCard",
      "lineOfCredit",
      "otherAsset",
      "otherLiability",
      "mortgage",
      "autoLoan",
      "studentLoan",
      "personalLoan",
      "medicalDebt",
      "otherDebt",
    ])
    .optional()
    .describe("Filter by account type."),
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
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
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
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          currency: settings.currency_format?.iso_code ?? null,
          count: accounts.length,
          accounts: accounts.map((account) => ({
            id: account.id,
            name: account.name,
            type: account.type,
            on_budget: account.on_budget,
            closed: account.closed,
            balance: milliunitsToCurrency(asMilliunits(account.balance)),
            cleared_balance: milliunitsToCurrency(
              asMilliunits(account.cleared_balance),
            ),
            uncleared_balance: milliunitsToCurrency(
              asMilliunits(account.uncleared_balance),
            ),
          })),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to get accounts."),
        );
      }
    },
  );
}
