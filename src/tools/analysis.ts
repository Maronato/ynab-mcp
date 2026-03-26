import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { formatCurrency, milliunitsToCurrency } from "../ynab/format.js";

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

interface CurrencyFormatLike {
  currency_symbol?: string;
  decimal_digits?: number;
  decimal_separator?: string;
  group_separator?: string;
  symbol_first?: boolean;
  display_symbol?: boolean;
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
      inputSchema: spendingAnalysisSchema,
    },
    async (input) => {
      try {
        const [transactions, lookups, settings] = await Promise.all([
          context.ynabClient.searchTransactions(input.budget_id, {
            since_date: input.since_date,
            until_date: input.until_date,
            limit: 5000,
            sort: "date_desc",
          }),
          context.ynabClient.getNameLookup(input.budget_id),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        const filtered = transactions.filter((transaction) => {
          if (transaction.amount >= 0) {
            return false;
          }

          if (
            input.account_ids &&
            !input.account_ids.includes(transaction.account_id)
          ) {
            return false;
          }

          if (
            input.category_ids &&
            !input.category_ids.includes(transaction.category_id ?? "")
          ) {
            return false;
          }

          return true;
        });

        const byCategory = aggregateSpending(
          filtered,
          (transaction) => transaction.category_id ?? "uncategorized",
          (id) =>
            id === "uncategorized"
              ? "Uncategorized"
              : (lookups.categoryById.get(id) ?? "Unknown Category"),
        );
        const byPayee = aggregateSpending(
          filtered,
          (transaction) => transaction.payee_id ?? "no_payee",
          (id) =>
            id === "no_payee"
              ? "No Payee"
              : (lookups.payeeById.get(id) ?? "Unknown Payee"),
        );

        const topN = input.top_n ?? 10;
        const result: Record<string, unknown> = {
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          since_date: input.since_date,
          until_date: input.until_date ?? null,
          total_spending_milliunits: filtered.reduce(
            (sum, transaction) => sum + Math.abs(transaction.amount),
            0,
          ),
          total_spending: milliunitsToCurrency(
            filtered.reduce(
              (sum, transaction) => sum + Math.abs(transaction.amount),
              0,
            ),
          ),
          total_spending_display: formatCurrency(
            filtered.reduce(
              (sum, transaction) => sum + Math.abs(transaction.amount),
              0,
            ),
            settings.currency_format,
          ),
          transaction_count: filtered.length,
        };

        if (input.group_by === "category" || input.group_by === "both") {
          result.by_category = byCategory.slice(0, topN).map((entry) =>
            formatAggregateEntry(entry, settings.currency_format),
          );
        }

        if (input.group_by === "payee" || input.group_by === "both") {
          result.by_payee = byPayee.slice(0, topN).map((entry) =>
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

function aggregateSpending(
  transactions: Array<{
    amount: number;
    category_id?: string | null;
    payee_id?: string | null;
  }>,
  getId: (transaction: {
    amount: number;
    category_id?: string | null;
    payee_id?: string | null;
  }) => string,
  getName: (id: string) => string,
): AggregateEntry[] {
  const aggregates = new Map<string, AggregateEntry>();

  for (const transaction of transactions) {
    const id = getId(transaction);
    const existing = aggregates.get(id) ?? {
      id,
      name: getName(id),
      total_milliunits: 0,
      count: 0,
    };

    existing.total_milliunits += Math.abs(transaction.amount);
    existing.count += 1;
    aggregates.set(id, existing);
  }

  return [...aggregates.values()].sort(
    (left, right) => right.total_milliunits - left.total_milliunits,
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
