import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { dayOfWeek, mondayOfWeek, parseDateParts } from "../shared/dates.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import { asMilliunits, milliunitsToCurrency } from "../ynab/format.js";

const timeGranularities = [
  "daily",
  "weekly",
  "day_of_week",
  "week_of_month",
] as const;
type TimeGranularity = (typeof timeGranularities)[number];

const spendingAnalysisSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  since_date: z.string().describe("Date in YYYY-MM-DD format."),
  until_date: z.string().optional().describe("Date in YYYY-MM-DD format."),
  group_by: z.enum(["category", "payee", "both"]).default("category"),
  top_n: z.number().int().min(1).max(100).default(10),
  category_ids: z.array(z.string()).optional(),
  account_ids: z.array(z.string()).optional(),
  include_transfers: z
    .boolean()
    .default(false)
    .describe(
      "Include internal account transfers in results. Defaults to false since transfers inflate spending totals.",
    ),
  time_granularity: z
    .enum(timeGranularities)
    .optional()
    .describe(
      "Also bucket the same spending over time (daily, weekly starting Monday, " +
        "day-of-week, or week-of-month) and include it as by_time in the result.",
    ),
});

interface AggregateEntry {
  id: string;
  name: string;
  total_milliunits: number;
  count: number;
}

interface TimeBucket {
  key: string;
  label: string;
  total: number;
  count: number;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function getBucketKey(
  dateStr: string,
  granularity: TimeGranularity,
): { key: string; label: string } {
  switch (granularity) {
    case "daily":
      return { key: dateStr, label: dateStr };

    case "weekly": {
      const monday = mondayOfWeek(dateStr);
      return { key: monday, label: `Week of ${monday}` };
    }

    case "day_of_week": {
      const dayIndex = dayOfWeek(dateStr);
      return {
        key: String(dayIndex),
        label: DAY_NAMES[dayIndex],
      };
    }

    case "week_of_month": {
      // Week 1 = days 1-7, Week 2 = days 8-14, etc.
      const { day } = parseDateParts(dateStr);
      const weekNum = Math.ceil(day / 7);
      return {
        key: String(weekNum),
        label: `Week ${weekNum}`,
      };
    }
  }
}

function accumulateBucket(
  bucketMap: Map<string, TimeBucket>,
  dateStr: string,
  granularity: TimeGranularity,
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

function computeStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance));
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
        "Aggregate spending over a date range and rank by category/payee for quick " +
        "insights. Optionally set time_granularity to also bucket the same spending " +
        "over time (daily, weekly, day-of-week, week-of-month) to see when money is spent.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
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
        const timeGranularity = input.time_granularity ?? null;

        const [transactions, lookups, settings] = await Promise.all([
          context.ynabClient.getTransactionsInRange(
            input.budget_id,
            input.since_date,
            input.until_date,
          ),
          context.ynabClient.getNameLookup(input.budget_id),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        const internalCategoryIds = new Set<string>();
        for (const [id, info] of lookups.categoryById) {
          if (info.group_name === "Internal Master Category") {
            internalCategoryIds.add(id);
          }
        }

        // Single-pass aggregation: filter, sum, and group without extra copies.
        let totalSpendingMilliunits = 0;
        let transactionCount = 0;
        const byCategoryMap = groupByCategory
          ? new Map<string, AggregateEntry>()
          : null;
        const byPayeeMap = groupByPayee
          ? new Map<string, AggregateEntry>()
          : null;
        const bucketMap = timeGranularity
          ? new Map<string, TimeBucket>()
          : null;

        for (const transaction of transactions) {
          if (transaction.amount >= 0) continue;
          if (
            !input.include_transfers &&
            transaction.transfer_account_id != null
          )
            continue;
          if (accountIdSet && !accountIdSet.has(transaction.account_id))
            continue;

          const activeSubs =
            transaction.subtransactions?.filter((s) => !s.deleted) ?? [];
          const isSplit = activeSubs.length > 0;

          if (isSplit) {
            const payeeId = transaction.payee_id ?? "no_payee";
            let txPayeeTotal = 0;

            for (const sub of activeSubs) {
              if (sub.amount >= 0) continue;
              const subCatId = sub.category_id ?? "uncategorized";
              if (internalCategoryIds.has(subCatId)) continue;
              if (categoryIdSet && !categoryIdSet.has(subCatId)) continue;
              if (!input.include_transfers && sub.transfer_account_id != null)
                continue;

              const absSubAmount = Math.abs(sub.amount);
              totalSpendingMilliunits += absSubAmount;
              transactionCount++;
              txPayeeTotal += absSubAmount;

              if (bucketMap && timeGranularity) {
                accumulateBucket(
                  bucketMap,
                  transaction.date,
                  timeGranularity,
                  absSubAmount,
                );
              }

              if (byCategoryMap) {
                const existing = byCategoryMap.get(subCatId);
                if (existing) {
                  existing.total_milliunits += absSubAmount;
                  existing.count++;
                } else {
                  byCategoryMap.set(subCatId, {
                    id: subCatId,
                    name: "",
                    total_milliunits: absSubAmount,
                    count: 1,
                  });
                }
              }
            }

            if (byPayeeMap && txPayeeTotal > 0) {
              const existing = byPayeeMap.get(payeeId);
              if (existing) {
                existing.total_milliunits += txPayeeTotal;
                existing.count++;
              } else {
                byPayeeMap.set(payeeId, {
                  id: payeeId,
                  name: "",
                  total_milliunits: txPayeeTotal,
                  count: 1,
                });
              }
            }
          } else {
            if (internalCategoryIds.has(transaction.category_id ?? ""))
              continue;
            if (
              categoryIdSet &&
              !categoryIdSet.has(transaction.category_id ?? "")
            )
              continue;

            const absAmount = Math.abs(transaction.amount);
            totalSpendingMilliunits += absAmount;
            transactionCount++;

            if (bucketMap && timeGranularity) {
              accumulateBucket(
                bucketMap,
                transaction.date,
                timeGranularity,
                absAmount,
              );
            }

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
        }

        const topN = input.top_n ?? 10;
        const result: Record<string, unknown> = {
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          currency: settings.currency_format?.iso_code ?? null,
          since_date: input.since_date,
          until_date: input.until_date ?? null,
          total_spending_milliunits: totalSpendingMilliunits,
          total_spending: milliunitsToCurrency(
            asMilliunits(totalSpendingMilliunits),
          ),
          transaction_count: transactionCount,
        };

        if (byCategoryMap) {
          const entries = [...byCategoryMap.values()]
            .sort((a, b) => b.total_milliunits - a.total_milliunits)
            .slice(0, topN);

          result.by_category = entries.map((entry) => {
            const catInfo = lookups.categoryById.get(entry.id);
            return {
              ...formatAggregateEntry({
                ...entry,
                name:
                  entry.id === "uncategorized"
                    ? "Uncategorized"
                    : (catInfo?.name ?? "Unknown Category"),
              }),
              category_group_id: catInfo?.group_id ?? null,
              category_group_name: catInfo?.group_name ?? null,
            };
          });
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

          result.by_payee = entries.map((entry) => formatAggregateEntry(entry));
        }

        if (bucketMap && timeGranularity) {
          result.by_time = buildTimeBuckets(
            bucketMap,
            timeGranularity,
            totalSpendingMilliunits,
          );
        }

        return jsonToolResult(result);
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to compute spending analysis."),
        );
      }
    },
  );
}

function buildTimeBuckets(
  bucketMap: Map<string, TimeBucket>,
  granularity: TimeGranularity,
  grandTotal: number,
): Record<string, unknown> {
  const sortedBuckets = [...bucketMap.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );

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
    return {
      key: bucket.key,
      label: bucket.label,
      total: milliunitsToCurrency(asMilliunits(bucket.total)),
      transaction_count: bucket.count,
      percentage,
    };
  });

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

  return {
    granularity,
    bucket_count: buckets.length,
    buckets,
    insights: {
      highest_bucket: highestBucket
        ? {
            label: highestBucket.label,
            percentage: highestBucket.percentage,
          }
        : null,
      lowest_bucket: lowestBucket
        ? {
            label: lowestBucket.label,
            percentage: lowestBucket.percentage,
          }
        : null,
      average_per_bucket: milliunitsToCurrency(asMilliunits(avgPerBucket)),
      std_deviation: milliunitsToCurrency(asMilliunits(stdDev)),
    },
  };
}

function formatAggregateEntry(entry: AggregateEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    total_milliunits: entry.total_milliunits,
    total: milliunitsToCurrency(asMilliunits(entry.total_milliunits)),
    count: entry.count,
  };
}
