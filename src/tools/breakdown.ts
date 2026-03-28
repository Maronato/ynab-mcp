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

const spendingBreakdownSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  since_date: z.string().describe("Start date in YYYY-MM-DD format."),
  until_date: z
    .string()
    .optional()
    .describe("End date in YYYY-MM-DD format. Defaults to today."),
  granularity: z
    .enum(["daily", "weekly", "day_of_week", "week_of_month"])
    .describe("How to bucket spending over the time range."),
  category_ids: z
    .array(z.string())
    .optional()
    .describe("Limit analysis to specific category IDs."),
});

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

interface BucketAccumulator {
  key: string;
  label: string;
  total: number;
  count: number;
}

function getBucketKey(
  dateStr: string,
  granularity: "daily" | "weekly" | "day_of_week" | "week_of_month",
): { key: string; label: string } {
  const date = new Date(`${dateStr}T00:00:00`);

  switch (granularity) {
    case "daily":
      return { key: dateStr, label: dateStr };

    case "weekly": {
      // ISO week: find Monday of the week
      const day = date.getDay();
      const diff = day === 0 ? -6 : 1 - day; // adjust to Monday
      const monday = new Date(date);
      monday.setDate(date.getDate() + diff);
      const key = monday.toISOString().slice(0, 10);
      return { key, label: `Week of ${key}` };
    }

    case "day_of_week": {
      const dayIndex = date.getDay();
      return {
        key: String(dayIndex),
        label: DAY_NAMES[dayIndex],
      };
    }

    case "week_of_month": {
      // Week 1 = days 1-7, Week 2 = days 8-14, etc.
      const dayOfMonth = date.getDate();
      const weekNum = Math.ceil(dayOfMonth / 7);
      return {
        key: String(weekNum),
        label: `Week ${weekNum}`,
      };
    }
  }
}

function computeStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance));
}

function formatBucketAmount(
  milliunits: number,
  cf?: CurrencyFormatLike,
): { total: number; total_display: string } {
  const m = asMilliunits(milliunits);
  return {
    total: milliunitsToCurrency(m),
    total_display: formatCurrency(m, cf),
  };
}

export function registerBreakdownTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_spending_breakdown",
    {
      title: "Get Spending Breakdown",
      description:
        "Break down spending by time granularity (daily, weekly, day-of-week, or week-of-month) to identify patterns in when money is spent.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: spendingBreakdownSchema,
    },
    async (input) => {
      try {
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

        const cf = settings.currency_format;

        // Build internal category set for exclusion
        const internalCategoryIds = new Set<string>();
        for (const [id, info] of lookups.categoryById) {
          if (info.group_name === "Internal Master Category") {
            internalCategoryIds.add(id);
          }
        }

        // Single-pass aggregation into buckets
        const bucketMap = new Map<string, BucketAccumulator>();
        let grandTotal = 0;
        let totalTransactionCount = 0;

        for (const tx of transactions) {
          if (tx.amount >= 0) continue;
          if (tx.transfer_account_id != null) continue;

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
              accumulateBucket(
                bucketMap,
                tx.date,
                input.granularity,
                absAmount,
              );
              grandTotal += absAmount;
              totalTransactionCount++;
            }
          } else {
            const catId = tx.category_id ?? "uncategorized";
            if (internalCategoryIds.has(catId)) continue;
            if (categoryIdSet && !categoryIdSet.has(catId)) continue;

            const absAmount = Math.abs(tx.amount);
            accumulateBucket(bucketMap, tx.date, input.granularity, absAmount);
            grandTotal += absAmount;
            totalTransactionCount++;
          }
        }

        // Sort buckets by key
        const sortedBuckets = [...bucketMap.values()].sort((a, b) =>
          a.key.localeCompare(b.key),
        );

        // Compute percentages and build output
        const bucketTotals = sortedBuckets.map((b) => b.total);
        const stdDev = computeStdDev(bucketTotals);
        const avgPerBucket =
          sortedBuckets.length > 0
            ? Math.round(grandTotal / sortedBuckets.length)
            : 0;

        const buckets = sortedBuckets.map((bucket) => {
          const percentage =
            grandTotal > 0
              ? Math.round((bucket.total / grandTotal) * 10000) / 100
              : 0;
          const fmt = formatBucketAmount(bucket.total, cf);
          return {
            key: bucket.key,
            label: bucket.label,
            ...fmt,
            transaction_count: bucket.count,
            percentage,
          };
        });

        // Find highest and lowest
        let highestBucket: (typeof buckets)[number] | null = null;
        let lowestBucket: (typeof buckets)[number] | null = null;
        for (const b of buckets) {
          if (!highestBucket || b.total > highestBucket.total) {
            highestBucket = b;
          }
          if (!lowestBucket || b.total < lowestBucket.total) {
            lowestBucket = b;
          }
        }

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          since_date: input.since_date,
          until_date: input.until_date ?? null,
          granularity: input.granularity,
          total_spending: milliunitsToCurrency(asMilliunits(grandTotal)),
          total_spending_display: formatCurrency(asMilliunits(grandTotal), cf),
          transaction_count: totalTransactionCount,
          bucket_count: buckets.length,
          buckets,
          insights: {
            highest_bucket: highestBucket
              ? {
                  label: highestBucket.label,
                  total_display: highestBucket.total_display,
                  percentage: highestBucket.percentage,
                }
              : null,
            lowest_bucket: lowestBucket
              ? {
                  label: lowestBucket.label,
                  total_display: lowestBucket.total_display,
                  percentage: lowestBucket.percentage,
                }
              : null,
            average_per_bucket: milliunitsToCurrency(
              asMilliunits(avgPerBucket),
            ),
            average_per_bucket_display: formatCurrency(
              asMilliunits(avgPerBucket),
              cf,
            ),
            std_deviation: milliunitsToCurrency(asMilliunits(stdDev)),
            std_deviation_display: formatCurrency(asMilliunits(stdDev), cf),
          },
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to compute spending breakdown."),
        );
      }
    },
  );
}

function accumulateBucket(
  bucketMap: Map<string, BucketAccumulator>,
  dateStr: string,
  granularity: "daily" | "weekly" | "day_of_week" | "week_of_month",
  absAmount: number,
): void {
  const { key, label } = getBucketKey(dateStr, granularity);
  const existing = bucketMap.get(key);

  if (existing) {
    existing.total += absAmount;
    existing.count++;
  } else {
    bucketMap.set(key, {
      key,
      label,
      total: absAmount,
      count: 1,
    });
  }
}
