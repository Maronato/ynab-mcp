import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import {
  type CurrencyFormatLike,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

const spendingAnalysisSchema = z.object({
  budget_id: z.string().optional(),
  since_date: z.string(),
  until_date: z.string().optional(),
  group_by: z.enum(["category", "payee", "both"]).default("category"),
  top_n: z.number().int().min(1).max(100).default(10),
  category_ids: z.array(z.string()).optional(),
  account_ids: z.array(z.string()).optional(),
});

interface AggregateEntry {
  id: string;
  name: string;
  total_milliunits: number;
  count: number;
}

export function registerAnalysisTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_spending_analysis",
    {
      title: "Get Spending Analysis",
      description:
        "Aggregate spending over a date range and rank by category/payee for quick insights.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: spendingAnalysisSchema,
    },
    async (input) => {
      try {
        const groupByCategory =
          input.group_by === "category" || input.group_by === "both";
        const groupByPayee =
          input.group_by === "payee" || input.group_by === "both";
        const accountIdSet = input.account_ids
          ? new Set(input.account_ids)
          : null;
        const categoryIdSet = input.category_ids
          ? new Set(input.category_ids)
          : null;

        const [transactions, lookups, settings] = await Promise.all([
          context.ynabClient.getTransactionsInRange(
            input.budget_id,
            input.since_date,
            input.until_date,
          ),
          context.ynabClient.getNameLookup(input.budget_id),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        // Single-pass aggregation: filter, sum, and group without extra copies.
        let totalSpendingMilliunits = 0;
        let transactionCount = 0;
        const byCategoryMap = groupByCategory
          ? new Map<string, AggregateEntry>()
          : null;
        const byPayeeMap = groupByPayee
          ? new Map<string, AggregateEntry>()
          : null;

        for (const transaction of transactions) {
          if (transaction.amount >= 0) continue;
          if (accountIdSet && !accountIdSet.has(transaction.account_id))
            continue;
          if (
            categoryIdSet &&
            !categoryIdSet.has(transaction.category_id ?? "")
          )
            continue;

          const absAmount = Math.abs(transaction.amount);
          totalSpendingMilliunits += absAmount;
          transactionCount++;

          if (byCategoryMap) {
            const id = transaction.category_id ?? "uncategorized";
            const entry = byCategoryMap.get(id);
            if (entry) {
              entry.total_milliunits += absAmount;
              entry.count++;
            } else {
              byCategoryMap.set(id, {
                id,
                name: "",
                total_milliunits: absAmount,
                count: 1,
              });
            }
          }

          if (byPayeeMap) {
            const id = transaction.payee_id ?? "no_payee";
            const entry = byPayeeMap.get(id);
            if (entry) {
              entry.total_milliunits += absAmount;
              entry.count++;
            } else {
              byPayeeMap.set(id, {
                id,
                name: "",
                total_milliunits: absAmount,
                count: 1,
              });
            }
          }
        }

        const topN = input.top_n ?? 10;
        const result: Record<string, unknown> = {
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          since_date: input.since_date,
          until_date: input.until_date ?? null,
          total_spending_milliunits: totalSpendingMilliunits,
          total_spending: milliunitsToCurrency(totalSpendingMilliunits),
          total_spending_display: formatCurrency(
            totalSpendingMilliunits,
            settings.currency_format,
          ),
          transaction_count: transactionCount,
        };

        if (byCategoryMap) {
          const entries = [...byCategoryMap.values()]
            .sort((a, b) => b.total_milliunits - a.total_milliunits)
            .slice(0, topN);

          for (const entry of entries) {
            entry.name =
              entry.id === "uncategorized"
                ? "Uncategorized"
                : (lookups.categoryById.get(entry.id) ?? "Unknown Category");
          }

          result.by_category = entries.map((entry) =>
            formatAggregateEntry(entry, settings.currency_format),
          );
        }

        if (byPayeeMap) {
          const entries = [...byPayeeMap.values()]
            .sort((a, b) => b.total_milliunits - a.total_milliunits)
            .slice(0, topN);

          for (const entry of entries) {
            entry.name =
              entry.id === "no_payee"
                ? "No Payee"
                : (lookups.payeeById.get(entry.id) ?? "Unknown Payee");
          }

          result.by_payee = entries.map((entry) =>
            formatAggregateEntry(entry, settings.currency_format),
          );
        }

        return jsonToolResult(result);
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to compute spending analysis.",
        );
      }
    },
  );
}

function formatAggregateEntry(
  entry: AggregateEntry,
  currencyFormat?: CurrencyFormatLike,
): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    total_milliunits: entry.total_milliunits,
    total: milliunitsToCurrency(entry.total_milliunits),
    total_display: formatCurrency(entry.total_milliunits, currencyFormat),
    count: entry.count,
  };
}
