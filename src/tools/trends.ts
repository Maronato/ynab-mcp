import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asMilliunits,
  type CurrencyFormatLike,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

const spendingTrendsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  months: z
    .number()
    .int()
    .min(2)
    .max(12)
    .default(6)
    .describe("Number of months to analyze (2-12)."),
  group_by: z
    .enum(["category", "payee", "category_group"])
    .default("category")
    .describe("How to group spending data."),
  category_ids: z
    .array(z.string())
    .optional()
    .describe("Limit analysis to specific category IDs."),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Number of top entities to include in results."),
});

interface MonthBucket {
  total: number;
  count: number;
}

interface EntityAccumulator {
  id: string;
  name: string;
  group_name?: string;
  /** month key -> { total milliunits, transaction count } */
  byMonth: Map<string, MonthBucket>;
  total: number;
}

function computeDateRange(monthsBack: number): {
  sinceDate: string;
  untilDate: string;
  monthKeys: string[];
} {
  const now = new Date();
  // End of the current month
  const endYear = now.getFullYear();
  const endMonth = now.getMonth(); // 0-indexed
  const untilDate = new Date(endYear, endMonth + 1, 0)
    .toISOString()
    .slice(0, 10);

  // Start of (monthsBack - 1) months ago (current month counts as one)
  const startDate = new Date(endYear, endMonth - (monthsBack - 1), 1);
  const sinceDate = startDate.toISOString().slice(0, 10);

  const monthKeys: string[] = [];
  const cursor = new Date(startDate);
  while (cursor <= now || cursor.getMonth() === now.getMonth()) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    monthKeys.push(key);
    cursor.setMonth(cursor.getMonth() + 1);
    if (monthKeys.length >= monthsBack) break;
  }

  return { sinceDate, untilDate, monthKeys };
}

function determineTrend(
  data: Map<string, MonthBucket>,
  monthKeys: string[],
): {
  direction: "increasing" | "decreasing" | "stable";
  percent_change: number;
} {
  if (monthKeys.length < 2) {
    return { direction: "stable", percent_change: 0 };
  }

  const lastMonth = monthKeys[monthKeys.length - 1];
  const lastAmount = data.get(lastMonth)?.total ?? 0;

  // Average of all months except the last
  const priorKeys = monthKeys.slice(0, -1);
  const priorSum = priorKeys.reduce(
    (sum, key) => sum + (data.get(key)?.total ?? 0),
    0,
  );
  const priorAvg = priorSum / priorKeys.length;

  if (priorAvg === 0) {
    if (lastAmount === 0) return { direction: "stable", percent_change: 0 };
    return { direction: "increasing", percent_change: 100 };
  }

  const pctChange = ((lastAmount - priorAvg) / priorAvg) * 100;
  const rounded = Math.round(pctChange * 100) / 100;

  if (rounded > 5) return { direction: "increasing", percent_change: rounded };
  if (rounded < -5) return { direction: "decreasing", percent_change: rounded };
  return { direction: "stable", percent_change: rounded };
}

function computeMovingAverage(
  data: Map<string, MonthBucket>,
  monthKeys: string[],
  window: number,
): number[] {
  const values = monthKeys.map((key) => data.get(key)?.total ?? 0);
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
    result.push(Math.round(avg));
  }
  return result;
}

function formatMonthAmount(
  milliunits: number,
  currencyFormat?: CurrencyFormatLike,
): { amount: number; amount_display: string } {
  const m = asMilliunits(milliunits);
  return {
    amount: milliunitsToCurrency(m),
    amount_display: formatCurrency(m, currencyFormat),
  };
}

export function registerTrendTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_spending_trends",
    {
      title: "Get Spending Trends",
      description:
        "Multi-month spending time series with trend detection. Groups spending by category, payee, or category group and identifies increasing/decreasing patterns.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: spendingTrendsSchema,
    },
    async (input) => {
      try {
        const categoryIdSet = input.category_ids
          ? new Set(input.category_ids)
          : null;
        const topN = input.top_n ?? 10;

        const { sinceDate, untilDate, monthKeys } = computeDateRange(
          input.months ?? 6,
        );

        const [transactions, lookups, settings] = await Promise.all([
          context.ynabClient.getTransactionsInRange(
            input.budget_id,
            sinceDate,
            untilDate,
          ),
          context.ynabClient.getNameLookup(input.budget_id),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        // Build internal category set for exclusion
        const internalCategoryIds = new Set<string>();
        for (const [id, info] of lookups.categoryById) {
          if (info.group_name === "Internal Master Category") {
            internalCategoryIds.add(id);
          }
        }

        // Single-pass bucket sort
        const entityMap = new Map<string, EntityAccumulator>();
        const monthTotals = new Map<string, number>();

        for (const tx of transactions) {
          if (tx.amount >= 0) continue;
          if (tx.transfer_account_id != null) continue;

          const monthKey = tx.date.slice(0, 7); // YYYY-MM
          if (!monthKeys.includes(monthKey)) continue;

          const activeSubs =
            tx.subtransactions?.filter((s) => !s.deleted) ?? [];
          const isSplit = activeSubs.length > 0;

          if (isSplit) {
            for (const sub of activeSubs) {
              if (sub.amount >= 0) continue;
              if (sub.transfer_account_id != null) continue;
              const catId = sub.category_id ?? "uncategorized";
              if (internalCategoryIds.has(catId)) continue;
              if (categoryIdSet && !categoryIdSet.has(catId)) continue;

              const absAmount = Math.abs(sub.amount);
              accumulateEntity(
                entityMap,
                input.group_by ?? "category",
                catId,
                tx.payee_id ?? "no_payee",
                monthKey,
                absAmount,
                lookups,
              );
              monthTotals.set(
                monthKey,
                (monthTotals.get(monthKey) ?? 0) + absAmount,
              );
            }
          } else {
            const catId = tx.category_id ?? "uncategorized";
            if (internalCategoryIds.has(catId)) continue;
            if (categoryIdSet && !categoryIdSet.has(catId)) continue;

            const absAmount = Math.abs(tx.amount);
            accumulateEntity(
              entityMap,
              input.group_by ?? "category",
              catId,
              tx.payee_id ?? "no_payee",
              monthKey,
              absAmount,
              lookups,
            );
            monthTotals.set(
              monthKey,
              (monthTotals.get(monthKey) ?? 0) + absAmount,
            );
          }
        }

        // Rank by total, take top_n
        const ranked = [...entityMap.values()]
          .sort((a, b) => b.total - a.total)
          .slice(0, topN);

        // Build series output
        const series = ranked.map((entity) => {
          const trend = determineTrend(entity.byMonth, monthKeys);
          const movingAvg = computeMovingAverage(entity.byMonth, monthKeys, 3);

          return {
            id: entity.id,
            name: entity.name,
            ...(entity.group_name != null && {
              group_name: entity.group_name,
            }),
            data: monthKeys.map((month, idx) => {
              const bucket = entity.byMonth.get(month);
              const amount = bucket?.total ?? 0;
              return {
                month,
                ...formatMonthAmount(amount, settings.currency_format),
                transaction_count: bucket?.count ?? 0,
                moving_average_3m: milliunitsToCurrency(
                  asMilliunits(movingAvg[idx]),
                ),
              };
            }),
            total: milliunitsToCurrency(asMilliunits(entity.total)),
            total_display: formatCurrency(
              asMilliunits(entity.total),
              settings.currency_format,
            ),
            average_monthly: milliunitsToCurrency(
              asMilliunits(Math.round(entity.total / monthKeys.length)),
            ),
            average_monthly_display: formatCurrency(
              asMilliunits(Math.round(entity.total / monthKeys.length)),
              settings.currency_format,
            ),
            trend_direction: trend.direction,
            trend_percent_change: trend.percent_change,
          };
        });

        // Build total_by_month
        const totalByMonth = monthKeys.map((month) => {
          const total = monthTotals.get(month) ?? 0;
          return {
            month,
            total: milliunitsToCurrency(asMilliunits(total)),
            total_display: formatCurrency(
              asMilliunits(total),
              settings.currency_format,
            ),
          };
        });

        // Compute summary: highest growth and biggest reduction
        let highestGrowthCategory: string | null = null;
        let highestGrowthPercent = 0;
        let biggestReductionCategory: string | null = null;
        let biggestReductionPercent = 0;

        for (const s of series) {
          if (s.trend_percent_change > highestGrowthPercent) {
            highestGrowthPercent = s.trend_percent_change;
            highestGrowthCategory = s.name;
          }
          if (s.trend_percent_change < biggestReductionPercent) {
            biggestReductionPercent = s.trend_percent_change;
            biggestReductionCategory = s.name;
          }
        }

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          period_start: sinceDate,
          period_end: untilDate,
          months: monthKeys,
          total_by_month: totalByMonth,
          series,
          summary: {
            highest_growth_category: highestGrowthCategory,
            highest_growth_percent: highestGrowthPercent,
            biggest_reduction_category: biggestReductionCategory,
            biggest_reduction_percent: biggestReductionPercent,
          },
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to compute spending trends."),
        );
      }
    },
  );
}

function resolveEntityKey(
  groupBy: "category" | "payee" | "category_group",
  categoryId: string,
  payeeId: string,
  lookups: {
    categoryById: Map<
      string,
      { name: string; group_id: string; group_name: string }
    >;
    payeeById: Map<string, string>;
  },
): { id: string; name: string; group_name?: string } {
  switch (groupBy) {
    case "category": {
      const catInfo = lookups.categoryById.get(categoryId);
      return {
        id: categoryId,
        name:
          categoryId === "uncategorized"
            ? "Uncategorized"
            : (catInfo?.name ?? "Unknown Category"),
        group_name: catInfo?.group_name,
      };
    }
    case "payee": {
      return {
        id: payeeId,
        name:
          payeeId === "no_payee"
            ? "No Payee"
            : (lookups.payeeById.get(payeeId) ?? "Unknown Payee"),
      };
    }
    case "category_group": {
      const catInfo = lookups.categoryById.get(categoryId);
      const groupId = catInfo?.group_id ?? "unknown_group";
      const groupName = catInfo?.group_name ?? "Unknown Group";
      return { id: groupId, name: groupName };
    }
  }
}

function accumulateEntity(
  entityMap: Map<string, EntityAccumulator>,
  groupBy: "category" | "payee" | "category_group",
  categoryId: string,
  payeeId: string,
  monthKey: string,
  absAmount: number,
  lookups: {
    categoryById: Map<
      string,
      { name: string; group_id: string; group_name: string }
    >;
    payeeById: Map<string, string>;
  },
): void {
  const resolved = resolveEntityKey(groupBy, categoryId, payeeId, lookups);
  const existing = entityMap.get(resolved.id);

  if (existing) {
    existing.total += absAmount;
    const bucket = existing.byMonth.get(monthKey);
    if (bucket) {
      bucket.total += absAmount;
      bucket.count++;
    } else {
      existing.byMonth.set(monthKey, { total: absAmount, count: 1 });
    }
  } else {
    const byMonth = new Map<string, MonthBucket>();
    byMonth.set(monthKey, { total: absAmount, count: 1 });
    entityMap.set(resolved.id, {
      id: resolved.id,
      name: resolved.name,
      group_name: resolved.group_name,
      byMonth,
      total: absAmount,
    });
  }
}
